Good call — two engineers on the backend means we can ship faster. The key is splitting along a **low-dependency boundary** so neither blocks the other. Here's the split:

---

## Backend Engineer Split (Parallel, Minimal Blocking)

### 👷 Backend Engineer A: **Core Infrastructure + Data Layer + Chat**
Owns: `server/src/`

| # | Task | Hours |
|---|------|-------|
| A1 | Scaffold Express + TS project, folder structure, middleware, CORS, env config | 1h |
| A2 | Firebase Admin SDK setup, Firestore helper functions (get/set/query/delete) | 1h |
| A3 | Workspace CRUD endpoints | 1.5h |
| A4 | Repo CRUD endpoints (add repo to workspace, get repo, delete repo) | 1.5h |
| A5 | Run/stop state endpoints | 0.5h |
| A6 | Chat message CRUD (save messages to Firestore, retrieve history) | 1h |
| A7 | Workspace chat endpoint (`POST /api/chat/workspace/:wsId`) — context builder that compiles ALL repos' source into a system prompt, calls OpenRouter, saves + returns reply | 2h |
| A8 | Repo chat endpoint (`POST /api/chat/repo/:repoId`) — same but scoped to one repo | 1.5h |
| A9 | Deploy + test all endpoints | 1h |

**~11 hours**

### 👷 Backend Engineer B: **AI & Extraction Pipeline**
Owns: `server/src/ai/`

| # | Task | Hours |
|---|------|-------|
| B1 | OpenRouter client wrapper (helper to call any model with any prompt, handle errors, parse JSON responses) | 1.5h |
| B2 | Write **Tech Stack extraction prompt** — takes package.json + file tree → JSON with languages, frameworks, tools | 1h |
| B3 | Write **Project Overview extraction prompt** — takes README + package.json + key files → 2-3 paragraph summary JSON | 1h |
| B4 | Write **Function-level extraction prompt** — takes source files → JSON array of all functions/classes with name, signature, description, inputs/outputs, dependencies | 1.5h |
| B5 | Write **AIreadme generation prompt** — takes all extraction results → comprehensive markdown README with setup, architecture, API reference, env vars, contributing | 1.5h |
| B6 | Build `POST /api/ai/extract/:repoId` endpoint — receives file tree + file contents from frontend, orchestrates all extraction prompts, stores results in Firestore | 2h |
| B7 | Build `GET /api/ai/extract/:repoId` — returns cached extraction data + AIreadme from Firestore | 0.5h |
| B8 | Test extraction pipeline with real repos (TaskTracker, MarkdownLive) | 1h |

**~10 hours**

---

## Dependency Chain

```
Hour 0:
  Engineer A begins A1 (scaffold)       ← BLOCKS EVERYONE for ~1 hour
  Engineer B waits or helps research

Hour 1:
  Engineer A: A2 (Firebase) + A3 (Workspace CRUD)    ← Frontend needs this first
  Engineer B: B1 (OpenRouter client)                  ← No dependency on A yet

Hour 2:
  Engineer A: A4 (Repo CRUD)                          ← Frontend needs this next
  Engineer B: B2, B3 (extraction prompts)             ← Works independently

Hour 4-8:
  Engineer A: A6, A7, A8 (Chat endpoints)             ← Uses B's OpenRouter client (B1)
  Engineer B: B4, B5, B6 (Extraction endpoint)        ← Uses A's Firestore helpers (A2)

  Only dependency: B1 (OpenRouter client) and A2 (Firestore) — both done by hour 2.
  After that: ZERO blocking. Both work in their own files.
```

---

## Shared Contract (The Handshake)

Both engineers agree on these interfaces so their code plugs together:

```typescript
// Engineer A provides (in server/src/lib/firebase.ts):
async function saveWorkspace(data): Promise<string>
async function getWorkspace(id): Promise<Workspace | null>
async function listWorkspaces(): Promise<Workspace[]>
async function saveRepo(data): Promise<string>
async function getRepo(id): Promise<Repo | null>
async function saveChatMessage(data): Promise<void>
async function getChatMessages(scopeId, scopeType): Promise<ChatMessage[]>

// Engineer B provides (in server/src/lib/openrouter.ts):
async function callOpenRouter(prompt: string, systemPrompt?: string): Promise<string>
async function callOpenRouterStructured<T>(prompt: string, systemPrompt: string, schema: object): Promise<T>

// Engineer B provides (in server/src/ai/):
async function extractAll(repoFiles): Promise<ExtractionResult>
async function generateAiReadme(extractionResult): Promise<string>

// Engineer A uses B's stuff in chat endpoints:
import { callOpenRouter } from '../ai/openrouter'
import { extractAll } from '../ai/extraction'
```

---

## File Structure (Clear Ownership)

```
server/
├── src/
│   ├── index.ts              → A: Express app entry
│   ├── config.ts             → A: Env vars (shared)
│   ├── lib/
│   │   └── firebase.ts       → A: Firestore helpers
│   ├── routes/
│   │   ├── workspaces.ts     → A: Workspace CRUD
│   │   ├── repos.ts          → A: Repo CRUD + run/stop
│   │   ├── chat.ts           → A: Chat endpoints
│   │   └── ai.ts             → B: AI extraction endpoints
│   ├── ai/
│   │   ├── openrouter.ts     → B: OpenRouter client
│   │   ├── prompts/
│   │   │   ├── techStack.ts      → B
│   │   │   ├── overview.ts       → B
│   │   │   ├── functions.ts      → B
│   │   │   ├── aiReadme.ts       → B
│   │   │   └── chatContext.ts    → A (builds system prompt for chat)
│   │   ├── extraction.ts     → B: Orchestrates all extraction
│   │   └── types.ts          → B: Extraction result types
│   └── types/
│       └── index.ts          → Shared: Workspace, Repo, ChatMessage types
├── package.json
├── tsconfig.json
└── .env
```

---

## Summary

- **Engineer A**: Everything the frontend talks to directly (CRUD + chat endpoints). Owns Firebase, routes, deployment.
- **Engineer B**: Everything AI (OpenRouter, extraction prompts, AIreadme). Owns the `ai/` folder.
- **Only dependency**: Engineer A finishes Firebase helpers (1h), Engineer B finishes OpenRouter client (1.5h). After that — fully parallel.
- **Shared types** (`types/index.ts`) should be agreed on at the start so both can code against the same shapes.

---

When you're ready, toggle to **ACT mode**. I'll scaffold the shared structure + types first (both engineers can start from it), then I'll work through Engineer A's tasks while you or your partner works on Engineer B's tasks in parallel.