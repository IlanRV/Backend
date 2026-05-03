import { config } from '../config';
import { getDoc, setDoc } from '../lib/firebase';
import { createLogger } from '../lib/logger';
import type {
  AnalysisProgress,
  ExtractionResult,
  FunctionDoc,
  Overview,
  RepoRuntimeProfile,
  RepoProjectKind,
  RunnabilityBlocker,
  Repo,
  RunnabilityResult,
  RuntimeCommandConfidence,
  RuntimeCommandSuggestion,
  SecurityConfidence,
  SecurityFinding,
  SecurityScan,
  SecuritySeverity,
  TechStack,
} from '../types';
import {
  callOpenRouterStructured,
  formatOpenRouterFailure,
  isOpenRouterFailure,
} from './openrouter';
import { buildAiReadmePrompt } from './prompts/aiReadme';
import { buildFunctionPromptChunks } from './prompts/functions';
import { buildOverviewPrompt } from './prompts/overview';
import { buildSecurityPromptChunks } from './prompts/security';
import { buildTechStackPrompt } from './prompts/techStack';
import {
  aiReadmeResponseSchema,
  functionsResponseSchema,
  overviewResponseSchema,
  securityScanResponseSchema,
  techStackResponseSchema,
  type AiReadmeResponse,
} from './schemas';
import { detectExternalServiceHints, detectKnownDependencyRisks, type ExternalServiceHint } from './securityIntel';

export interface ExtractionFile {
  path: string;
  content: string;
}

export interface ExtractAllResult {
  analysis: ExtractionResult;
  aiReadme: string;
  runnability: RunnabilityResult;
}

export interface ExtractAllOptions {
  sourceHash?: string;
}

interface PackageMetadata {
  hasPackageJson: boolean;
  path?: string;
  name?: string;
  description?: string;
  main?: string;
  module?: string;
  types?: string;
  hasExports: boolean;
  bin: Record<string, string>;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  engines: {
    node?: string;
  };
  workspacePackages: WorkspacePackageMetadata[];
}

interface WorkspacePackageMetadata {
  root: string;
  name?: string;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}

const sourceExtensions = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py']);
const templateExtensions = new Set(['.ejs', '.hbs', '.handlebars', '.dust', '.html']);
const nativeDependencyBlocklist = [
  'bcrypt',
  'better-sqlite3',
  'canvas',
  'electron',
  'fibers',
  'node-gyp',
  'node-sass',
  'puppeteer',
  'sharp',
  'sqlite3',
];
const runScriptPriority = [
  'dev',
  'start',
  'serve',
  'dev:frontend',
  'start:frontend',
  'dev:web',
  'start:web',
  'dev:client',
  'start:client',
  'dev:app',
  'start:app',
  'dev:backend',
  'start:backend',
  'dev:server',
  'start:server',
] as const;
const routeScanExtensions = new Set(['.js', '.jsx', '.ts', '.tsx']);
const frontendDependencyNames = [
  'vite',
  'react',
  'react-dom',
  'next',
  'nuxt',
  'vue',
  '@vue/cli-service',
  'svelte',
  '@sveltejs/kit',
  '@vitejs/plugin-react',
];
const apiDependencyNames = ['express', 'fastify', '@nestjs/core', 'koa', 'hono'];
const cliDependencyNames = ['commander', 'yargs', 'cac', 'meow', 'clipanion'];
const directNodeEntries = ['server.js', 'src/server.js', 'index.js', 'src/index.js'];
const logger = createLogger('ai-extraction');
const securitySeverityRank: Record<SecuritySeverity | 'unknown', number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
  unknown: 0,
};
const suspiciousDependencyNames = new Set([
  'event-stream',
  'flatmap-stream',
  'node-serialize',
  'serialize-javascript',
  'ua-parser-js',
  'coa',
  'rc',
  'crypto-miner',
  'xmrig',
]);
const knownBadPackageVersions: Record<string, Record<string, {
  severity: SecuritySeverity;
  risk: string;
  reason: string;
}>> = {
  'ua-parser-js': {
    '0.7.29': {
      severity: 'high',
      risk: 'Known compromised npm release',
      reason: 'ua-parser-js 0.7.29 was one of the compromised npm releases that shipped credential-stealing and crypto-mining malware.',
    },
    '0.8.0': {
      severity: 'high',
      risk: 'Known compromised npm release',
      reason: 'ua-parser-js 0.8.0 was one of the compromised npm releases that shipped credential-stealing and crypto-mining malware.',
    },
    '1.0.0': {
      severity: 'high',
      risk: 'Known compromised npm release',
      reason: 'ua-parser-js 1.0.0 was one of the compromised npm releases that shipped credential-stealing and crypto-mining malware.',
    },
  },
  'flatmap-stream': {
    '0.1.1': {
      severity: 'high',
      risk: 'Known malicious npm release',
      reason: 'flatmap-stream 0.1.1 contained the event-stream wallet-stealing payload.',
    },
  },
  'event-stream': {
    '3.3.6': {
      severity: 'medium',
      risk: 'Associated with compromised dependency chain',
      reason: 'event-stream 3.3.6 depended on the malicious flatmap-stream release in the historical supply-chain attack.',
    },
  },
  colors: {
    '1.4.1': {
      severity: 'medium',
      risk: 'Known sabotaged npm release',
      reason: 'colors 1.4.1 is associated with the intentional infinite-loop sabotage incident.',
    },
  },
  faker: {
    '6.6.6': {
      severity: 'medium',
      risk: 'Known sabotaged npm release',
      reason: 'faker 6.6.6 is associated with the intentional infinite-loop sabotage incident.',
    },
  },
  rc: {
    '1.2.8': {
      severity: 'medium',
      risk: 'Historically compromised package version',
      reason: 'rc 1.2.8 has been associated with a compromised maintainer publish and should be verified before execution.',
    },
  },
  coa: {
    '2.0.3': {
      severity: 'medium',
      risk: 'Historically compromised package version',
      reason: 'coa 2.0.3 was part of the compromised npm account incident and should be verified before execution.',
    },
    '2.0.4': {
      severity: 'medium',
      risk: 'Historically compromised package version',
      reason: 'coa 2.0.4 was part of the compromised npm account incident and should be verified before execution.',
    },
    '2.1.1': {
      severity: 'medium',
      risk: 'Historically compromised package version',
      reason: 'coa 2.1.1 was part of the compromised npm account incident and should be verified before execution.',
    },
  },
};
const configFileMatchers = [
  'tsconfig.json',
  '.eslintrc',
  '.prettierrc',
  'vite.config',
  'webpack.config',
  'next.config',
  'tailwind.config',
  'jest.config',
  '.babelrc',
  '.env.example',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() || path;
}

function extensionOf(path: string): string {
  const lastDot = path.lastIndexOf('.');
  return lastDot === -1 ? '' : path.slice(lastDot).toLowerCase();
}

function readStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  );
}

function parseJsonObject(content: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(content) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function findPackageJson(files: ExtractionFile[]): ExtractionFile | undefined {
  const candidates = files.filter((file) => basename(file.path) === 'package.json' && !file.path.includes('node_modules/'));
  return candidates.find((file) => file.path === 'package.json') ?? candidates[0];
}

function packageRoot(path: string): string {
  return path === 'package.json' ? '' : path.replace(/\/package\.json$/i, '');
}

function getWorkspacePackages(files: ExtractionFile[]): WorkspacePackageMetadata[] {
  return files
    .filter((file) => basename(file.path) === 'package.json' && !file.path.includes('node_modules/'))
    .map((file) => {
      const parsed = parseJsonObject(file.content);
      return {
        root: packageRoot(file.path),
        name: typeof parsed.name === 'string' ? parsed.name : undefined,
        scripts: readStringRecord(parsed.scripts),
        dependencies: readStringRecord(parsed.dependencies),
        devDependencies: readStringRecord(parsed.devDependencies),
      };
    })
    .filter((pkg) => Object.keys(pkg.scripts).length || Object.keys(pkg.dependencies).length || Object.keys(pkg.devDependencies).length || pkg.name);
}

function mergeDependencyRecords(packages: WorkspacePackageMetadata[], field: 'dependencies' | 'devDependencies'): Record<string, string> {
  return packages.reduce<Record<string, string>>((merged, pkg) => ({ ...merged, ...pkg[field] }), {});
}

function getPackageMetadata(files: ExtractionFile[]): PackageMetadata {
  const packageFile = findPackageJson(files);
  const workspacePackages = getWorkspacePackages(files);

  if (!packageFile) {
    return {
      hasPackageJson: false,
      hasExports: false,
      bin: {},
      scripts: {},
      dependencies: {},
      devDependencies: {},
      engines: {},
      workspacePackages,
    };
  }

  const parsed = parseJsonObject(packageFile.content);
  const name = typeof parsed.name === 'string' ? parsed.name : undefined;
  const engines = isRecord(parsed.engines)
    ? { node: typeof parsed.engines.node === 'string' ? parsed.engines.node : undefined }
    : {};
  const bin = typeof parsed.bin === 'string' && name
    ? { [name]: parsed.bin }
    : readStringRecord(parsed.bin);

  return {
    hasPackageJson: Object.keys(parsed).length > 0,
    path: packageFile.path,
    name,
    description: typeof parsed.description === 'string' ? parsed.description : undefined,
    main: typeof parsed.main === 'string' ? parsed.main : undefined,
    module: typeof parsed.module === 'string' ? parsed.module : undefined,
    types: typeof parsed.types === 'string' ? parsed.types : undefined,
    hasExports: parsed.exports !== undefined,
    bin,
    scripts: readStringRecord(parsed.scripts),
    dependencies: mergeDependencyRecords(workspacePackages, 'dependencies'),
    devDependencies: mergeDependencyRecords(workspacePackages, 'devDependencies'),
    engines,
    workspacePackages,
  };
}

function hasDependency(dependencies: Record<string, string>, names: string[]): boolean {
  return names.some((name) => Boolean(dependencies[name]));
}

function buildFallbackTechStack(files: ExtractionFile[], packageMetadata: PackageMetadata): TechStack {
  const dependencies = { ...packageMetadata.dependencies, ...packageMetadata.devDependencies };
  const fileExtensions = new Set(files.map((file) => extensionOf(file.path)));
  const otherTools: string[] = [];

  if (hasDependency(dependencies, ['tailwindcss'])) {
    otherTools.push('Tailwind CSS');
  }
  if (hasDependency(dependencies, ['eslint'])) {
    otherTools.push('ESLint');
  }
  if (hasDependency(dependencies, ['prettier'])) {
    otherTools.push('Prettier');
  }

  return {
    language: fileExtensions.has('.ts') || fileExtensions.has('.tsx') || hasDependency(dependencies, ['typescript'])
      ? 'TypeScript'
      : fileExtensions.has('.py')
        ? 'Python'
        : 'JavaScript',
    framework: hasDependency(dependencies, ['next'])
      ? 'Next.js'
      : hasDependency(dependencies, ['react'])
        ? 'React'
        : hasDependency(dependencies, ['express'])
          ? 'Express'
          : hasDependency(dependencies, ['fastify'])
            ? 'Fastify'
            : null,
    runtime: packageMetadata.hasPackageJson ? 'Node.js' : fileExtensions.has('.py') ? 'Python' : 'Unknown',
    buildTool: hasDependency(dependencies, ['vite'])
      ? 'Vite'
      : hasDependency(dependencies, ['webpack'])
        ? 'Webpack'
        : hasDependency(dependencies, ['typescript'])
          ? 'TypeScript compiler'
          : null,
    testingFramework: hasDependency(dependencies, ['vitest'])
      ? 'Vitest'
      : hasDependency(dependencies, ['jest'])
        ? 'Jest'
        : hasDependency(dependencies, ['mocha'])
          ? 'Mocha'
          : null,
    database: hasDependency(dependencies, ['firebase-admin', 'firebase'])
      ? 'Firebase'
      : hasDependency(dependencies, ['mongoose', 'mongodb'])
        ? 'MongoDB'
        : hasDependency(dependencies, ['pg'])
          ? 'PostgreSQL'
          : hasDependency(dependencies, ['mysql2'])
            ? 'MySQL'
            : null,
    otherTools,
  };
}

function extractReadme(files: ExtractionFile[]): string | undefined {
  return files.find((file) => /^readme\.md$/i.test(basename(file.path)))?.content;
}

function firstMarkdownHeading(markdown: string | undefined): string | undefined {
  return markdown?.split('\n').find((line) => line.startsWith('# '))?.replace(/^#\s+/, '').trim();
}

function firstParagraph(markdown: string | undefined): string | undefined {
  return markdown
    ?.split(/\n\s*\n/)
    .map((section) => section.replace(/^#+\s+/gm, '').trim())
    .find((section) => section.length > 0)
    ?.slice(0, 900);
}

function buildFallbackFunctions(files: ExtractionFile[]): FunctionDoc[] {
  const docs: FunctionDoc[] = [];
  const patterns: Array<{ type: FunctionDoc['type']; regex: RegExp }> = [
    { type: 'class', regex: /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/ },
    { type: 'function', regex: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/ },
    { type: 'function', regex: /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/ },
  ];

  for (const file of files.filter((candidate) => sourceExtensions.has(extensionOf(candidate.path)))) {
    const lines = file.content.split('\n');

    lines.forEach((line, index) => {
      if (docs.length >= 80) {
        return;
      }

      for (const pattern of patterns) {
        const match = pattern.regex.exec(line);

        if (match) {
          docs.push({
            name: match[1],
            type: pattern.type,
            file: file.path,
            line: index + 1,
            signature: line.trim().slice(0, 180),
            description: `${pattern.type === 'class' ? 'Class' : 'Function'} detected in ${file.path}.`,
            params: (match[2] || '')
              .split(',')
              .map((param) => param.trim())
              .filter(Boolean)
              .map((param) => ({ name: param.split(/[:=]/)[0].trim(), type: 'unknown', description: '' })),
            returns: { type: 'unknown', description: '' },
            throws: [],
            dependencies: [],
          });
          return;
        }
      }
    });
  }

  return docs;
}

function uniquePreviewPaths(paths: string[]): string[] {
  return [...new Set(paths.map((path) => path.trim()).filter(Boolean))]
    .map((path) => (path.startsWith('/') ? path : `/${path}`))
    .filter((path) => !path.includes(':') && !path.includes('*'))
    .slice(0, 8);
}

function detectRoutePaths(content: string): string[] {
  const paths: string[] = [];
  const routeCallPattern =
    /\b(?:app|router)\s*\.\s*(?:get|post|put|patch|delete|all|use)\s*\(\s*["'`]([^"'`]+)["'`]/g;
  const routeChainPattern = /\brouter\s*\.\s*route\s*\(\s*["'`]([^"'`]+)["'`]/g;

  for (const match of content.matchAll(routeCallPattern)) {
    paths.push(match[1]);
  }

  for (const match of content.matchAll(routeChainPattern)) {
    paths.push(match[1]);
  }

  return paths;
}

function detectPreviewPaths(files: ExtractionFile[]): string[] {
  return uniquePreviewPaths(
    files
      .filter((file) => routeScanExtensions.has(extensionOf(file.path)))
      .flatMap((file) => detectRoutePaths(file.content))
  );
}

function choosePreviewPath(paths: string[]): string | undefined {
  return (
    paths.find((path) => path === '/api/health' || path === '/health') ??
    paths.find((path) => path !== '/') ??
    paths[0]
  );
}

function allDependencies(packageMetadata: PackageMetadata): Record<string, string> {
  return { ...packageMetadata.dependencies, ...packageMetadata.devDependencies };
}

function hasAnyDependency(packageMetadata: PackageMetadata, names: string[]): boolean {
  return hasDependency(allDependencies(packageMetadata), names);
}

function hasFile(files: ExtractionFile[], pattern: RegExp): boolean {
  return files.some((file) => pattern.test(file.path));
}

function hasContent(files: ExtractionFile[], pattern: RegExp): boolean {
  return files.some((file) => routeScanExtensions.has(extensionOf(file.path)) && pattern.test(file.content));
}

function isSecuritySourceCandidate(file: ExtractionFile): boolean {
  if (file.path.includes('node_modules/')) {
    return false;
  }

  const extension = extensionOf(file.path);
  return sourceExtensions.has(extension) || templateExtensions.has(extension);
}

function previewScriptName(scripts: Record<string, string>): string | null {
  return runScriptPriority.find((scriptName) => Boolean(scripts[scriptName])) || null;
}

function npmRunCommand(scriptName: string): string {
  return `npm run ${scriptName}`;
}

function isFrontendProject(packageMetadata: PackageMetadata, files: ExtractionFile[]): boolean {
  return (
    hasAnyDependency(packageMetadata, frontendDependencyNames) ||
    hasFile(files, /(^|\/)(index\.html|vite\.config\.[mc]?[jt]s|next\.config\.[mc]?[jt]s|nuxt\.config\.[jt]s|svelte\.config\.[jt]s)$/i) ||
    hasFile(files, /(^|\/)(src\/main\.[jt]sx?|src\/App\.[jt]sx?|pages\/.*\.[jt]sx?|app\/.*\.[jt]sx?)$/i) ||
    hasContent(files, /from\s+['"](?:react|vue|svelte|next\/)/)
  );
}

function isApiServerProject(packageMetadata: PackageMetadata, files: ExtractionFile[]): boolean {
  return (
    hasAnyDependency(packageMetadata, apiDependencyNames) ||
    hasContent(files, /\b(require\(['"]express['"]\)|from\s+['"]express['"]|fastify\(|new\s+Koa\(|new\s+Hono\()/) ||
    hasContent(files, /\bapp\s*\.\s*listen\s*\(|\bserver\s*\.\s*listen\s*\(/) ||
    detectPreviewPaths(files).length > 0
  );
}

function isCliProject(packageMetadata: PackageMetadata, files: ExtractionFile[]): boolean {
  return (
    Object.keys(packageMetadata.bin).length > 0 ||
    hasAnyDependency(packageMetadata, cliDependencyNames) ||
    hasFile(files, /(^|\/)(bin\/|cli\.[mc]?[jt]s$)/i) ||
    hasContent(files, /\b(Command|program)\s*\(|\byargs\s*\(|\bcac\s*\(/)
  );
}

function isLibraryProject(packageMetadata: PackageMetadata, files: ExtractionFile[]): boolean {
  const hasEntryMetadata = Boolean(packageMetadata.name && (packageMetadata.main || packageMetadata.module || packageMetadata.types || packageMetadata.hasExports));
  const hasBuildAndTest = Boolean(packageMetadata.scripts.build && packageMetadata.scripts.test);
  const sourceCount = files.filter((file) => sourceExtensions.has(extensionOf(file.path))).length;

  return hasEntryMetadata || (Boolean(packageMetadata.name) && sourceCount >= 2 && hasBuildAndTest);
}

function isTestOnlyProject(packageMetadata: PackageMetadata): boolean {
  const scriptNames = Object.keys(packageMetadata.scripts);

  if (!scriptNames.length) {
    return false;
  }

  return scriptNames.every((scriptName) => /^(pretest|test|posttest|lint|coverage|prepare|build)$/i.test(scriptName));
}

function addManualCommand(
  commands: RuntimeCommandSuggestion[],
  command: string,
  label: string,
  reason: string,
  confidence: RuntimeCommandConfidence
): void {
  if (commands.some((item) => item.command === command)) {
    return;
  }

  commands.push({ command, label, reason, confidence });
}

function addRuntimeManualCommand(
  profile: RepoRuntimeProfile,
  command: string,
  label: string,
  reason: string,
  confidence: RuntimeCommandConfidence
): RepoRuntimeProfile {
  const manualCommands = [...profile.manualCommands];
  addManualCommand(manualCommands, command, label, reason, confidence);
  return { ...profile, manualCommands };
}

function scriptLabel(scriptName: string): string {
  if (/frontend|client|web|app/i.test(scriptName)) {
    return scriptName.startsWith('start') ? 'Start frontend' : 'Run frontend';
  }
  if (/backend|server|api/i.test(scriptName)) {
    return scriptName.startsWith('start') ? 'Start backend' : 'Run backend';
  }

  return `Run ${scriptName}`;
}

function isWorkspaceRunScript(scriptName: string): boolean {
  return /^(dev|start):(frontend|client|web|app|backend|server|api)$/i.test(scriptName);
}

function obviousNodeEntry(files: ExtractionFile[]): string | null {
  const filePaths = new Set(files.map((file) => file.path));
  return directNodeEntries.find((entry) => filePaths.has(entry)) || null;
}

function buildManualCommands(packageMetadata: PackageMetadata, files: ExtractionFile[]): RuntimeCommandSuggestion[] {
  const commands: RuntimeCommandSuggestion[] = [];

  if (packageMetadata.scripts.test) {
    addManualCommand(commands, 'npm test', 'Run tests', 'The package.json test script can validate the project without opening a preview.', 'high');
  }
  if (packageMetadata.scripts.lint) {
    addManualCommand(commands, 'npm run lint', 'Run lint', 'The lint script is available as a safe manual validation command.', 'high');
  }
  if (packageMetadata.scripts.coverage) {
    addManualCommand(commands, 'npm run coverage', 'Run coverage', 'The coverage script can validate test behavior without a preview.', 'medium');
  }

  for (const scriptName of Object.keys(packageMetadata.scripts).filter(isWorkspaceRunScript)) {
    addManualCommand(
      commands,
      npmRunCommand(scriptName),
      scriptLabel(scriptName),
      'The root package exposes this npm workspace command, so it can be run manually in the BrowserPod sandbox.',
      'medium'
    );
  }

  const firstBin = Object.entries(packageMetadata.bin)[0];
  if (firstBin) {
    const [, binPath] = firstBin;
    addManualCommand(commands, `node ${binPath} --help`, 'Show CLI help', 'The package exposes a bin entry, so help output is the safest manual check.', 'medium');
  }

  const entry = obviousNodeEntry(files);
  if (entry) {
    addManualCommand(commands, `node ${entry}`, 'Run direct Node entry', 'A common Node entry file exists, but it was not promoted to auto-preview without stronger app/server evidence.', 'low');
  }

  return commands;
}

function normalizeWorkspaceReference(value: string): string {
  return value.replace(/^\.\//, '').replace(/\/$/, '');
}

function workspacePackageMatches(pkg: WorkspacePackageMetadata, value: string): boolean {
  const normalized = normalizeWorkspaceReference(value);
  return normalizeWorkspaceReference(pkg.root) === normalized || pkg.name === value;
}

function findWorkspacePackageForScript(
  packageMetadata: PackageMetadata,
  scriptName: string | null,
  command: string | undefined
): WorkspacePackageMetadata | undefined {
  if (!scriptName && !command) {
    return undefined;
  }

  const workspaceMatch = /--workspace(?:=|\s+)([^\s]+)/.exec(command ?? '');
  if (workspaceMatch) {
    return packageMetadata.workspacePackages.find((pkg) => workspacePackageMatches(pkg, workspaceMatch[1]));
  }

  const hint = `${scriptName ?? ''} ${command ?? ''}`.toLowerCase();
  if (/frontend|client|web/.test(hint)) {
    return packageMetadata.workspacePackages.find((pkg) => /frontend|client|web/.test(`${pkg.root} ${pkg.name ?? ''}`.toLowerCase()));
  }
  if (/backend|server|api/.test(hint)) {
    return packageMetadata.workspacePackages.find((pkg) => /backend|server|api/.test(`${pkg.root} ${pkg.name ?? ''}`.toLowerCase()));
  }

  return undefined;
}

function runtimeDependencies(packageMetadata: PackageMetadata, scriptName: string | null): Record<string, string> {
  const targetPackage = findWorkspacePackageForScript(
    packageMetadata,
    scriptName,
    scriptName ? packageMetadata.scripts[scriptName] : undefined
  );

  if (!targetPackage) {
    return allDependencies(packageMetadata);
  }

  return { ...targetPackage.dependencies, ...targetPackage.devDependencies };
}

function runtimeReason(kind: RepoProjectKind, evidence: string[]): string {
  if (kind === 'preview-app') {
    return 'Frontend app indicators and a preview script were found.';
  }
  if (kind === 'api-server') {
    return 'Server framework indicators and a startable script were found.';
  }
  if (kind === 'library') {
    return 'Package entry metadata points to a library package rather than a live preview app.';
  }
  if (kind === 'cli') {
    return 'CLI entry metadata was found, so manual commands are safer than a BrowserPod preview.';
  }
  if (kind === 'test-only') {
    return 'Only validation-oriented scripts were found, with no app or server preview evidence.';
  }

  return evidence.length ? 'Runtime evidence was weak or conflicting.' : 'No reliable runtime evidence was found.';
}

function buildRuntimeProfile(packageMetadata: PackageMetadata, files: ExtractionFile[]): RepoRuntimeProfile {
  const manualCommands = buildManualCommands(packageMetadata, files);
  const scriptName = previewScriptName(packageMetadata.scripts);
  const autoCommand = scriptName ? npmRunCommand(scriptName) : null;
  const frontend = isFrontendProject(packageMetadata, files);
  const apiServer = isApiServerProject(packageMetadata, files);
  const cli = isCliProject(packageMetadata, files);
  const library = !frontend && !apiServer && !cli && isLibraryProject(packageMetadata, files);
  const testOnly = isTestOnlyProject(packageMetadata) && !frontend && !apiServer && !cli && !library;
  const evidence = [
    packageMetadata.name ? `package: ${packageMetadata.name}` : '',
    packageMetadata.workspacePackages.length > 1 ? `workspace packages: ${packageMetadata.workspacePackages.length}` : '',
    scriptName ? `preview script: ${scriptName}` : '',
    frontend ? 'frontend framework or file indicators' : '',
    apiServer ? 'HTTP server or route indicators' : '',
    cli ? 'CLI bin or parser indicators' : '',
    library ? 'library entry metadata' : '',
    testOnly ? 'test/lint/coverage scripts only' : '',
  ].filter(Boolean);

  if (!packageMetadata.hasPackageJson) {
    return {
      projectKind: 'unknown',
      supportLevel: 'analysis-only',
      previewExpected: false,
      autoCommand: null,
      manualCommands,
      evidence,
      reasoning: runtimeReason('unknown', evidence),
    };
  }

  if (frontend && autoCommand) {
    return {
      projectKind: 'preview-app',
      supportLevel: 'auto-preview',
      previewExpected: true,
      autoCommand,
      manualCommands,
      evidence,
      reasoning: runtimeReason('preview-app', evidence),
    };
  }

  if (apiServer && autoCommand) {
    return {
      projectKind: 'api-server',
      supportLevel: 'auto-preview',
      previewExpected: true,
      autoCommand,
      manualCommands,
      evidence,
      reasoning: runtimeReason('api-server', evidence),
    };
  }

  if (cli) {
    return {
      projectKind: 'cli',
      supportLevel: 'manual-only',
      previewExpected: false,
      autoCommand: null,
      manualCommands,
      evidence,
      reasoning: runtimeReason('cli', evidence),
    };
  }

  if (testOnly) {
    return {
      projectKind: 'test-only',
      supportLevel: 'manual-only',
      previewExpected: false,
      autoCommand: null,
      manualCommands,
      evidence,
      reasoning: runtimeReason('test-only', evidence),
    };
  }

  if (library) {
    return {
      projectKind: 'library',
      supportLevel: 'analysis-only',
      previewExpected: false,
      autoCommand: null,
      manualCommands,
      evidence,
      reasoning: runtimeReason('library', evidence),
    };
  }

  return {
    projectKind: 'unknown',
    supportLevel: 'analysis-only',
    previewExpected: false,
    autoCommand: null,
    manualCommands,
    evidence,
    reasoning: runtimeReason('unknown', evidence),
  };
}

function buildRunnability(packageMetadata: PackageMetadata, files: ExtractionFile[]): RunnabilityResult {
  const blockers: string[] = [];
  const blockerDetails: RunnabilityBlocker[] = [];
  const entryPoint = runScriptPriority.find((scriptName) => Boolean(packageMetadata.scripts[scriptName])) || null;
  let runtimeProfile = buildRuntimeProfile(packageMetadata, files);
  const externalServices = detectExternalServiceHints(files, packageMetadata.dependencies, packageMetadata.devDependencies);
  const dependencies = runtimeDependencies(packageMetadata, entryPoint);
  const blockedDependencies = nativeDependencyBlocklist.filter((dependency) => Boolean(dependencies[dependency]));
  const previewPaths = detectPreviewPaths(files);

  if (externalServices.length > 0 && runtimeProfile.supportLevel === 'auto-preview') {
    const serviceNames = externalServices.map((hint) => hint.service).join(', ');

    if (entryPoint) {
      runtimeProfile = addRuntimeManualCommand(
        runtimeProfile,
        npmRunCommand(entryPoint),
        'Run server with external services',
        `This command may work only after required external services are available: ${serviceNames}.`,
        'medium'
      );
    }

    runtimeProfile = {
      ...runtimeProfile,
      supportLevel: 'manual-only',
      previewExpected: false,
      autoCommand: null,
      evidence: [
        ...runtimeProfile.evidence,
        ...externalServices.map((hint) => `requires ${hint.service}: ${hint.evidence}`),
      ],
      reasoning: `${runtimeProfile.reasoning} External service requirements were detected, so DevHub will not auto-start it without manual review.`,
    };
  }

  if (!packageMetadata.hasPackageJson) {
    blockers.push('No readable package.json found at repo root');
    blockerDetails.push({
      code: 'missing-package-json',
      severity: 'error',
      title: 'No package.json found',
      description:
        'DevHub could not find a readable package.json at the repository root, so it cannot infer install dependencies or npm run commands for BrowserPod.',
      recommendation:
        'Add a package.json at the project root, or send cached source files with a clear run command so DevHub can classify the project.',
    });
  }
  if (!entryPoint && (runtimeProfile.projectKind === 'unknown' || runtimeProfile.previewExpected)) {
    blockers.push('No runnable npm script found: expected "dev", "start", or "serve"');
    const availableScripts = Object.keys(packageMetadata.scripts);
    blockerDetails.push({
      code: 'missing-run-script',
      severity: 'error',
      title: 'No runnable npm script found',
      description:
        availableScripts.length > 0
          ? `No dev, start, or serve script was found. Available npm scripts are: ${availableScripts.join(', ')}.`
          : 'No dev, start, or serve script was found, so DevHub does not know which command should start a BrowserPod preview server.',
      recommendation:
        'Add a dev, start, or serve script that launches a local web server, or expose a manual command in the UI for this repository.',
      ...(availableScripts.length > 0 ? { evidence: availableScripts.join(', ') } : {}),
    });
  } else if (!entryPoint && runtimeProfile.projectKind !== 'unknown') {
    const titleByKind: Record<Exclude<RepoProjectKind, 'unknown'>, string> = {
      'preview-app': 'Preview command needs confirmation',
      'api-server': 'Server command needs confirmation',
      library: 'Library repo, no live preview expected',
      cli: 'CLI repo, manual command recommended',
      'test-only': 'Validation-only repo, no live preview expected',
    };
    const code = runtimeProfile.supportLevel === 'manual-only' ? 'manual-only-repo' : 'analysis-only-repo';
    blockerDetails.push({
      code,
      severity: runtimeProfile.supportLevel === 'manual-only' ? 'warning' : 'info',
      title: titleByKind[runtimeProfile.projectKind],
      description: runtimeProfile.reasoning,
      recommendation: runtimeProfile.manualCommands.length
        ? `Use a suggested manual command such as ${runtimeProfile.manualCommands[0].command}.`
        : 'Use DevHub analysis for this repository, or add a dev/start/serve script if it should expose a live preview.',
      evidence: runtimeProfile.evidence.join('; ') || undefined,
    });
  }
  if (blockedDependencies.length > 0) {
    blockers.push(`Unsupported native/runtime dependencies: ${blockedDependencies.join(', ')}`);
    blockerDetails.push({
      code: 'unsupported-native-dependency',
      severity: 'warning',
      title: 'Unsupported native dependency',
      description:
        'BrowserPod runs Node.js inside WebAssembly. Packages with native binaries or heavyweight runtime hooks often fail to install or execute inside the sandbox.',
      recommendation:
        'Replace these packages with WebAssembly/browser-friendly alternatives, make them optional for preview mode, or keep the repo analysis-only.',
      evidence: blockedDependencies.join(', '),
    });
  }
  if (externalServices.length > 0) {
    const serviceNames = externalServices.map((hint) => hint.service).join(', ');
    blockers.push(`External service required: ${serviceNames}`);
    blockerDetails.push({
      code: 'external-service-required',
      severity: 'warning',
      title: 'External service required',
      description:
        `This repository appears to require ${serviceNames}. DevHub BrowserPod runs the Node process, but it does not automatically start databases or other companion services.`,
      recommendation: externalServices.map((hint) => hint.recommendation).join(' '),
      evidence: externalServices.map((hint) => `${hint.service}: ${hint.evidence}`).join('; '),
    });
  }

  const result: RunnabilityResult = {
    canRun: runtimeProfile.supportLevel === 'auto-preview' && blockers.length === 0,
    entryPoint,
    autoCommand: runtimeProfile.autoCommand,
    manualCommands: runtimeProfile.manualCommands,
    runtimeProfile,
    blockers,
    blockerDetails,
  };

  if (previewPaths.length > 0) {
    result.previewPaths = previewPaths;
    result.previewPath = choosePreviewPath(previewPaths);
  }

  return result;
}

function highestSeverity(values: Array<SecuritySeverity | 'unknown'>): SecuritySeverity | 'unknown' {
  return values.reduce<SecuritySeverity | 'unknown'>((highest, value) => {
    return securitySeverityRank[value] > securitySeverityRank[highest] ? value : highest;
  }, 'unknown');
}

function securityFinding(
  title: string,
  severity: SecuritySeverity,
  category: SecurityFinding['category'],
  file: string,
  line: number | null,
  evidence: string,
  impact: string,
  recommendation: string,
  confidence: SecurityConfidence = 'medium'
): SecurityFinding {
  return {
    title,
    severity,
    category,
    file,
    line,
    evidence: evidence.slice(0, 500),
    impact,
    recommendation,
    confidence,
  };
}

function lineNumberForMatch(content: string, pattern: RegExp): number | null {
  const match = pattern.exec(content);

  if (!match || match.index === undefined) {
    return null;
  }

  return content.slice(0, match.index).split('\n').length;
}

function knownVersionRisk(packageName: string, version: string): SecurityScan['dependencyRisks'][number] | null {
  const risk = knownBadPackageVersions[packageName]?.[version];

  if (!risk) {
    return null;
  }

  return {
    packageName,
    version,
    severity: risk.severity,
    risk: risk.risk,
    reason: risk.reason,
    recommendation: 'Do not execute this exact version. Upgrade to a patched version, regenerate the lockfile, and verify the dependency source.',
    confidence: 'high',
  };
}

function lockfilePackageName(path: string): string | null {
  const marker = 'node_modules/';
  const index = path.lastIndexOf(marker);

  if (index === -1) {
    return null;
  }

  return path.slice(index + marker.length);
}

function detectPackageLockRisks(file: ExtractionFile): SecurityScan['dependencyRisks'] {
  const parsed = parseJsonObject(file.content);
  const risks: SecurityScan['dependencyRisks'] = [];

  if (isRecord(parsed.packages)) {
    for (const [path, value] of Object.entries(parsed.packages)) {
      if (!isRecord(value) || typeof value.version !== 'string') {
        continue;
      }

      const packageName = lockfilePackageName(path);
      const risk = packageName ? knownVersionRisk(packageName, value.version) : null;

      if (risk) {
        risks.push(risk);
      }
    }
  }

  if (isRecord(parsed.dependencies)) {
    for (const [packageName, value] of Object.entries(parsed.dependencies)) {
      if (!isRecord(value) || typeof value.version !== 'string') {
        continue;
      }

      const risk = knownVersionRisk(packageName, value.version);

      if (risk) {
        risks.push(risk);
      }
    }
  }

  return risks;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function detectTextLockRisks(file: ExtractionFile): SecurityScan['dependencyRisks'] {
  const risks: SecurityScan['dependencyRisks'] = [];

  for (const [packageName, versions] of Object.entries(knownBadPackageVersions)) {
    for (const version of Object.keys(versions)) {
      const escapedName = escapeRegex(packageName);
      const escapedVersion = escapeRegex(version);
      const pattern = new RegExp(`${escapedName}[^\n]{0,80}(?:version\\s+["']${escapedVersion}["']|@${escapedVersion}|version:\\s*${escapedVersion})`, 'i');
      const risk = pattern.test(file.content) ? knownVersionRisk(packageName, version) : null;

      if (risk) {
        risks.push(risk);
      }
    }
  }

  return risks;
}

function detectKnownLockfileRisks(files: ExtractionFile[]): SecurityScan['dependencyRisks'] {
  const risks = files.flatMap((file) => {
    const name = basename(file.path).toLowerCase();

    if (name === 'package-lock.json') {
      return detectPackageLockRisks(file);
    }

    if (name === 'yarn.lock' || name === 'pnpm-lock.yaml') {
      return detectTextLockRisks(file);
    }

    return [];
  });
  const unique = new Map<string, SecurityScan['dependencyRisks'][number]>();

  for (const risk of risks) {
    unique.set(`${risk.packageName}:${risk.version}`, risk);
  }

  return [...unique.values()];
}

function scoreNpmScript(scriptName: string, command: string): {
  severity: SecuritySeverity;
  confidence: SecurityConfidence;
  shouldReport: boolean;
} {
  const isLifecycleScript = /^(preinstall|install|postinstall|prepare)$/.test(scriptName);
  const isInstallLifecycle = /^(preinstall|install|postinstall)$/.test(scriptName);
  const remoteFetch = /\b(curl|wget|Invoke-WebRequest)\b/i.test(command);
  const shellPipe = /\|\s*(?:bash|sh|node|powershell)\b|\b(?:bash|sh)\s+-c\b/i.test(command);
  const credentialPath = /(?:\.ssh|\.aws|\.npmrc|\.gitconfig|id_rsa|credentials)/i.test(command);
  const destructive = /\brm\s+-rf\b|\bchmod\s+\+x\b/i.test(command);
  const childProcess = /\b(child_process|execSync|spawn\s*\(|exec\s*\(|node\s+-e)\b/i.test(command);
  const obfuscated = /\b(base64|atob|fromCharCode|eval\s*\(|Function\s*\()\b/i.test(command);
  const suspicious = remoteFetch || shellPipe || credentialPath || destructive || childProcess || obfuscated;

  if (isLifecycleScript && suspicious) {
    return {
      severity: isInstallLifecycle || remoteFetch || credentialPath || destructive ? 'high' : 'medium',
      confidence: 'medium',
      shouldReport: true,
    };
  }

  if (suspicious) {
    return { severity: 'medium', confidence: 'medium', shouldReport: true };
  }

  if (scriptName === 'prepare') {
    return { severity: 'info', confidence: 'low', shouldReport: true };
  }

  if (isInstallLifecycle) {
    return { severity: 'low', confidence: 'low', shouldReport: true };
  }

  return { severity: 'info', confidence: 'low', shouldReport: false };
}

function buildFallbackSecurityScan(files: ExtractionFile[], packageMetadata: PackageMetadata): SecurityScan {
  const findings: SecurityFinding[] = [];
  const dependencyRisks: SecurityScan['dependencyRisks'] = [];
  const packageFile = findPackageJson(files);
  const dependencyEntries = Object.entries({ ...packageMetadata.dependencies, ...packageMetadata.devDependencies });

  dependencyRisks.push(...detectKnownLockfileRisks(files));
  dependencyRisks.push(...detectKnownDependencyRisks(files));

  for (const [packageName, version] of dependencyEntries) {
    if (!suspiciousDependencyNames.has(packageName)) {
      continue;
    }

    dependencyRisks.push({
      packageName,
      version,
      severity: packageName === 'crypto-miner' || packageName === 'xmrig' ? 'high' : 'medium',
      risk: 'Dependency should be manually verified',
      reason: `${packageName} is a package name associated with historical supply-chain incidents or malware-like behavior and should be reviewed in context.`,
      recommendation: 'Confirm the package source, maintainer, lockfile integrity, and whether the dependency is still required.',
      confidence: 'low',
    });
  }

  if (packageFile) {
    for (const [scriptName, command] of Object.entries(packageMetadata.scripts)) {
      const scriptRisk = scoreNpmScript(scriptName, command);

      if (scriptRisk.shouldReport) {
        findings.push(
          securityFinding(
            `Review npm script "${scriptName}"`,
            scriptRisk.severity,
            'script',
            packageFile.path,
            lineNumberForMatch(packageFile.content, new RegExp(`"${scriptName}"\\s*:`)),
            `${scriptName}: ${command}`,
            'Install or lifecycle scripts can execute automatically during dependency installation and are a common supply-chain abuse path.',
            'Manually inspect the command, remove opaque network/shell behavior where possible, and pin trusted dependencies.',
            scriptRisk.confidence
          )
        );
      }
    }
  }

  const sourcePatterns: Array<{
    pattern: RegExp;
    title: string;
    severity: SecuritySeverity;
    category: SecurityFinding['category'];
    impact: string;
    recommendation: string;
  }> = [
    {
      pattern: /\b(eval|Function\s*\()\b/,
      title: 'Dynamic code execution detected',
      severity: 'medium',
      category: 'execution',
      impact: 'Dynamic execution can run attacker-controlled strings if input is not strictly controlled.',
      recommendation: 'Replace dynamic execution with explicit parsing or dispatch logic, or prove the input is trusted.',
    },
    {
      pattern: /\bchild_process\b|\brequire\(['"]child_process['"]\)|\bexecSync\s*\(|(?:^|[^\w$.])exec\s*\(|(?:^|[^\w$.])spawn\s*\(|\bsubprocess\b|\bos\.system\b/,
      title: 'Shell or process execution path detected',
      severity: 'medium',
      category: 'execution',
      impact: 'Process execution can become command injection or persistence if arguments include untrusted input.',
      recommendation: 'Validate arguments, avoid shell mode, and restrict commands to known-safe values.',
    },
    {
      pattern: /\b(?:find|findOne|findOneAndUpdate|updateOne|updateMany)\s*\([\s\S]{0,220}req\.body/,
      title: 'Possible NoSQL injection',
      severity: 'high',
      category: 'execution',
      impact: 'Passing request body values directly into database queries can allow query-operator injection such as $gt or $ne.',
      recommendation: 'Validate and coerce request fields to primitive values before building MongoDB/Mongoose queries.',
    },
    {
      pattern: /res\.redirect\s*\([\s\S]{0,140}(?:req\.(?:body|query|params)|redirectPage|returnTo|nextUrl)/,
      title: 'Possible open redirect',
      severity: 'medium',
      category: 'network',
      impact: 'User-controlled redirects can send users to attacker-controlled sites and aid phishing.',
      recommendation: 'Allow only relative paths or validate redirects against a strict allowlist.',
    },
    {
      pattern: /res\.render\s*\([\s\S]{0,180}req\.(?:body|query|params)/,
      title: 'Untrusted template render context',
      severity: 'high',
      category: 'execution',
      impact: 'Passing untrusted request objects directly into templates can expose path traversal, local file inclusion, or template injection paths.',
      recommendation: 'Pass an explicit allowlisted view model to templates instead of raw request data.',
    },
    {
      pattern: /session\s*\(\s*\{[\s\S]{0,360}\bsecret\s*:\s*['"][^'"]+['"]/,
      title: 'Hardcoded session secret',
      severity: 'high',
      category: 'secret',
      impact: 'Hardcoded session secrets can allow cookie forgery if the source code or package is exposed.',
      recommendation: 'Load session secrets from environment-backed secret storage and rotate exposed values.',
    },
    {
      pattern: /<%-[\s\S]{0,160}%>/,
      title: 'Raw template output detected',
      severity: 'medium',
      category: 'execution',
      impact: 'Raw template output can create XSS when the rendered value is user-controlled.',
      recommendation: 'Use escaped template output by default and sanitize any intentional HTML.',
    },
    {
      pattern: /\b(Buffer\.from|atob|fromCharCode|base64)\b[\s\S]{0,240}\b(eval|Function\s*\(|exec\s*\()\b/,
      title: 'Encoded payload near execution sink',
      severity: 'high',
      category: 'obfuscation',
      impact: 'Encoded content passed toward execution is a common malware and loader pattern.',
      recommendation: 'Decode and review the payload, remove obfuscation, and confirm it is not fetched or assembled from untrusted input.',
    },
    {
      pattern: /\b(SECRET|TOKEN|PRIVATE_KEY|PASSWORD|API_KEY)\b\s*[:=]\s*['"][^'"]{12,}/,
      title: 'Possible committed secret',
      severity: 'high',
      category: 'secret',
      impact: 'Committed credentials can be reused by attackers and may need immediate rotation.',
      recommendation: 'Move secrets to environment storage, rotate exposed credentials, and remove them from git history if confirmed.',
    },
  ];

  for (const file of files) {
    if (!isSecuritySourceCandidate(file)) {
      continue;
    }

    for (const pattern of sourcePatterns) {
      const line = lineNumberForMatch(file.content, pattern.pattern);

      if (!line) {
        continue;
      }

      const evidenceLine = file.content.split('\n')[line - 1]?.trim() || pattern.title;
      findings.push(
        securityFinding(
          pattern.title,
          pattern.severity,
          pattern.category,
          file.path,
          line,
          evidenceLine,
          pattern.impact,
          pattern.recommendation,
          'medium'
        )
      );
    }
  }

  const uniqueDependencyRisks = new Map<string, SecurityScan['dependencyRisks'][number]>();

  for (const risk of dependencyRisks) {
    uniqueDependencyRisks.set(`${risk.packageName}:${risk.version}:${risk.risk}`, risk);
  }

  const dedupedDependencyRisks = [...uniqueDependencyRisks.values()];
  const riskLevel = highestSeverity([...findings.map((finding) => finding.severity), ...dedupedDependencyRisks.map((risk) => risk.severity)]);

  return {
    riskLevel: riskLevel === 'unknown' ? 'low' : riskLevel,
    summary:
      findings.length || dependencyRisks.length
        ? `Local scan found ${findings.length} code/script findings and ${dedupedDependencyRisks.length} dependency items that need review.`
        : 'No obvious malicious package, install-script, secret, execution, or obfuscation indicators were found in the sampled files. This is not a full malware scan.',
    findings: findings.slice(0, 80),
      dependencyRisks: dedupedDependencyRisks.slice(0, 60),
    scannedFiles: files.map((file) => file.path).slice(0, 120),
    notes: ['Security scan is evidence-based on files sent to extraction and should be paired with dependency audit tooling before release.'],
  };
}

function buildRunGuidance(runnability: RunnabilityResult): string {
  const profile = runnability.runtimeProfile;
  const manualLines = runnability.manualCommands?.length
    ? [
        'Suggested manual commands:',
        ...runnability.manualCommands.map((command) => `- \`${command.command}\` - ${command.reason}`),
      ]
    : [];

  if (profile?.previewExpected && profile.autoCommand) {
    return [`Run in BrowserPod with: \`${profile.autoCommand}\`.`, ...manualLines].join('\n');
  }

  if (profile?.projectKind === 'library') {
    return ['This is a library, not a live preview app.', ...manualLines].join('\n');
  }

  if (profile?.projectKind === 'cli') {
    return ['This is a CLI/tooling repo, not a preview app.', ...manualLines].join('\n');
  }

  if (profile?.projectKind === 'test-only') {
    return ['This repository is validation-oriented and does not expose a live preview app.', ...manualLines].join('\n');
  }

  if (profile?.projectKind === 'unknown') {
    return ['No reliable preview command could be inferred.', ...manualLines].join('\n');
  }

  if (runnability.canRun && runnability.entryPoint) {
    return `Run with \`npm run ${runnability.entryPoint}\`.`;
  }

  return `Not automatically runnable: ${runnability.blockers.join('; ') || 'No BrowserPod preview command found.'}`;
}

function buildFallbackAiReadme(
  repoName: string,
  analysis: ExtractionResult,
  runnability: RunnabilityResult,
  title: string
): string {
  const { techStack, overview, functions, dependencies, security } = analysis;
  const dependencyLines = Object.entries(dependencies)
    .slice(0, 40)
    .map(([name, version]) => `- ${name}: ${version}`)
    .join('\n');
  const blockerDetailLines = runnability.blockerDetails?.length
    ? runnability.blockerDetails
        .map((blocker) => `- ${blocker.title}: ${blocker.description} Recommendation: ${blocker.recommendation}`)
        .join('\n')
    : '';
  const runGuidance = buildRunGuidance(runnability);

  return [
    `# ${title || repoName}`,
    '',
    '## Overview',
    overview.summary,
    '',
    '## Tech Stack',
    `- Language: ${techStack.language}`,
    `- Framework: ${techStack.framework || 'None detected'}`,
    `- Runtime: ${techStack.runtime}`,
    `- Build tool: ${techStack.buildTool || 'None detected'}`,
    `- Testing: ${techStack.testingFramework || 'None detected'}`,
    `- Database: ${techStack.database || 'None detected'}`,
    '',
    '## Run',
    runGuidance,
    blockerDetailLines,
    '',
    '## Notable Functions',
    functions.length
      ? functions.slice(0, 20).map((functionDoc) => `- ${functionDoc.name} in ${functionDoc.file}:${functionDoc.line}`).join('\n')
      : 'No functions or classes were detected in the sampled source files.',
    '',
    '## Dependencies',
    dependencyLines || 'No package dependencies were detected.',
    '',
    '## Security Notes',
    `- Overall risk: ${security.riskLevel}`,
    `- ${security.summary}`,
    ...security.findings.slice(0, 10).map(
      (finding) => `- ${finding.severity.toUpperCase()}: ${finding.title} (${finding.file}${finding.line ? `:${finding.line}` : ''})`
    ),
  ].join('\n');
}

function buildFallbackExtraction(repoName: string, files: ExtractionFile[]): ExtractAllResult {
  const packageMetadata = getPackageMetadata(files);
  const dependencies = { ...packageMetadata.dependencies, ...packageMetadata.devDependencies };
  const techStack = buildFallbackTechStack(files, packageMetadata);
  const readme = extractReadme(files);
  const title = firstMarkdownHeading(readme) || packageMetadata.name || repoName;
  const summary = firstParagraph(readme) || packageMetadata.description || `${repoName} is a ${techStack.language} project.`;
  const functions = buildFallbackFunctions(files);
  const runnability = buildRunnability(packageMetadata, files);
  const security = buildFallbackSecurityScan(files, packageMetadata);
  const analysis: ExtractionResult = {
    techStack,
    overview: {
      oneLiner: packageMetadata.description || `${title} codebase overview`,
      summary,
      purpose: packageMetadata.description || `Maintain and understand ${title}.`,
      targetUsers: 'Developers working with this repository',
    },
    functions,
    dependencies,
    security,
  };

  return {
    analysis,
    aiReadme: buildFallbackAiReadme(repoName, analysis, runnability, title),
    runnability,
  };
}

function getConfigFiles(files: ExtractionFile[]): ExtractionFile[] {
  return files.filter((file) => {
    const name = file.path.toLowerCase();
    return !name.includes('node_modules/') && configFileMatchers.some((matcher) => name.includes(matcher));
  });
}

function hasOpenRouterKey(): boolean {
  return config.openrouter.apiKey.trim().length > 0;
}

function createAnalysisProgress(
  phase: AnalysisProgress['phase'],
  percent: number,
  message: string
): AnalysisProgress {
  return {
    phase,
    percent: Math.max(0, Math.min(100, Math.round(percent))),
    message,
    updatedAt: new Date().toISOString(),
  };
}

async function repoStillExists(repoId: string): Promise<boolean> {
  return Boolean(await getDoc('repos', repoId));
}

async function updateExtractionProgress(
  repoId: string,
  phase: AnalysisProgress['phase'],
  percent: number,
  message: string
): Promise<void> {
  if (!(await repoStillExists(repoId))) {
    return;
  }

  const analysisProgress = createAnalysisProgress(phase, percent, message);
  await setDoc(
    'repos',
    repoId,
    {
      analysisProgress,
      updatedAt: analysisProgress.updatedAt,
    },
    { merge: true }
  );
}

function describeAiStepFailure(step: string, error: unknown): string {
  if (isOpenRouterFailure(error)) {
    const reason = formatOpenRouterFailure(error);
    logger.warn('ai_step_unavailable_using_fallback', { step, reason });
    return reason;
  }

  logger.error('ai_step_failed_using_fallback', { step, error });
  return `${step} failed after validation or parsing; using local fallback data for this extraction.`;
}

function normalizeFunctionDocKey(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function functionDocKey(functionDoc: FunctionDoc): string {
  return [
    normalizeFunctionDocKey(functionDoc.file),
    normalizeFunctionDocKey(functionDoc.name),
    normalizeFunctionDocKey(functionDoc.signature),
  ].join(':');
}

function functionDocQuality(functionDoc: FunctionDoc): number {
  return (
    functionDoc.description.length +
    functionDoc.signature.length +
    functionDoc.params.length * 20 +
    functionDoc.throws.length * 10 +
    functionDoc.dependencies.length * 10
  );
}

function mergeFunctionDocs(primaryDocs: FunctionDoc[], fallbackDocs: FunctionDoc[], limit = 160): FunctionDoc[] {
  const docsByKey = new Map<string, FunctionDoc>();

  for (const functionDoc of [...primaryDocs, ...fallbackDocs]) {
    const key = functionDocKey(functionDoc);
    const existing = docsByKey.get(key);

    if (!existing || functionDocQuality(functionDoc) > functionDocQuality(existing)) {
      docsByKey.set(key, functionDoc);
    }
  }

  return [...docsByKey.values()]
    .sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line || left.name.localeCompare(right.name))
    .slice(0, limit);
}

function securityFindingKey(finding: SecurityFinding): string {
  return [
    finding.category,
    normalizeFunctionDocKey(finding.file),
    finding.line ?? 'none',
    normalizeFunctionDocKey(finding.title),
    normalizeFunctionDocKey(finding.evidence.slice(0, 120)),
  ].join(':');
}

function mergeSecurityScans(scans: SecurityScan[], fallback: SecurityScan): SecurityScan {
  const findingsByKey = new Map<string, SecurityFinding>();
  const dependencyRisksByKey = new Map<string, SecurityScan['dependencyRisks'][number]>();
  const scannedFiles = new Set<string>();
  const notes = new Set<string>();

  for (const scan of [...scans, fallback]) {
    scan.scannedFiles.forEach((file) => scannedFiles.add(file));
    scan.notes.forEach((note) => notes.add(note));

    for (const finding of scan.findings) {
      const key = securityFindingKey(finding);
      const existing = findingsByKey.get(key);

      if (!existing || securitySeverityRank[finding.severity] > securitySeverityRank[existing.severity]) {
        findingsByKey.set(key, finding);
      }
    }

    for (const risk of scan.dependencyRisks) {
      const key = `${risk.packageName}:${risk.version ?? 'unknown'}:${risk.risk}`.toLowerCase();
      const existing = dependencyRisksByKey.get(key);

      if (!existing || securitySeverityRank[risk.severity] > securitySeverityRank[existing.severity]) {
        dependencyRisksByKey.set(key, risk);
      }
    }
  }

  const findings = [...findingsByKey.values()]
    .sort((left, right) => securitySeverityRank[right.severity] - securitySeverityRank[left.severity] || left.file.localeCompare(right.file))
    .slice(0, 80);
  const dependencyRisks = [...dependencyRisksByKey.values()]
    .sort((left, right) => securitySeverityRank[right.severity] - securitySeverityRank[left.severity] || left.packageName.localeCompare(right.packageName))
    .slice(0, 60);
  const riskLevel = highestSeverity([...findings.map((finding) => finding.severity), ...dependencyRisks.map((risk) => risk.severity)]);
  const aiSummary = scans.find((scan) => scan.summary.trim().length > 0)?.summary;

  return {
    riskLevel: riskLevel === 'unknown' ? fallback.riskLevel : riskLevel,
    summary:
      aiSummary ||
      (findings.length || dependencyRisks.length
        ? `Security scan found ${findings.length} code/config findings and ${dependencyRisks.length} dependency risks.`
        : fallback.summary),
    findings,
    dependencyRisks,
    scannedFiles: [...scannedFiles].slice(0, 120),
    notes: [...notes].slice(0, 20),
  };
}

export async function extractAll(
  repoId: string,
  repoName: string,
  fileTree: string,
  files: ExtractionFile[],
  options: ExtractAllOptions = {}
): Promise<ExtractAllResult> {
  const startedAt = Date.now();
  const normalizedFileTree = fileTree.trim() || files.map((file) => file.path).join('\n');
  const fallback = buildFallbackExtraction(repoName, files);
  let techStack = fallback.analysis.techStack;
  let overview = fallback.analysis.overview;
  let functions = fallback.analysis.functions;
  let security = fallback.analysis.security;
  const dependencies = fallback.analysis.dependencies;
  const runnability = fallback.runnability;
  let aiReadme = fallback.aiReadme;
  const packageJsonFile = findPackageJson(files);
  const packageJsonText = packageJsonFile?.content || '{}';
  const packageJson = parseJsonObject(packageJsonText);
  const readme = extractReadme(files) || '';
  let aiUnavailableReason: string | null = null;

  logger.info('extraction_started', {
    repoId,
    repoName,
    treeEntryCount: normalizedFileTree.split('\n').filter(Boolean).length,
    fileCount: files.length,
  });

  await updateExtractionProgress(repoId, 'scanning', 18, 'Scanning source files');

  if (!hasOpenRouterKey()) {
    logger.warn('openrouter_missing_using_fallback', { repoId });
  } else {
    await updateExtractionProgress(repoId, 'querying', 35, 'Querying tech stack, overview, functions, and security');

    const [techStackResult, overviewResult, functionsResult, securityResult] = await Promise.allSettled([
      (async () => {
        const prompt = buildTechStackPrompt(normalizedFileTree, packageJsonText, getConfigFiles(files));
        return callOpenRouterStructured<TechStack>(
          prompt.user,
          prompt.system,
          prompt.schema,
          techStackResponseSchema
        );
      })(),
      (async () => {
        const prompt = buildOverviewPrompt(readme, packageJson, normalizedFileTree);
        return callOpenRouterStructured<Overview>(
          prompt.user,
          prompt.system,
          prompt.schema,
          overviewResponseSchema
        );
      })(),
      (async () => {
        const promptChunks = buildFunctionPromptChunks(files);
        const chunkResults = await Promise.allSettled(
          promptChunks.map(async (prompt) => {
            return callOpenRouterStructured<FunctionDoc[]>(
              prompt.user,
              prompt.system,
              prompt.schema,
              functionsResponseSchema,
              { maxTokens: Math.min(config.openrouter.maxTokens, 4096) }
            );
          })
        );

        const chunkFunctions = chunkResults.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
        const failedChunks = chunkResults.filter(
          (result): result is PromiseRejectedResult => result.status === 'rejected'
        );

        if (failedChunks.length === chunkResults.length && failedChunks.length > 0) {
          throw failedChunks[0].reason;
        }

        if (failedChunks.length > 0) {
          logger.warn('function_chunks_partially_failed_using_partial_results', {
            repoId,
            failedChunkCount: failedChunks.length,
            fulfilledChunkCount: chunkResults.length - failedChunks.length,
          });
        }

        return chunkFunctions;
      })(),
      (async () => {
        const promptChunks = buildSecurityPromptChunks(files);
        const chunkResults = await Promise.allSettled(
          promptChunks.map(async (prompt) => {
            return callOpenRouterStructured<SecurityScan>(
              prompt.user,
              prompt.system,
              prompt.schema,
              securityScanResponseSchema,
              { maxTokens: Math.min(config.openrouter.maxTokens, 4096) }
            );
          })
        );

        const fulfilledScans = chunkResults.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
        const failedChunks = chunkResults.filter(
          (result): result is PromiseRejectedResult => result.status === 'rejected'
        );

        if (failedChunks.length === chunkResults.length && failedChunks.length > 0) {
          throw failedChunks[0].reason;
        }

        if (failedChunks.length > 0) {
          logger.warn('security_chunks_partially_failed_using_partial_results', {
            repoId,
            failedChunkCount: failedChunks.length,
            fulfilledChunkCount: chunkResults.length - failedChunks.length,
          });
        }

        return mergeSecurityScans(fulfilledScans, fallback.analysis.security);
      })(),
    ]);

    if (techStackResult.status === 'fulfilled') {
      techStack = techStackResult.value;
    } else {
      aiUnavailableReason ||= describeAiStepFailure('Tech stack detection', techStackResult.reason);
    }

    if (overviewResult.status === 'fulfilled') {
      overview = overviewResult.value;
    } else {
      aiUnavailableReason ||= describeAiStepFailure('Overview generation', overviewResult.reason);
    }

    if (functionsResult.status === 'fulfilled' && functionsResult.value.length > 0) {
      functions = mergeFunctionDocs(functionsResult.value, functions);
    } else if (functionsResult.status === 'rejected') {
      aiUnavailableReason ||= describeAiStepFailure('Function documentation', functionsResult.reason);
    }

    if (securityResult.status === 'fulfilled') {
      security = securityResult.value;
    } else {
      aiUnavailableReason ||= describeAiStepFailure('Security scanning', securityResult.reason);
    }

    await updateExtractionProgress(repoId, 'saving', 72, 'Merging extraction results');
  }

  const analysis: ExtractionResult = { techStack, overview, functions, dependencies, security };

  if (!(await repoStillExists(repoId))) {
    logger.warn('repo_deleted_before_partial_save', { repoId });
    return { analysis, aiReadme, runnability };
  }

  const analysisMetadata = {
    ...(options.sourceHash ? { analysisSourceHash: options.sourceHash } : {}),
    analysisModel: hasOpenRouterKey() ? config.openrouter.model : null,
    analysisUpdatedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const partialProgress = createAnalysisProgress('saving', 78, 'Saving extracted analysis');

  await setDoc(
    'repos',
    repoId,
    {
      analysis,
      runnability,
      runnable: runnability.canRun,
      runScript: runnability.entryPoint,
      analysisProgress: partialProgress,
      aiReadmeStatus: 'pending' satisfies NonNullable<Repo['aiReadmeStatus']>,
      ...analysisMetadata,
    },
    { merge: true }
  );

  if (hasOpenRouterKey()) {
    if (aiUnavailableReason) {
      logger.warn('ai_readme_generating_after_partial_ai_failure', { repoId, reason: aiUnavailableReason });
    }

    await updateExtractionProgress(repoId, 'readme', 86, 'Generating AI README');
    try {
      const prompt = buildAiReadmePrompt(
        techStack,
        overview,
        functions,
        dependencies,
        repoName,
        runnability,
        security,
        normalizedFileTree,
        readme
      );
      const generatedReadme = await callOpenRouterStructured<AiReadmeResponse>(
        prompt.user,
        prompt.system,
        prompt.schema,
        aiReadmeResponseSchema
      );
      aiReadme = generatedReadme.markdown.trim() || aiReadme;
      await updateExtractionProgress(repoId, 'readme', 94, 'Saving AI README');
    } catch (error) {
      aiUnavailableReason = describeAiStepFailure('AI README generation', error);
    }
  }

  if (!(await repoStillExists(repoId))) {
    logger.warn('repo_deleted_before_final_save', { repoId });
    return { analysis, aiReadme, runnability };
  }

  const completeProgress = createAnalysisProgress('complete', 100, 'Extraction complete');

  await setDoc(
    'repos',
    repoId,
    {
      status: 'ready',
      analysis,
      aiReadme,
      aiReadmeStatus: aiReadme ? 'ready' : 'error',
      runnability,
      runnable: runnability.canRun,
      runScript: runnability.entryPoint,
      analysisError: null,
      analysisProgress: completeProgress,
      ...analysisMetadata,
    },
    { merge: true }
  );

  logger.info('extraction_completed', {
    repoId,
    durationMs: Date.now() - startedAt,
    functionCount: functions.length,
    canRun: runnability.canRun,
  });
  return { analysis, aiReadme, runnability };
}
