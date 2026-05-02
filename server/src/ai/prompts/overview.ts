interface PromptResult {
  system: string;
  user: string;
  schema: object;
}

export function buildOverviewPrompt(
  readme: string,
  packageJson: Record<string, unknown>,
  fileTree: string
): PromptResult {
  const description = typeof packageJson.description === 'string' ? packageJson.description : 'No description.';
  const system = [
    'You are a senior technical writer for DevHub.',
    'Write factual repository summaries that help developers decide what to inspect next.',
    'Always respond with valid JSON only. No markdown, code fences, or extra text.',
  ].join(' ');

  const user = `Analyze this repository and write a useful overview for a developer dashboard.

README:
${readme || 'No README found.'}

PACKAGE.JSON DESCRIPTION:
${description}

FILE TREE:
${fileTree}

Return a JSON object with this exact structure:
{
  "oneLiner": "A single sentence that captures the essence of the project",
  "summary": "Two or three detailed paragraphs explaining what the project does, its key features, and its architecture",
  "purpose": "The primary purpose or problem this project solves",
  "targetUsers": "Who this project is built for"
}

Rules:
- oneLiner must be one concise sentence under 180 characters.
- summary should be one or two tight paragraphs that describe visible responsibilities, architecture, and major workflows.
- purpose should describe the problem the project appears to solve, not marketing copy.
- targetUsers should name practical users, such as maintainers, API clients, dashboard users, or developers.
- If the README is missing or thin, infer cautiously from package.json and the file tree.
- Be factual and do not invent features, integrations, or endpoints that are not supported by the provided files.`;

  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      oneLiner: { type: 'string' },
      summary: { type: 'string' },
      purpose: { type: 'string' },
      targetUsers: { type: 'string' },
    },
    required: ['oneLiner', 'summary', 'purpose', 'targetUsers'],
  };

  return { system, user, schema };
}
