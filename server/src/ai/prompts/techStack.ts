interface PromptResult {
  system: string;
  user: string;
  schema: object;
}

export function buildTechStackPrompt(
  fileTree: string,
  packageJson: string,
  configFiles: { path: string; content: string }[]
): PromptResult {
  const configFilesText = configFiles
    .map((file) => `=== ${file.path} ===\n${file.content.slice(0, 2000)}`)
    .join('\n\n');

  const system = [
    'You are a software project analyzer.',
    'Return precise structured information about the technology stack.',
    'Always respond with valid JSON only. No markdown, code fences, or extra text.',
  ].join(' ');

  const user = `Analyze this project and determine its technology stack.

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

Be thorough. If you are unsure about a field, use null rather than guessing.`;

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