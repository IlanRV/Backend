# Engineer B — AI & Extraction Pipeline Specification for DevHub

> **Paste this entire document into a fresh AI chat session to give full context.**

---

## 1. What We're Building

**DevHub** is a multi-repo workspace platform where users:
1. Paste GitHub repo URLs
2. Repos get cloned inside **BrowserPod** (in-browser Node.js Wasm sandbox) by the frontend
3. The frontend sends all file contents to our **backend API**
4. Your job: build the **AI pipeline** that analyzes the code via OpenRouter, extracts structured data, generates an AIreadme, and provides the chat functionality

**No authentication, no users, no login.** Workspaces are public by URL.

---

## 2. Your Role — Engineer B

You build the **AI & Extraction Pipeline**. Engineer A builds the core infrastructure (Express server, Firebase Firestore, CRUD endpoints, and chat routes — they import your OpenRouter client for chat).

### You own these files:
```
server/src/ai/
├── openrouter.ts           ← OpenRouter API client (two functions)
├── extraction.ts           ← Orchestrates all 4 extraction prompts
├── prompts/
│   ├── techStack.ts        ← Tech stack detection prompt
│   ├── overview.ts         ← Project overview prompt
│   ├── functions.ts        ← Function-level documentation prompt
│   └── aiReadme.ts         ← AI-generated README prompt
├── routes/
│   └── ai.ts               ← Two endpoints: POST /api/ai/extract/:repoId, GET /api/ai/extract/:repoId
└── types.ts                ← You don't create this — shared types are in ../types/index.ts (Engineer A creates)
```

---

## 3. Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 22 |
| Language | TypeScript |
| AI API | OpenRouter (`https://openrouter.ai/api/v1/chat/completions`) |
| Model | `anthropic/claude-sonnet-4` (default, configurable) |
| Database | Firebase Firestore (Engineer A provides helper functions) |

---

## 4. Environment Variables

The `.env` file is shared with Engineer A. You only need:
```
OPENROUTER_API_KEY=sk-or-v1-xxxxx
OPENROUTER_MODEL=anthropic/claude-sonnet-4
```

These are accessed via `config.openrouter.apiKey` and `config.openrouter.model` from `../config.ts` (Engineer A builds this).

---

## 5. What Engineer A Provides (You Import These)

### From `../types/index.ts` (shared types):
```typescript
export interface ExtractionResult {
  techStack: TechStack;
  overview: Overview;
  functions: FunctionDoc[];
  dependencies: Record<string, string>;
}

export interface TechStack {
  language: string;
  framework: string | null;
  runtime: string;
  buildTool: string | null;
  testingFramework: string | null;
  database: string | null;
  otherTools: string[];
}

export interface Overview {
  oneLiner: string;
  summary: string;
  purpose: string;
  targetUsers: string;
}

export interface FunctionDoc {
  name: string;
  type: 'function' | 'class' | 'method';
  file: string;
  line: number;
  signature: string;
  description: string;
  params: { name: string; type: string; description: string }[];
  returns: { type: string; description: string };
  throws: string[];
  dependencies: string[];
}
```

### From `../lib/firebase.ts` (Firestore helpers):
```typescript
export async function getDoc(collection: string, id: string): Promise<any | null>;
export async function setDoc(collection: string, id: string, data: any): Promise<void>;
// Note: pass { merge: true } as third arg to update a doc instead of overwriting
```

### From `../config.ts`:
```typescript
export const config = {
  openrouter: {
    apiKey: string,
    model: string, // e.g., 'anthropic/claude-sonnet-4'
  },
};
```

---

## 6. Files You Must Build

---

### 6.1 `server/src/ai/openrouter.ts` — OpenRouter Client

This is the foundation. Engineer A will import `callOpenRouter` from here for the chat endpoints.

```typescript
import { config } from '../config';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

interface OpenRouterResponse {
  choices: Array<{
    message: {
      content: string;
      role: string;
    };
  }>;
}

/**
 * Call OpenRouter for a standard chat completion.
 * Returns the AI's text response.
 * Used by chat endpoints (Engineer A) and AIreadme generation (you).
 */
export async function callOpenRouter(
  userMessage: string,
  systemPrompt: string,
  model?: string
): Promise<string> {
  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.openrouter.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: model || config.openrouter.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      max_tokens: 4096,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`OpenRouter API error ${response.status}: ${errorBody}`);
  }

  const data: OpenRouterResponse = await response.json();
  return data.choices[0].message.content;
}

/**
 * Call OpenRouter for structured JSON extraction.
 * Forces the AI to respond with valid JSON matching your schema.
 * Returns a typed object.
 * Used by all extraction prompts.
 */
export async function callOpenRouterStructured<T>(
  userMessage: string,
  systemPrompt: string,
  jsonSchema: object
): Promise<T> {
  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.openrouter.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.openrouter.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      max_tokens: 4096,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'response',
          schema: jsonSchema,
          strict: true,
        },
      },
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`OpenRouter API error ${response.status}: ${errorBody}`);
  }

  const data: OpenRouterResponse = await response.json();
  const content = data.choices[0].message.content;
  
  try {
    return JSON.parse(content) as T;
  } catch (parseError) {
    // Retry once if JSON parse fails
    console.warn('JSON parse failed, retrying...');
    const retryResponse = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.openrouter.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.openrouter.model,
        messages: [
          { role: 'system', content: systemPrompt + '\n\nCRITICAL: You MUST respond with valid JSON only. No markdown, no code fences, no extra text.' },
          { role: 'user', content: userMessage },
        ],
        max_tokens: 4096,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'response',
            schema: jsonSchema,
            strict: true,
          },
        },
      }),
    });
    const retryData: OpenRouterResponse = await retryResponse.json();
    return JSON.parse(retryData.choices[0].message.content) as T;
  }
}
```

---

### 6.2 `server/src/ai/prompts/techStack.ts` — Tech Stack Detection

**Purpose**: Analyze the repo and return structured tech stack information.

**Input**: Full list of file paths and the contents of `package.json` and any config files.

**Output**: `TechStack` object.

```typescript
import { TechStack } from '../../types';

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
    .map(f => `=== ${f.path} ===\n${f.content.substring(0, 2000)}`)
    .join('\n\n');

  const system = `You are a software project analyzer. You examine codebases and return precise, structured information about the technology stack. Always respond with valid JSON only — no markdown, no code fences, no extra text.`;

  const user = `Analyze this project and determine its technology stack.

FILE TREE:
${fileTree}

PACKAGE.JSON:
${packageJson}

CONFIG FILES:
${configFilesText || 'No config files found.'}

Return a JSON object with this exact structure:
{
  "language": "The primary programming language (e.g., 'JavaScript', 'TypeScript', 'Python')",
  "framework": "The main framework if any (e.g., 'Express', 'Next.js', 'React', 'Fastify') or null",
  "runtime": "The runtime environment (e.g., 'Node.js', 'Deno', 'Bun')",
  "buildTool": "The build tool if detected (e.g., 'webpack', 'vite', 'tsc', 'esbuild') or null",
  "testingFramework": "The testing framework if detected (e.g., 'jest', 'mocha', 'vitest') or null",
  "database": "Database if detected (e.g., 'PostgreSQL', 'MongoDB', 'SQLite') or null",
  "otherTools": ["Array of other notable tools/libraries detected"]
}

Be thorough. If you're unsure about a field, use null rather than guessing.`;

  const schema = {
    type: 'object',
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
```

---

### 6.3 `server/src/ai/prompts/overview.ts` — Project Overview

**Purpose**: Generate a comprehensive project overview summary.

**Input**: README content, package.json, and file tree.

**Output**: `Overview` object.

```typescript
import { Overview } from '../../types';

interface PromptResult {
  system: string;
  user: string;
  schema: object;
}

export function buildOverviewPrompt(
  readme: string,
  packageJson: any,
  fileTree: string
): PromptResult {
  const system = `You are a technical writer who specializes in creating clear, concise project documentation. Always respond with valid JSON only — no markdown, no code fences, no extra text.`;

  const user = `Analyze this project and write a comprehensive overview.

README:
${readme || 'No README found.'}

PACKAGE.JSON DESCRIPTION:
${packageJson?.description || 'No description.'}

FILE TREE:
${fileTree}

Return a JSON object with this exact structure:
{
  "oneLiner": "A single sentence that captures the essence of the project",
  "summary": "2-3 detailed paragraphs explaining what the project does, its key features, and its architecture. Be thorough — this is for developers who need to understand the codebase quickly.",
  "purpose": "The primary purpose or problem this project solves",
  "targetUsers": "Who this project is built for (e.g., 'Frontend developers', 'DevOps engineers', 'Data scientists')"
}

Rules:
- The summary should be detailed enough that a new developer can understand the project without reading the code
- If the README is missing or low quality, infer from the code structure and package.json
- Be factual, don't hallucinate features that aren't in the code`;

  const schema = {
    type: 'object',
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
```

---

### 6.4 `server/src/ai/prompts/functions.ts` — Function-Level Documentation

**Purpose**: Document every exported function, class, and method in the project.

**Input**: Source code files (up to 15 files to avoid token limits).

**Output**: Array of `FunctionDoc` objects.

```typescript
import { FunctionDoc } from '../../types';

interface PromptResult {
  system: string;
  user: string;
  schema: object;
}

export function buildFunctionsPrompt(
  files: { path: string; content: string }[]
): PromptResult {
  // Only include source code files, limit size
  const sourceFiles = files
    .filter(f => {
      const ext = f.path.split('.').pop()?.toLowerCase();
      return ['js', 'ts', 'jsx', 'tsx', 'mjs', 'cjs'].includes(ext || '');
    })
    .slice(0, 15)
    .map(f => `=== ${f.path} ===\n${f.content.substring(0, 5000)}`)
    .join('\n\n');

  const system = `You are a code documentation expert. You analyze source code and document every exported function, class, and method. Always respond with valid JSON only — no markdown, no code fences, no extra text.`;

  const user = `Document every exported function, class, and method in these source files:

${sourceFiles || 'No source files provided.'}

Return a JSON array with this exact structure:
[
  {
    "name": "The function/class/method name",
    "type": "function" | "class" | "method",
    "file": "The file path where it's defined",
    "line": "The line number where it starts (number)",
    "signature": "The full function signature as a string (e.g., 'function getTasks(req, res)')",
    "description": "A clear description of what it does, when to use it, and any important behavior",
    "params": [
      {
        "name": "Parameter name",
        "type": "Parameter type (string, number, object, etc.)",
        "description": "What this parameter does"
      }
    ],
    "returns": {
      "type": "Return type",
      "description": "What the return value represents"
    },
    "throws": ["Array of error types it might throw"],
    "dependencies": ["Array of other functions/modules it depends on"]
  }
]

Rules:
- Document EVERY exported function, class, and method — don't skip any
- Include route handlers, middleware, utilities, models, controllers
- For Express route handlers, describe what HTTP method and path they handle
- If a function has no parameters, use an empty array []
- If you can't determine the line number exactly, estimate it
- Be thorough with descriptions — explain WHY the function exists, not just WHAT it does`;

  const schema = {
    type: 'array',
    items: {
      type: 'object',
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
```

---

### 6.5 `server/src/ai/prompts/aiReadme.ts` — AI-Generated README

**Purpose**: Generate a comprehensive, well-structured README.md that replaces a poorly-written or missing one.

**Input**: All extraction results from the previous 3 prompts (tech stack, overview, functions) + dependencies.

**Output**: Markdown string.

```typescript
import { TechStack, Overview, FunctionDoc } from '../../types';

interface PromptResult {
  system: string;
  user: string;
}

export function buildAiReadmePrompt(
  techStack: TechStack,
  overview: Overview,
  functions: FunctionDoc[],
  dependencies: Record<string, string>,
  repoName: string
): PromptResult {
  const functionsText = functions
    .map(f => `- \`${f.signature}\` in \`${f.file}\`:${f.line} — ${f.description}`)
    .join('\n');

  const depsText = Object.entries(dependencies)
    .map(([name, version]) => `- \`${name}\`: \`${version}\``)
    .join('\n');

  const system = `You are a senior developer who writes exceptional README documentation. You believe that every project deserves a clear, comprehensive README regardless of what the original author provided. Respond in clean, well-formatted Markdown. Do NOT wrap your response in code fences — just return the raw markdown.`;

  const user = `Generate a complete, professional README.md for the project "${repoName}".

Here is everything you know about the project:

TECH STACK:
- Language: ${techStack.language}
- Framework: ${techStack.framework || 'None'}
- Runtime: ${techStack.runtime}
- Build Tool: ${techStack.buildTool || 'None'}
- Testing: ${techStack.testingFramework || 'None'}
- Database: ${techStack.database || 'None'}
- Other Tools: ${techStack.otherTools.join(', ') || 'None'}

OVERVIEW:
- One Liner: ${overview.oneLiner}
- Purpose: ${overview.purpose}
- Target Users: ${overview.targetUsers}
- Summary: ${overview.summary}

FUNCTIONS & API:
${functionsText || 'No functions documented.'}

DEPENDENCIES:
${depsText || 'No dependencies found.'}

Write a README.md with these sections (in this order):

# ${repoName}

## 📖 Overview
A comprehensive overview section (use the summary provided above, but make it polished and professional).

## 🏗️ Architecture
Describe the project architecture. Use a text-based diagram showing how components connect. For example:
\`\`\`
┌─────────────┐     ┌─────────────┐
│  server.js  │────▶│  routes/    │
│  (entry)    │     │  tasks.js   │
└─────────────┘     └─────────────┘
\`\`\`
Explain the data flow and how the pieces fit together.

## 🚀 Setup Instructions
Step-by-step instructions with EXACT commands to run:
1. Prerequisites (Node.js version, etc.)
2. Clone the repo
3. Install dependencies
4. Configure environment variables (list all required env vars)
5. Run the project
6. Run tests (if applicable)

## 📚 API Reference
Document every function/endpoint from the FUNCTIONS section above. Group by file. For each:
- Function signature
- Description
- Parameters(if any)
- Returns
- Example usage (if you can infer it)

## 🔧 Environment Variables
List all environment variables the project needs (infer from the code — check for process.env references). Use a table:
| Variable | Required | Default | Description |
|----------|----------|---------|-------------|

## 📁 Project Structure
Based on the tech stack and functions, describe the typical folder structure and what each file/folder does.

## 📦 Dependencies
Split into Production Dependencies and Development Dependencies. Add brief descriptions of what each key dependency does.

## 🤝 Contributing
A standard contributing section with guidelines for:
- How to set up the dev environment
- Code style guidelines
- How to submit changes

## 📄 License
Note that the license should be confirmed by the project maintainer.

---

CRITICAL RULES:
- Be specific, not generic. Reference actual function names, file paths, and dependencies.
- Include exact commands that work (don't use placeholders like <your-port>).
- If information is missing, do your best to infer it — but never hallucinate features.
- The README should be immediately useful to a developer cloning this repo for the first time.
- Do NOT wrap the response in markdown code fences. Return raw markdown.`;

  return { system, user };
}
```

---

### 6.6 `server/src/ai/extraction.ts` — Extraction Orchestrator

**Purpose**: Runs all 4 extraction prompts in sequence, stores results in Firestore.

**This is the main file that ties everything together.**

```typescript
import { callOpenRouter, callOpenRouterStructured } from './openrouter';
import { buildTechStackPrompt } from './prompts/techStack';
import { buildOverviewPrompt } from './prompts/overview';
import { buildFunctionsPrompt } from './prompts/functions';
import { buildAiReadmePrompt } from './prompts/aiReadme';
import { setDoc } from '../lib/firebase';
import { TechStack, Overview, FunctionDoc, ExtractionResult } from '../types';

export async function extractAll(
  repoId: string,
  repoName: string,
  fileTree: string,
  files: { path: string; content: string }[]
): Promise<ExtractionResult> {
  console.log(`[Extraction] Starting extraction for repo ${repoId} (${repoName})`);
  console.log(`[Extraction] File tree: ${fileTree.split('\n').length} entries, ${files.length} files`);

  // Find key files
  const packageJsonFile = files.find(f => f.path.endsWith('package.json') && !f.path.includes('node_modules'));
  const readmeFile = files.find(f => {
    const name = f.path.toLowerCase();
    return (name.includes('readme') || name === 'readme.md') && !name.includes('node_modules');
  });
  const configFiles = files.filter(f => {
    const name = f.path.toLowerCase();
    return ['tsconfig.json', '.eslintrc', '.prettierrc', 'vite.config', 'webpack.config',
            'next.config', 'tailwind.config', 'jest.config', '.babelrc', '.env.example']
      .some(cfg => name.includes(cfg));
  });

  const packageJson = packageJsonFile ? packageJsonFile.content : '{}';
  const readme = readmeFile ? readmeFile.content : '';

  // === EXTRACTION 1: Tech Stack ===
  console.log('[Extraction] Step 1/4: Detecting tech stack...');
  let techStack: TechStack;
  try {
    const { system, user, schema } = buildTechStackPrompt(
      fileTree,
      packageJson,
      configFiles.map(f => ({ path: f.path, content: f.content }))
    );
    techStack = await callOpenRouterStructured<TechStack>(user, system, schema);
    console.log(`[Extraction] Tech stack detected: ${techStack.language} / ${techStack.framework}`);
  } catch (error) {
    console.error('[Extraction] Tech stack detection failed:', error);
    techStack = {
      language: 'Unknown',
      framework: null,
      runtime: 'Unknown',
      buildTool: null,
      testingFramework: null,
      database: null,
      otherTools: [],
    };
  }

  // === EXTRACTION 2: Overview ===
  console.log('[Extraction] Step 2/4: Generating overview...');
  let overview: Overview;
  try {
    const pkg = JSON.parse(packageJson);
    const { system, user, schema } = buildOverviewPrompt(readme, pkg, fileTree);
    overview = await callOpenRouterStructured<Overview>(user, system, schema);
    console.log(`[Extraction] Overview generated: ${overview.oneLiner.substring(0, 80)}...`);
  } catch (error) {
    console.error('[Extraction] Overview generation failed:', error);
    overview = {
      oneLiner: 'A software project',
      summary: 'Overview generation failed. Please check the repository structure.',
      purpose: 'Unknown',
      targetUsers: 'Developers',
    };
  }

  // === EXTRACTION 3: Function Documentation ===
  console.log('[Extraction] Step 3/4: Documenting functions...');
  let functions: FunctionDoc[] = [];
  try {
    const { system, user, schema } = buildFunctionsPrompt(files);
    functions = await callOpenRouterStructured<FunctionDoc[]>(user, system, schema);
    console.log(`[Extraction] Documented ${functions.length} functions`);
  } catch (error) {
    console.error('[Extraction] Function documentation failed:', error);
    functions = [];
  }

  // === EXTRACTION 4: Dependencies ===
  let dependencies: Record<string, string> = {};
  try {
    const pkg = JSON.parse(packageJson);
    dependencies = { ...pkg.dependencies, ...pkg.devDependencies } || {};
  } catch {
    dependencies = {};
  }

  // === Store partial results in Firestore ===
  const extractionResult: ExtractionResult = { techStack, overview, functions, dependencies };
  await setDoc('repos', repoId, {
    analysis: extractionResult,
  }, { merge: true });

  // === EXTRACTION 5: AIreadme ===
  console.log('[Extraction] Step 4/4: Generating AI Readme...');
  try {
    const { system, user } = buildAiReadmePrompt(techStack, overview, functions, dependencies, repoName);
    const aiReadme = await callOpenRouter(user, system);
    console.log(`[Extraction] AIreadme generated (${aiReadme.length} chars)`);

    // Store AIreadme + mark repo as ready
    await setDoc('repos', repoId, {
      aiReadme,
      status: 'ready',
    }, { merge: true });

    return extractionResult;
  } catch (error) {
    console.error('[Extraction] AIreadme generation failed:', error);

    // Still mark as ready even if AIreadme failed — we have partial results
    await setDoc('repos', repoId, {
      status: 'ready',
    }, { merge: true });

    return extractionResult;
  }
}
```

---

### 6.7 `server/src/routes/ai.ts` — AI API Routes

**Purpose**: Two endpoints that the frontend calls for AI extraction.

```typescript
import { Router, Request, Response } from 'express';
import { getDoc, setDoc } from '../lib/firebase';
import { extractAll } from '../ai/extraction';

const router = Router();

/**
 * POST /api/ai/extract/:repoId
 * 
 * Kicks off AI code analysis for a repo.
 * The frontend calls this after cloning the repo in BrowserPod and reading all files.
 * 
 * Request body:
 * {
 *   fileTree: string,  // Output of `find /repo -type f` (paths separated by newlines)
 *   files: [
 *     { path: string, content: string }  // Each file's path and full text content
 *   ]
 * }
 * 
 * Response: { success: true, extractionId: repoId }
 * 
 * This runs ALL 4 extraction prompts (tech stack, overview, functions, AIreadme).
 * Each prompt's result is stored in Firestore as it completes.
 * Final status is set to "ready" in the repo doc.
 */
router.post('/extract/:repoId', async (req: Request, res: Response) => {
  try {
    const { repoId } = req.params;
    const { fileTree, files } = req.body;

    // Validation
    if (!fileTree || !files || !Array.isArray(files)) {
      return res.status(400).json({
        error: 'fileTree (string) and files (array of {path, content}) are required',
      });
    }

    if (files.length === 0) {
      return res.status(400).json({ error: 'files array is empty' });
    }

    // Check repo exists
    const repo = await getDoc('repos', repoId);
    if (!repo) {
      return res.status(404).json({ error: 'Repo not found' });
    }

    // Update repo status to 'analyzing'
    await setDoc('repos', repoId, { status: 'analyzing' }, { merge: true });

    // Run extraction — don't await the response, let it run
    // The frontend will poll GET /api/repos/:repoId to check status
    extractAll(repoId, repo.name, fileTree, files)
      .then(result => {
        console.log(`[AI Route] Extraction complete for repo ${repoId}`);
      })
      .catch(error => {
        console.error(`[AI Route] Extraction failed for repo ${repoId}:`, error);
        setDoc('repos', repoId, { status: 'error' }, { merge: true }).catch(console.error);
      });

    // Return immediately — extraction runs in background
    return res.json({ success: true, extractionId: repoId });
  } catch (error) {
    console.error('[AI Route] POST /extract/:repoId error:', error);
    return res.status(500).json({ error: 'Failed to start extraction', details: String(error) });
  }
});

/**
 * GET /api/ai/extract/:repoId
 * 
 * Returns cached extraction results + AIreadme from Firestore.
 * The frontend polls this after kicking off extraction.
 * 
 * Response:
 * {
 *   techStack: TechStack | null,
 *   overview: Overview | null,
 *   functions: FunctionDoc[],
 *   dependencies: Record<string, string>,
 *   aiReadme: string | null
 * }
 */
router.get('/extract/:repoId', async (req: Request, res: Response) => {
  try {
    const repo = await getDoc('repos', req.params.repoId);
    if (!repo) {
      return res.status(404).json({ error: 'Repo not found' });
    }

    return res.json({
      techStack: repo.analysis?.techStack || null,
      overview: repo.analysis?.overview || null,
      functions: repo.analysis?.functions || [],
      dependencies: repo.analysis?.dependencies || {},
      aiReadme: repo.aiReadme || null,
    });
  } catch (error) {
    console.error('[AI Route] GET /extract/:repoId error:', error);
    return res.status(500).json({ error: 'Failed to get extraction results', details: String(error) });
  }
});

export default router;
```

---

## 7. How Engineer A Uses Your Code

Engineer A will import your `callOpenRouter` function in their chat routes:

```typescript
// In Engineer A's server/src/routes/chat.ts:
import { callOpenRouter } from '../ai/openrouter';

// To send a chat message:
const reply = await callOpenRouter(
  userMessage,
  "You are a code expert assistant. You have access to this repo's source code: [repo files here]"
);
```

Engineer A will mount your routes in `server/src/index.ts`:
```typescript
import aiRoutes from './routes/ai';
app.use('/api/ai', aiRoutes);
```

---

## 8. How the Frontend Calls You

### Flow: User Adds a Repo

```
1. User pastes GitHub URL → Frontend calls POST /api/workspaces/:wsId/repos
2. Frontend boots BrowserPod → runs git clone
3. Frontend reads all files from pod:
   - fileTree = "src/index.js\nsrc/routes/tasks.js\npackage.json\nREADME.md"
   - files = [{path: "package.json", content: "..."}, {path: "src/index.js", content: "..."}, ...]
4. Frontend calls YOUR endpoint:

POST http://localhost:3001/api/ai/extract/def-456-uuid
Content-Type: application/json

{
  "fileTree": "src/\n  index.js\n  routes/\n    tasks.js\npackage.json\nREADME.md",
  "files": [
    { "path": "package.json", "content": "{\"name\":\"task-tracker\"...}" },
    { "path": "src/index.js", "content": "const express = require('express');\n..." },
    { "path": "src/routes/tasks.js", "content": "const router = express.Router();\n..." },
    { "path": "README.md", "content": "# Task Tracker\n\nA simple API" }
  ]
}

5. Your endpoint returns immediately: { "success": true, "extractionId": "def-456-uuid" }
6. Your endpoint runs extraction in the background (tech stack → overview → functions → AIreadme)
7. Frontend polls GET /api/repos/def-456-uuid until status === "ready"
8. Frontend then calls GET /api/ai/extract/def-456-uuid to get all results
```

### Expected curl Test

```bash
# Trigger extraction
curl -X POST http://localhost:3001/api/ai/extract/abc-123 \
  -H "Content-Type: application/json" \
  -d '{
    "fileTree": "src/index.js\nsrc/routes/tasks.js\npackage.json\nREADME.md",
    "files": [
      {"path":"package.json","content":"{\"name\":\"test\",\"dependencies\":{\"express\":\"^4.18.0\"},\"scripts\":{\"start\":\"node src/index.js\"}}"},
      {"path":"src/index.js","content":"const express = require(\"express\");\nconst tasks = require(\"./routes/tasks\");\nconst app = express();\napp.use(\"/tasks\", tasks);\napp.listen(3000, () => console.log(\"Running\"));"},
      {"path":"src/routes/tasks.js","content":"const express = require(\"express\");\nconst router = express.Router();\nlet tasks = [];\nrouter.get(\"/\", (req, res) => res.json(tasks));\nrouter.post(\"/\", (req, res) => { tasks.push(req.body); res.status(201).json(req.body); });\nmodule.exports = router;"},
      {"path":"README.md","content":"# Test Project\n\nA simple task API"}
    ]
  }'

# Get results (after a few seconds)
curl http://localhost:3001/api/ai/extract/abc-123
```

---

## 9. Step-by-Step Build Order

### Step 1: Understand the shared code (15 min)
- Read `../types/index.ts` (Engineer A creates this)
- Read `../config.ts` (Engineer A creates this)
- Read `../lib/firebase.ts` (Engineer A creates this)
- You need: `getDoc`, `setDoc` from firebase, all types from types/index, config from config

### Step 2: Build OpenRouter client (1 hour)
1. Create `server/src/ai/openrouter.ts`
2. Copy the code from Section 6.1
3. Test with a simple curl-like call:
```typescript
const reply = await callOpenRouter(
  'Say hello in JSON: {"greeting": "..."}',
  'You are a helpful assistant. Always respond with valid JSON.'
);
console.log(reply);
```

### Step 3: Build Tech Stack prompt (45 min)
1. Create `server/src/ai/prompts/techStack.ts`
2. Copy code from Section 6.2
3. Test with real package.json content

### Step 4: Build Overview prompt (45 min)
1. Create `server/src/ai/prompts/overview.ts`
2. Copy code from Section 6.3
3. Test with a real README

### Step 5: Build Functions prompt (1 hour)
1. Create `server/src/ai/prompts/functions.ts`
2. Copy code from Section 6.4
3. Test with a real source file

### Step 6: Build AIreadme prompt (45 min)
1. Create `server/src/ai/prompts/aiReadme.ts`
2. Copy code from Section 6.5
3. Test by feeding it mock extraction results

### Step 7: Build Extraction orchestrator (1 hour)
1. Create `server/src/ai/extraction.ts`
2. Copy code from Section 6.6
3. Wire up all 4 prompts in sequence
4. Handle errors gracefully (don't fail everything if one prompt fails)

### Step 8: Build AI routes (30 min)
1. Create `server/src/routes/ai.ts`
2. Copy code from Section 6.7
3. Test with curl (see Section 8)

### Step 9: Integration testing (1 hour)
1. Test the full pipeline with a real GitHub repo
2. Verify Firestore has all data stored correctly
3. Verify the GET endpoint returns correct data

### Step 10: Coordinate with Engineer A (30 min)
1. Confirm your `callOpenRouter` function works for their chat endpoints
2. Confirm your routes mount correctly in `index.ts`
3. Test chat endpoint together

---

## 10. Error Handling Rules

- **Every AI call wrapped in try/catch** — if one extraction prompt fails, continue to the next
- **Partial results are valid** — if tech stack detection fails, return `{ language: "Unknown", ... }` defaults
- **Log everything** with `console.log` and `console.error` for debugging
- **Don't crash the server** — all errors caught at the route level
- **Rate limits**: OpenRouter has rate limits. If you get 429 errors, add a 1-second delay between AI calls
- **Token limits**: Trim file contents to 5000 characters max per file for the functions prompt

---

## 11. Testing Checklist

- [ ] `callOpenRouter` returns text from OpenRouter
- [ ] `callOpenRouterStructured` returns typed JSON from OpenRouter
- [ ] Tech stack prompt correctly identifies Express.js projects
- [ ] Overview prompt generates useful summaries even with minimal README
- [ ] Functions prompt documents every exported function in a file
- [ ] AIreadme generates a well-formatted markdown README
- [ ] Full `extractAll` pipeline runs all 4 extractions without crashing
- [ ] Firestore is updated with extraction results + AIreadme
- [ ] `POST /api/ai/extract/:repoId` returns immediately (background processing)
- [ ] `GET /api/ai/extract/:repoId` returns cached results
- [ ] Error in one prompt doesn't fail the entire pipeline
- [ ] Test with the two example repos: TaskTracker (Express API) and MarkdownLive (Markdown previewer)

---

## 12. File Structure Summary

```
server/src/ai/
├── openrouter.ts           ← You build: OpenRouter API client
├── extraction.ts           ← You build: Orchestrates all 4 extractions
├── prompts/
│   ├── techStack.ts        ← You build: Tech stack prompt
│   ├── overview.ts         ← You build: Overview prompt
│   ├── functions.ts        ← You build: Function docs prompt
│   └── aiReadme.ts         ← You build: AIreadme prompt
└── (types come from ../types/index.ts)
server/src/routes/
└── ai.ts                   ← You build: POST + GET /api/ai/extract/:repoId
```

---

## Summary

You build the AI brains. Engineer A builds the skeleton. Together: the backend.

**Start with `openrouter.ts` (the foundation), then build each prompt one by one, then the orchestrator, then the routes. Test each piece individually before integrating.**