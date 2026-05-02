import { createLogger } from '../../lib/logger';

interface PromptResult {
  system: string;
  user: string;
  schema: object;
}

const logger = createLogger('prompt-tech-stack');

export function buildTechStackPrompt(
  fileTree: string,
  packageJson: string,
  configFiles: { path: string; content: string }[]
): PromptResult {
  const configFilesText = configFiles
    .map((file) => `=== ${file.path} ===\n${file.content.slice(0, 2000)}`)
    .join('\n\n');

  logger.debug('tech_stack_prompt_built', {
    fileTreeLineCount: fileTree.split('\n').filter(Boolean).length,
    packageJsonLength: packageJson.length,
    configFileCount: configFiles.length,
  });

  const system = [
    'You are a careful software project analyzer for DevHub.',
    'Identify only the stack that is supported by package.json, config files, or the file tree.',
    'Prefer explicit dependency/config evidence over filename guesses, and use null when evidence is missing.',
    'Always respond with valid JSON only. No markdown, code fences, or extra text.',
  ].join(' ');

  const user = `Analyze this repository and determine its technology stack for a developer-facing dashboard.

FILE TREE:
${fileTree}

PACKAGE.JSON:
${packageJson}

CONFIG FILES:
${configFilesText || 'No config files found.'}

Return a JSON object with this exact structure:
{
  "language": "The primary programming language, such as JavaScript, TypeScript, or Python",
  "framework": "The main framework, such as Express, Next.js, React, or Fastify, or null",
  "runtime": "The runtime environment, such as Node.js, Deno, or Bun",
  "buildTool": "The build tool, such as webpack, vite, tsc, or esbuild, or null",
  "testingFramework": "The testing framework, such as jest, mocha, or vitest, or null",
  "database": "Database if detected, such as PostgreSQL, MongoDB, or SQLite, or null",
  "otherTools": ["Other notable tools or libraries detected"]
}

Rules:
- Use package.json dependencies and config files as the strongest evidence.
- Distinguish UI libraries from full app frameworks; for example React is a framework/library, Vite is a build tool, Express is a backend framework.
- Put deployment, linting, formatting, CSS, bundling, and test-adjacent tools in otherTools when they do not fit the named fields.
- Keep names concise and conventional, such as TypeScript, React, Express, Vite, Firebase, Vitest.
- If you are unsure about a nullable field, use null rather than guessing.`;

  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      language: { type: 'string' },
      framework: { type: ['string', 'null'] },
      runtime: { type: 'string' },
      buildTool: { type: ['string', 'null'] },
      testingFramework: { type: ['string', 'null'] },
      database: { type: ['string', 'null'] },
      otherTools: {
        type: 'array',
        items: { type: 'string' },
      },
    },
    required: ['language', 'framework', 'runtime', 'buildTool', 'testingFramework', 'database', 'otherTools'],
  };

  return { system, user, schema };
}
