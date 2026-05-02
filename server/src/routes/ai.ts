import { Router } from 'express';
import { getDoc, setDoc } from '../lib/firebase';
import { asyncHandler, createHttpError, getRouteParam } from '../lib/http';
import { ExtractionResult, FunctionDoc, Repo, RunnabilityResult, TechStack } from '../types';

const router = Router();

interface ExtractionFile {
  path: string;
  content: string;
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

const sourceExtensions = new Set(['.js', '.jsx', '.ts', '.tsx', '.py']);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isExtractionFile(value: unknown): value is ExtractionFile {
  return isRecord(value) && typeof value.path === 'string' && typeof value.content === 'string';
}

function getRequestFiles(body: unknown): ExtractionFile[] {
  if (!isRecord(body) || !Array.isArray(body.files)) {
    throw createHttpError(400, 'files must be an array of { path, content } objects');
  }

  const files = body.files.filter(isExtractionFile).filter((file) => file.path.trim().length > 0);

  if (files.length === 0) {
    throw createHttpError(400, 'At least one source file is required for extraction');
  }

  return files;
}

function extensionOf(path: string): string {
  const lastDot = path.lastIndexOf('.');
  return lastDot === -1 ? '' : path.slice(lastDot).toLowerCase();
}

function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() || path;
}

function readStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  );
}

function getPackageMetadata(files: ExtractionFile[]): PackageMetadata {
  const packageFile = files.find((file) => basename(file.path) === 'package.json');

  if (!packageFile) {
    return {
      hasPackageJson: false,
      scripts: {},
      dependencies: {},
      devDependencies: {},
      engines: {},
    };
  }

  try {
    const parsed = JSON.parse(packageFile.content) as unknown;

    if (!isRecord(parsed)) {
      throw new Error('package.json is not an object');
    }

    const engines = isRecord(parsed.engines)
      ? { node: typeof parsed.engines.node === 'string' ? parsed.engines.node : undefined }
      : {};

    return {
      hasPackageJson: true,
      name: typeof parsed.name === 'string' ? parsed.name : undefined,
      description: typeof parsed.description === 'string' ? parsed.description : undefined,
      scripts: readStringRecord(parsed.scripts),
      dependencies: readStringRecord(parsed.dependencies),
      devDependencies: readStringRecord(parsed.devDependencies),
      engines,
    };
  } catch {
    return {
      hasPackageJson: false,
      scripts: {},
      dependencies: {},
      devDependencies: {},
      engines: {},
    };
  }
}

function hasDependency(dependencies: Record<string, string>, names: string[]): boolean {
  return names.some((name) => Boolean(dependencies[name]));
}

function buildTechStack(files: ExtractionFile[], packageMetadata: PackageMetadata): TechStack {
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

function buildFunctions(files: ExtractionFile[]): FunctionDoc[] {
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

function buildAnalysis(repo: Repo, files: ExtractionFile[]): { analysis: ExtractionResult; aiReadme: string; runnability: RunnabilityResult } {
  const packageMetadata = getPackageMetadata(files);
  const dependencies = { ...packageMetadata.dependencies, ...packageMetadata.devDependencies };
  const techStack = buildTechStack(files, packageMetadata);
  const readme = extractReadme(files);
  const title = firstMarkdownHeading(readme) || packageMetadata.name || repo.name;
  const summary = firstParagraph(readme) || packageMetadata.description || `${repo.name} is a ${techStack.language} project.`;
  const functions = buildFunctions(files);
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
  const aiReadme = [
    `# ${title}`,
    '',
    '## Summary',
    summary,
    '',
    '## Tech Stack',
    `- Language: ${techStack.language}`,
    `- Framework: ${techStack.framework || 'None detected'}`,
    `- Runtime: ${techStack.runtime}`,
    `- Build tool: ${techStack.buildTool || 'None detected'}`,
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
  ].join('\n');

  return { analysis, aiReadme, runnability };
}

router.post(
  '/extract/:repoId',
  asyncHandler(async (req, res) => {
    const repoId = getRouteParam(req, 'repoId');
    const repo = await getDoc<Repo>('repos', repoId);

    if (!repo) {
      throw createHttpError(404, 'Repo not found');
    }

    const files = getRequestFiles(req.body);
    await setDoc('repos', repo.repoId, { status: 'analyzing' satisfies Repo['status'] }, { merge: true });

    try {
      const { analysis, aiReadme, runnability } = buildAnalysis(repo, files);
      await setDoc(
        'repos',
        repo.repoId,
        {
          status: 'ready' satisfies Repo['status'],
          analysis,
          aiReadme,
          runnability,
        },
        { merge: true }
      );

      res.json({ analysis, aiReadme });
    } catch (error) {
      await setDoc('repos', repo.repoId, { status: 'error' satisfies Repo['status'] }, { merge: true });
      throw error;
    }
  })
);

router.get(
  '/extract/:repoId',
  asyncHandler(async (req, res) => {
    const repoId = getRouteParam(req, 'repoId');
    const repo = await getDoc<Repo>('repos', repoId);

    if (!repo) {
      throw createHttpError(404, 'Repo not found');
    }
    if (!repo.analysis) {
      throw createHttpError(404, 'No cached extraction found for this repo');
    }

    res.json({ ...repo.analysis, aiReadme: repo.aiReadme });
  })
);

export default router;