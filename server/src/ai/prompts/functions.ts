interface PromptResult {
  system: string;
  user: string;
  schema: object;
}

export function buildFunctionsPrompt(files: { path: string; content: string }[]): PromptResult {
  const sourceFiles = files
    .filter((file) => {
      const extension = file.path.split('.').pop()?.toLowerCase();
      return ['js', 'ts', 'jsx', 'tsx', 'mjs', 'cjs'].includes(extension || '');
    })
    .slice(0, 15)
    .map((file) => `=== ${file.path} ===\n${file.content.slice(0, 5000)}`)
    .join('\n\n');

  const system = [
    'You are a code documentation expert.',
    'Analyze source code and document exported functions, classes, and methods.',
    'Always respond with valid JSON only. No markdown, code fences, or extra text.',
  ].join(' ');

  const user = `Document every exported function, class, and method in these source files:

${sourceFiles || 'No source files provided.'}

Return a JSON array with this exact structure:
[
  {
    "name": "The function, class, or method name",
    "type": "function" | "class" | "method",
    "file": "The file path where it is defined",
    "line": 1,
    "signature": "The full function signature as a string",
    "description": "What it does, when to use it, and important behavior",
    "params": [
      { "name": "Parameter name", "type": "Parameter type", "description": "What this parameter does" }
    ],
    "returns": { "type": "Return type", "description": "What the return value represents" },
    "throws": ["Error types or messages it might throw"],
    "dependencies": ["Other functions or modules it depends on"]
  }
]

Rules:
- Document every exported function, class, and method you can identify.
- Include route handlers, middleware, utilities, models, and controllers.
- For Express route handlers, describe the HTTP method and path if visible.
- Use an empty array when there are no params, throws, or dependencies.
- If you cannot determine an exact line number, estimate it from the provided file content.`;

  const schema = {
    type: 'array',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string' },
        type: { type: 'string', enum: ['function', 'class', 'method'] },
        file: { type: 'string' },
        line: { type: 'number' },
        signature: { type: 'string' },
        description: { type: 'string' },
        params: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string' },
              type: { type: 'string' },
              description: { type: 'string' },
            },
            required: ['name', 'type', 'description'],
          },
        },
        returns: {
          type: 'object',
          additionalProperties: false,
          properties: {
            type: { type: 'string' },
            description: { type: 'string' },
          },
          required: ['type', 'description'],
        },
        throws: {
          type: 'array',
          items: { type: 'string' },
        },
        dependencies: {
          type: 'array',
          items: { type: 'string' },
        },
      },
      required: ['name', 'type', 'file', 'line', 'signature', 'description', 'params', 'returns', 'throws', 'dependencies'],
    },
  };

  return { system, user, schema };
}