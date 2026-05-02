export interface PromptResult {
  system: string;
  user: string;
  schema: object;
}

export interface FunctionPromptChunk extends PromptResult {
  chunkIndex: number;
  totalChunks: number;
  includedFiles: string[];
  omittedCount: number;
}

const supportedExtensions = new Set(['js', 'ts', 'jsx', 'tsx', 'mjs', 'cjs']);
const ignoredPathFragments = ['/node_modules/', '/dist/', '/build/', '/coverage/', '/.git/'];
const maxRankedSourceFiles = 24;
const maxFilesPerChunk = 8;
const chunkOverlapFiles = 1;
const maxChunks = 3;
const maxCharsPerFile = 3200;

interface SourceFile {
  path: string;
  content: string;
}

function extensionOf(path: string): string {
  return path.split('.').pop()?.toLowerCase() || '';
}

function isSupportedSourceFile(path: string): boolean {
  const normalizedPath = `/${path.replace(/^\/+/, '')}`;
  return supportedExtensions.has(extensionOf(path)) && !ignoredPathFragments.some((fragment) => normalizedPath.includes(fragment));
}

function scoreSourceFile(file: SourceFile): number {
  const path = file.path.toLowerCase();
  let score = 0;

  if (path.includes('/src/')) score += 10;
  if (/(route|router|controller|handler|service|api|model|schema|index)\./.test(path)) score += 12;
  if (/\bexport\b/.test(file.content)) score += 20;
  if (/\brouter\.(get|post|put|patch|delete)\b|\bapp\.(get|post|put|patch|delete)\b/.test(file.content)) score += 20;
  if (/\bclass\s+[A-Za-z_$][\w$]*\b|\bfunction\s+[A-Za-z_$][\w$]*\b/.test(file.content)) score += 8;

  return score;
}

function rollingWindows<T>(items: T[], windowSize: number, overlap: number, maxWindowCount: number): T[][] {
  const windows: T[][] = [];
  const step = Math.max(1, windowSize - overlap);

  for (let start = 0; start < items.length && windows.length < maxWindowCount; start += step) {
    const windowItems = items.slice(start, start + windowSize);

    if (windowItems.length === 0) {
      break;
    }

    windows.push(windowItems);

    if (start + windowSize >= items.length) {
      break;
    }
  }

  return windows;
}

function buildPromptForChunk(
  selectedFiles: SourceFile[],
  chunkIndex: number,
  totalChunks: number,
  candidateCount: number,
  omittedCount: number
): FunctionPromptChunk {
  const sourceFiles = selectedFiles
    .map((file) => `=== ${file.path} ===\n${file.content.slice(0, maxCharsPerFile)}`)
    .join('\n\n');

  const system = [
    'You are a precise code documentation expert for DevHub.',
    'Analyze visible source snippets and document public code surfaces, including exported symbols and HTTP route handlers.',
    'Do not invent behavior from files or lines that are not shown.',
    'Always respond with valid JSON only. No markdown, code fences, or extra text.',
  ].join(' ');

  const user = `Document the important public functions, classes, methods, and route handlers in these source files.
The source may be truncated; only describe behavior that is visible in the snippets.
This is chunk ${chunkIndex + 1} of ${totalChunks}. Adjacent chunks intentionally overlap; duplicate entries are acceptable.
Candidate source files: ${candidateCount}. Included in this chunk: ${selectedFiles.length}. Omitted lower-priority files: ${omittedCount}.

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
- Prioritize exported functions/classes, route handlers, middleware, utilities, models, controllers, and shared helpers.
- For anonymous Express route handlers, use a stable name like "POST /api/workspaces" when the route is visible.
- For Express route handlers, describe the HTTP method and path if visible.
- Use the actual file path from the snippet.
- Line numbers should be based on the visible snippet line positions; estimate only when necessary.
- Keep descriptions factual and implementation-oriented, not marketing-oriented.
- Use an empty array when there are no params, throws, or dependencies.
- If no important public surfaces are visible, return an empty array.`;

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

  return {
    system,
    user,
    schema,
    chunkIndex,
    totalChunks,
    includedFiles: selectedFiles.map((file) => file.path),
    omittedCount,
  };
}

export function buildFunctionPromptChunks(files: SourceFile[]): FunctionPromptChunk[] {
  const candidateFiles = files.filter((file) => isSupportedSourceFile(file.path));

  if (candidateFiles.length === 0) {
    return [];
  }

  const rankedFiles = [...candidateFiles]
    .sort((left, right) => scoreSourceFile(right) - scoreSourceFile(left) || left.path.localeCompare(right.path))
    .slice(0, maxRankedSourceFiles);
  const windows = rollingWindows(rankedFiles, maxFilesPerChunk, chunkOverlapFiles, maxChunks);
  const omittedCount = Math.max(0, candidateFiles.length - rankedFiles.length);

  return windows.map((windowFiles, chunkIndex) =>
    buildPromptForChunk(windowFiles, chunkIndex, windows.length, candidateFiles.length, omittedCount)
  );
}

export function buildFunctionsPrompt(files: SourceFile[]): PromptResult {
  const chunks = buildFunctionPromptChunks(files);

  return chunks[0] || buildPromptForChunk([], 0, 1, 0, 0);
}
