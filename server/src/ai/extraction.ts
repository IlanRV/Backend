import { config } from '../config';
import { getDoc, setDoc } from '../lib/firebase';
import { createLogger } from '../lib/logger';
import type {
  AnalysisProgress,
  ExtractionResult,
  FunctionDoc,
  Overview,
  RunnabilityBlocker,
  Repo,
  RunnabilityResult,
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
  name?: string;
  description?: string;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  engines: {
    node?: string;
  };
}

const sourceExtensions = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py']);
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
const runScriptPriority = ['dev', 'start', 'serve'] as const;
const routeScanExtensions = new Set(['.js', '.jsx', '.ts', '.tsx']);
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
  return files.find((file) => basename(file.path) === 'package.json' && !file.path.includes('node_modules/'));
}

function getPackageMetadata(files: ExtractionFile[]): PackageMetadata {
  const packageFile = findPackageJson(files);

  if (!packageFile) {
    return {
      hasPackageJson: false,
      scripts: {},
      dependencies: {},
      devDependencies: {},
      engines: {},
    };
  }

  const parsed = parseJsonObject(packageFile.content);
  const engines = isRecord(parsed.engines)
    ? { node: typeof parsed.engines.node === 'string' ? parsed.engines.node : undefined }
    : {};

  return {
    hasPackageJson: Object.keys(parsed).length > 0,
    name: typeof parsed.name === 'string' ? parsed.name : undefined,
    description: typeof parsed.description === 'string' ? parsed.description : undefined,
    scripts: readStringRecord(parsed.scripts),
    dependencies: readStringRecord(parsed.dependencies),
    devDependencies: readStringRecord(parsed.devDependencies),
    engines,
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

function buildRunnability(packageMetadata: PackageMetadata, files: ExtractionFile[]): RunnabilityResult {
  const blockers: string[] = [];
  const blockerDetails: RunnabilityBlocker[] = [];
  const entryPoint = runScriptPriority.find((scriptName) => Boolean(packageMetadata.scripts[scriptName])) || null;
  const dependencies = { ...packageMetadata.dependencies, ...packageMetadata.devDependencies };
  const blockedDependencies = nativeDependencyBlocklist.filter((dependency) => Boolean(dependencies[dependency]));
  const previewPaths = detectPreviewPaths(files);

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
  if (!entryPoint) {
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

  const result: RunnabilityResult = {
    canRun: blockers.length === 0,
    entryPoint,
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

function buildFallbackSecurityScan(files: ExtractionFile[], packageMetadata: PackageMetadata): SecurityScan {
  const findings: SecurityFinding[] = [];
  const dependencyRisks: SecurityScan['dependencyRisks'] = [];
  const packageFile = findPackageJson(files);
  const dependencyEntries = Object.entries({ ...packageMetadata.dependencies, ...packageMetadata.devDependencies });

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
      const isLifecycleScript = /^(preinstall|install|postinstall|prepare)$/.test(scriptName);
      const suspiciousCommandPattern = /\b(curl|wget|Invoke-WebRequest|powershell|bash\s+-c|sh\s+-c|node\s+-e|chmod|rm\s+-rf|nc\s+-|netcat|base64)\b/i;

      if (isLifecycleScript || suspiciousCommandPattern.test(command)) {
        findings.push(
          securityFinding(
            `Review npm script "${scriptName}"`,
            isLifecycleScript && suspiciousCommandPattern.test(command) ? 'high' : 'medium',
            'script',
            packageFile.path,
            lineNumberForMatch(packageFile.content, new RegExp(`"${scriptName}"\\s*:`)),
            `${scriptName}: ${command}`,
            'Install or lifecycle scripts can execute automatically during dependency installation and are a common supply-chain abuse path.',
            'Manually inspect the command, remove opaque network/shell behavior where possible, and pin trusted dependencies.',
            isLifecycleScript && suspiciousCommandPattern.test(command) ? 'medium' : 'low'
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
      pattern: /\b(child_process|execSync|exec\s*\(|spawn\s*\(|subprocess|os\.system)\b/,
      title: 'Shell or process execution path detected',
      severity: 'medium',
      category: 'execution',
      impact: 'Process execution can become command injection or persistence if arguments include untrusted input.',
      recommendation: 'Validate arguments, avoid shell mode, and restrict commands to known-safe values.',
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
    if (file.path.includes('node_modules/')) {
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

  const riskLevel = highestSeverity([...findings.map((finding) => finding.severity), ...dependencyRisks.map((risk) => risk.severity)]);

  return {
    riskLevel: riskLevel === 'unknown' ? 'low' : riskLevel,
    summary:
      findings.length || dependencyRisks.length
        ? `Local scan found ${findings.length} code/script findings and ${dependencyRisks.length} dependency items that need review.`
        : 'No obvious malicious package, install-script, secret, execution, or obfuscation indicators were found in the sampled files. This is not a full malware scan.',
    findings: findings.slice(0, 80),
    dependencyRisks: dependencyRisks.slice(0, 60),
    scannedFiles: files.map((file) => file.path).slice(0, 120),
    notes: ['Security scan is evidence-based on files sent to extraction and should be paired with dependency audit tooling before release.'],
  };
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
    runnability.canRun && runnability.entryPoint
      ? `Run with \`npm run ${runnability.entryPoint}\`.`
      : `Not automatically runnable: ${runnability.blockers.join('; ')}`,
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
