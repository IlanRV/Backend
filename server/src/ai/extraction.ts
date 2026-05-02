import { config } from '../config';
import { getDoc, setDoc } from '../lib/firebase';
import { createLogger } from '../lib/logger';
import type { ExtractionResult, FunctionDoc, Overview, RunnabilityResult, TechStack } from '../types';
import { callOpenRouter, callOpenRouterStructured } from './openrouter';
import { buildAiReadmePrompt } from './prompts/aiReadme';
import { buildFunctionsPrompt } from './prompts/functions';
import { buildOverviewPrompt } from './prompts/overview';
import { buildTechStackPrompt } from './prompts/techStack';

export interface ExtractionFile {
  path: string;
  content: string;
}

export interface ExtractAllResult {
  analysis: ExtractionResult;
  aiReadme: string;
  runnability: RunnabilityResult;
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
const logger = createLogger('ai-extraction');
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

function buildRunnability(packageMetadata: PackageMetadata): RunnabilityResult {
  const blockers: string[] = [];
  const entryPoint = runScriptPriority.find((scriptName) => Boolean(packageMetadata.scripts[scriptName])) || null;
  const dependencies = { ...packageMetadata.dependencies, ...packageMetadata.devDependencies };
  const blockedDependencies = nativeDependencyBlocklist.filter((dependency) => Boolean(dependencies[dependency]));

  if (!packageMetadata.hasPackageJson) {
    blockers.push('No readable package.json found at repo root');
  }
  if (!entryPoint) {
    blockers.push('No runnable npm script found: expected "dev", "start", or "serve"');
  }
  if (blockedDependencies.length > 0) {
    blockers.push(`Unsupported native/runtime dependencies: ${blockedDependencies.join(', ')}`);
  }

  return {
    canRun: blockers.length === 0,
    entryPoint,
    blockers,
  };
}

function buildFallbackAiReadme(
  repoName: string,
  analysis: ExtractionResult,
  runnability: RunnabilityResult,
  title: string
): string {
  const { techStack, overview, functions, dependencies } = analysis;
  const dependencyLines = Object.entries(dependencies)
    .slice(0, 40)
    .map(([name, version]) => `- ${name}: ${version}`)
    .join('\n');

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
    '',
    '## Notable Functions',
    functions.length
      ? functions.slice(0, 20).map((functionDoc) => `- ${functionDoc.name} in ${functionDoc.file}:${functionDoc.line}`).join('\n')
      : 'No functions or classes were detected in the sampled source files.',
    '',
    '## Dependencies',
    dependencyLines || 'No package dependencies were detected.',
  ].join('\n');
}

function buildFallbackExtraction(repoName: string, files: ExtractionFile[]): ExtractAllResult {
  logger.debug('fallback_extraction_building', {
    repoName,
    fileCount: files.length,
  });
  const packageMetadata = getPackageMetadata(files);
  const dependencies = { ...packageMetadata.dependencies, ...packageMetadata.devDependencies };
  const techStack = buildFallbackTechStack(files, packageMetadata);
  const readme = extractReadme(files);
  const title = firstMarkdownHeading(readme) || packageMetadata.name || repoName;
  const summary = firstParagraph(readme) || packageMetadata.description || `${repoName} is a ${techStack.language} project.`;
  const functions = buildFallbackFunctions(files);
  const runnability = buildRunnability(packageMetadata);
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

async function repoStillExists(repoId: string): Promise<boolean> {
  const exists = Boolean(await getDoc('repos', repoId));
  logger.debug('repo_existence_checked', { repoId, exists });
  return exists;
}

export async function extractAll(
  repoId: string,
  repoName: string,
  fileTree: string,
  files: ExtractionFile[]
): Promise<ExtractAllResult> {
  const startedAt = Date.now();
  const normalizedFileTree = fileTree.trim() || files.map((file) => file.path).join('\n');
  const fallback = buildFallbackExtraction(repoName, files);
  let techStack = fallback.analysis.techStack;
  let overview = fallback.analysis.overview;
  let functions = fallback.analysis.functions;
  const dependencies = fallback.analysis.dependencies;
  const runnability = fallback.runnability;
  let aiReadme = fallback.aiReadme;
  const packageJsonFile = findPackageJson(files);
  const packageJsonText = packageJsonFile?.content || '{}';
  const packageJson = parseJsonObject(packageJsonText);
  const readme = extractReadme(files) || '';

  logger.info('extraction_started', {
    repoId,
    repoName,
    treeEntryCount: normalizedFileTree.split('\n').filter(Boolean).length,
    fileCount: files.length,
  });

  if (!hasOpenRouterKey()) {
    logger.warn('openrouter_missing_using_fallback', { repoId });
  } else {
    logger.info('extraction_step_started', { repoId, step: 'tech_stack' });
    try {
      const prompt = buildTechStackPrompt(normalizedFileTree, packageJsonText, getConfigFiles(files));
      techStack = await callOpenRouterStructured<TechStack>(prompt.user, prompt.system, prompt.schema);
      logger.info('tech_stack_detected', {
        repoId,
        language: techStack.language,
        framework: techStack.framework || 'none',
      });
    } catch (error) {
      logger.error('tech_stack_detection_failed', { repoId, error });
    }

    logger.info('extraction_step_started', { repoId, step: 'overview' });
    try {
      const prompt = buildOverviewPrompt(readme, packageJson, normalizedFileTree);
      overview = await callOpenRouterStructured<Overview>(prompt.user, prompt.system, prompt.schema);
      logger.info('overview_generated', {
        repoId,
        oneLinerLength: overview.oneLiner.length,
      });
    } catch (error) {
      logger.error('overview_generation_failed', { repoId, error });
    }

    logger.info('extraction_step_started', { repoId, step: 'functions' });
    try {
      const prompt = buildFunctionsPrompt(files);
      const aiFunctions = await callOpenRouterStructured<FunctionDoc[]>(prompt.user, prompt.system, prompt.schema);
      functions = aiFunctions.length > 0 ? aiFunctions : functions;
      logger.info('functions_documented', { repoId, functionCount: functions.length });
    } catch (error) {
      logger.error('function_documentation_failed', { repoId, error });
    }
  }

  const analysis: ExtractionResult = { techStack, overview, functions, dependencies };

  if (!(await repoStillExists(repoId))) {
    logger.warn('repo_deleted_before_partial_save', { repoId });
    return { analysis, aiReadme, runnability };
  }

  await setDoc('repos', repoId, { analysis, runnability }, { merge: true });

  if (hasOpenRouterKey()) {
    logger.info('extraction_step_started', { repoId, step: 'ai_readme' });
    try {
      const prompt = buildAiReadmePrompt(techStack, overview, functions, dependencies, repoName);
      const generatedReadme = await callOpenRouter(prompt.user, prompt.system);
      aiReadme = generatedReadme.trim() || aiReadme;
      logger.info('ai_readme_generated', { repoId, readmeLength: aiReadme.length });
    } catch (error) {
      logger.error('ai_readme_generation_failed', { repoId, error });
    }
  }

  if (!(await repoStillExists(repoId))) {
    logger.warn('repo_deleted_before_final_save', { repoId });
    return { analysis, aiReadme, runnability };
  }

  await setDoc(
    'repos',
    repoId,
    {
      status: 'ready',
      analysis,
      aiReadme,
      runnability,
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
