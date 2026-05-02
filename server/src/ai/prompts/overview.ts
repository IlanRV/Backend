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
    'You are a technical writer who specializes in clear project documentation.',
    'Always respond with valid JSON only. No markdown, code fences, or extra text.',
  ].join(' ');

  const user = `Analyze this project and write a comprehensive overview.

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
- The summary should help a new developer understand the project without reading all code.
- If the README is missing or thin, infer from the code structure and package.json.
- Be factual and do not invent features that are not supported by the provided files.`;

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