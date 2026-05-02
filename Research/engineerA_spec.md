# Engineer A — Complete Backend Specification for DevHub

> **Paste this entire document into a fresh AI chat session to give full context.**

---

## 1. What We're Building

**DevHub** is a multi-repo workspace platform where users:
1. Paste GitHub repo URLs
2. Repos get cloned inside **BrowserPod** (in-browser Node.js Wasm sandbox) by the frontend
3. The frontend sends all file contents to our **backend API**
4. Our backend uses **OpenRouter** (AI proxy) to analyze the code and generate documentation
5. Users can chat with an AI assistant about their repos at two levels: **workspace-wide** (all repos) and **repo-specific** (one repo)
6. Users can run the code in the browser sandbox and see a live preview via BrowserPod Portals

**No authentication, no users, no login.** Workspaces are public by URL.

---

## 2. Your Role — Engineer A

You build the **core infrastructure**: Express server, Firebase Firestore data layer, CRUD endpoints, and chat endpoints. Engineer B builds the AI extraction pipeline (OpenRouter prompts, extraction orchestrator) in the `server/src/ai/` folder.

### You own these files:
```
server/
├── src/
│   ├── index.ts              ← Express app entry point
│   ├── config.ts             ← Environment variable loader
│   ├── types/
│   │   └── index.ts          ← All TypeScript interfaces (shared with Engineer B)
│   ├── lib/
│   │   └── firebase.ts       ← Firestore helper functions
│   ├── routes/
│   │   ├── workspaces.ts     ← Workspace CRUD
│   │   ├── repos.ts          ← Repo CRUD + run/stop state
│   │   └── chat.ts           ← Repo chat + Workspace chat
│   └── ai/
│       └── prompts/
│           └── chatContext.ts ← Builds system prompt for chat (injects repo files)
├── package.json
├── tsconfig.json
├── .env
└── .gitignore
```

---

## 3. Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 22 |
| Framework | Express (TypeScript) |
| Database | Firebase Firestore |
| AI | OpenRouter (Engineer B provides the client at `../ai/openrouter.ts`) |
| Dev tools | ts-node, nodemon |

---

## 4. Environment Variables (`.env`)

```
PORT=3001
OPENROUTER_API_KEY=sk-or-v1-xxxxx
OPENROUTER_MODEL=deepseek/deepseek-v4-flash
FIREBASE_PROJECT_ID=your-firebase-project-id
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxxx@your-project.iam.gserviceaccount.com
CORS_ORIGIN=http://localhost:5173
```

---

## 5. TypeScript Interfaces (`src/types/index.ts`)

```typescript
export interface Workspace {
  workspaceId: string;
  name: string;
  description: string;
  createdAt: string; // ISO 8601
  repoCount?: number; // Computed, not stored in Firestore
}

export interface Repo {
  repoId: string;
  workspaceId: string;
  name: string; // Extracted from GitHub URL (last path segment, strip .git)
  githubUrl: string;
  status: "cloning" | "analyzing" | "ready" | "running" | "error";
  runnability: RunnabilityResult | null;
  analysis: ExtractionResult | null;
  aiReadme: string | null; // Markdown string
  portalUrl: string | null;
  createdAt: string; // ISO 8601
}

export interface RunnabilityResult {
  canRun: boolean;
  entryPoint: string | null; // e.g., "npm start"
  blockers: string[]; // e.g., ["Contains native binary: esbuild"]
}

export interface ExtractionResult {
  techStack: TechStack;
  overview: Overview;
  functions: FunctionDoc[];
  dependencies: Record<string, string>; // package name → version
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
  type: "function" | "class" | "method";
  file: string;
  line: number;
  signature: string;
  description: string;
  params: { name: string; type: string; description: string }[];
  returns: { type: string; description: string };
  throws: string[];
  dependencies: string[];
}

export interface ChatMessage {
  messageId: string;
  scopeType: "repo" | "workspace"; // Is this chat for a repo or a workspace?
  scopeId: string; // Either repoId or workspaceId
  role: "user" | "assistant";
  content: string;
  timestamp: string; // ISO 8601
}
```

---

## 6. Firebase Firestore — Exact Collections & Documents

### `workspaces` collection
```json
{
  "workspaceId": "abc-123-uuid",
  "name": "My Microservices",
  "description": "All backend services for the app",
  "createdAt": "2026-05-02T14:00:00.000Z"
}
```

### `repos` collection
```json
{
  "repoId": "def-456-uuid",
  "workspaceId": "abc-123-uuid",
  "name": "task-tracker",
  "githubUrl": "https://github.com/user/task-tracker",
  "status": "ready",
  "runnability": {
    "canRun": true,
    "entryPoint": "npm start",
    "blockers": []
  },
  "analysis": {
    "techStack": {
      "language": "JavaScript",
      "framework": "Express",
      "runtime": "Node.js",
      "buildTool": null,
      "testingFramework": null,
      "database": null,
      "otherTools": []
    },
    "overview": {
      "oneLiner": "A REST API for managing tasks",
      "summary": "Task Tracker is a lightweight REST API built with Express...",
      "purpose": "Task management",
      "targetUsers": "Developers"
    },
    "functions": [
      {
        "name": "getTasks",
        "type": "function",
        "file": "src/routes/tasks.js",
        "line": 5,
        "signature": "router.get('/', handler)",
        "description": "Returns all tasks as a JSON array",
        "params": [],
        "returns": { "type": "JSON array", "description": "Array of task objects" },
        "throws": [],
        "dependencies": []
      }
    ],
    "dependencies": {
      "express": "^4.18.0"
    }
  },
  "aiReadme": "# Task Tracker\n\n## Overview\n...",
  "portalUrl": null,
  "createdAt": "2026-05-02T14:05:00.000Z"
}
```

### `chat_messages` collection
```json
{
  "messageId": "ghi-789-uuid",
  "scopeType": "repo",
  "scopeId": "def-456-uuid",
  "role": "user",
  "content": "What does the getTasks function do?",
  "timestamp": "2026-05-02T14:10:00.000Z"
}
```

---

## 7. Every API Endpoint — Exact Specification

### 7.1 Health Check

```
GET /api/health
Response: { "status": "ok", "timestamp": "2026-05-02T14:00:00.000Z" }
```

---

### 7.2 Workspace Endpoints

#### `GET /api/workspaces`
List all workspaces. For each workspace, count how many repos belong to it (query `repos` collection where `workspaceId` matches).
```
Response: [
  {
    "workspaceId": "abc-123",
    "name": "My Project",
    "description": "A cool project",
    "createdAt": "2026-05-02T14:00:00.000Z",
    "repoCount": 3
  }
]
```

#### `POST /api/workspaces`
Create a new workspace. Generate a UUID for `workspaceId`. Set `createdAt` to current ISO timestamp.
```
Request:  { "name": "My Project", "description": "A cool project" }
Response: {
  "workspaceId": "generated-uuid",
  "name": "My Project",
  "description": "A cool project",
  "createdAt": "2026-05-02T14:00:00.000Z",
  "repoCount": 0
}
```

#### `GET /api/workspaces/:id`
Get a single workspace with all its repos. Query all repos where `workspaceId === :id`.
```
Response: {
  "workspaceId": "abc-123",
  "name": "My Project",
  "description": "A cool project",
  "createdAt": "2026-05-02T14:00:00.000Z",
  "repos": [
    {
      "repoId": "def-456",
      "name": "task-tracker",
      "githubUrl": "https://github.com/user/task-tracker",
      "status": "ready",
      "runnability": { "canRun": true, "entryPoint": "npm start", "blockers": [] },
      "portalUrl": null,
      "createdAt": "2026-05-02T14:05:00.000Z"
    }
  ]
}
```

#### `DELETE /api/workspaces/:id`
Delete workspace AND all its child repos AND all chat messages scoped to this workspace.
```
Response: { "success": true }
```
Algorithm:
1. Query all repos where `workspaceId === :id`
2. For each repo, query + delete all chat messages where `scopeId === repo.repoId`
3. Delete all repos
4. Delete the workspace doc
5. Return success

---

### 7.3 Repo Endpoints

#### `POST /api/workspaces/:id/repos`
Add a repo to a workspace. Extract the repo name from the GitHub URL: take the last path segment, strip `.git` suffix. Generate UUID for `repoId`. Set `status: "cloning"`.
```
Request:  { "githubUrl": "https://github.com/user/task-tracker" }
Response: {
  "repoId": "generated-uuid",
  "workspaceId": "abc-123",
  "name": "task-tracker",
  "githubUrl": "https://github.com/user/task-tracker",
  "status": "cloning",
  "createdAt": "2026-05-02T14:05:00.000Z"
}
```
Validation:
- `githubUrl` must start with `https://github.com/`
- Return 400 if invalid

#### `GET /api/repos/:id`
Get full repo document from Firestore.
```
Response: Full Repo object as stored in Firestore (all fields including analysis, aiReadme, etc.)
```

#### `DELETE /api/repos/:id`
Delete repo AND all its chat messages.
```
Response: { "success": true }
```

#### `POST /api/repos/:id/run`
Called by the frontend when the user clicks "Run". The frontend already started the pod and captured the Portal URL — it just tells us to log the state.
```
Request:  { "portalUrl": "https://xyz-3000.browserportal.io" }
Response: { "success": true }
```
Action: Update the Firestore repo doc: `{ status: "running", portalUrl: body.portalUrl }`

#### `POST /api/repos/:id/stop`
Called by the frontend when the user clicks "Stop".
```
Request:  (empty body)
Response: { "success": true }
```
Action: Update the Firestore repo doc: `{ status: "ready", portalUrl: null }`

---

### 7.4 Chat Endpoints

#### `POST /api/chat/repo/:repoId`
Send a message in a repo-scoped chat. The AI gets the repo's full source code as context.
```
Request:  { "message": "What does server.js do?" }
Response: { "reply": "server.js is the entry point of the application..." }
```
Algorithm:
1. Get the repo doc from Firestore
2. Get the last 20 chat messages for this repo (scopeType="repo", scopeId=repoId, ordered by timestamp ASC)
3. Build a system prompt that includes:
   - "You are a code expert assistant. You have access to the full source code of this repository."
   - The repo's file contents (from `repo.analysis` — inject the overview, tech stack, and function docs)
   - The last 20 messages as conversation history
4. Call `callOpenRouter(userMessage, systemPrompt)` — this function is provided by Engineer B at `../ai/openrouter.ts`
5. Save user message to `chat_messages` collection: `{ messageId: uuid, scopeType: "repo", scopeId: repoId, role: "user", content: req.body.message, timestamp: now }`
6. Save AI reply: `{ messageId: uuid, scopeType: "repo", scopeId: repoId, role: "assistant", content: reply, timestamp: now }`
7. Return `{ reply }`

#### `GET /api/chat/repo/:repoId`
Get all chat messages for a repo.
```
Response: [
  { "messageId": "msg-1", "scopeType": "repo", "scopeId": "def-456", "role": "user", "content": "What does server.js do?", "timestamp": "..." },
  { "messageId": "msg-2", "scopeType": "repo", "scopeId": "def-456", "role": "assistant", "content": "server.js is the entry point...", "timestamp": "..." }
]
```
Algorithm: Query `chat_messages` where `scopeType === "repo"` AND `scopeId === :repoId`, ordered by `timestamp` ASC.

#### `POST /api/chat/workspace/:wsId`
Send a message in a workspace-scoped chat. The AI gets ALL repos' source code as context.
```
Request:  { "message": "How do these repos relate to each other?" }
Response: { "reply": "The task-tracker handles the API, while markdown-live provides the UI..." }
```
Algorithm:
1. Get workspace doc
2. Query all repos in this workspace (where `workspaceId === :wsId`)
3. Get the last 20 chat messages for this workspace (scopeType="workspace", scopeId=wsId)
4. Build system prompt:
   - "You are a code expert. You have access to ALL repositories in this workspace."
   - Inject each repo's name, overview, tech stack, and function docs
   - Include last 20 messages as conversation history
5. Call `callOpenRouter(userMessage, systemPrompt)`
6. Save user message + AI reply to `chat_messages`
7. Return `{ reply }`

#### `GET /api/chat/workspace/:wsId`
Get all chat messages for a workspace.
```
Response: Array of ChatMessage objects
```
Algorithm: Query `chat_messages` where `scopeType === "workspace"` AND `scopeId === :wsId`, ordered by `timestamp` ASC.

---

## 8. Firebase Helper Functions (`src/lib/firebase.ts`)

You must create these reusable helper functions that both you and Engineer B will use:

```typescript
import * as admin from 'firebase-admin';
import { config } from '../config';

// Initialize Firebase Admin SDK once
const app = admin.initializeApp({
  credential: admin.credential.cert({
    projectId: config.firebase.projectId,
    privateKey: config.firebase.privateKey,
    clientEmail: config.firebase.clientEmail,
  }),
});

export const db = admin.firestore();

// Get a Firestore collection reference
export function getCollection(name: string) {
  return db.collection(name);
}

// Get a single document by ID, returns null if not found
export async function getDoc(collection: string, id: string) {
  const doc = await db.collection(collection).doc(id).get();
  if (!doc.exists) return null;
  return { ...doc.data(), [`${collection.slice(0, -1)}Id`]: doc.id } as any;
}

// Create or overwrite a document (pass merge: true in options to update)
export async function setDoc(collection: string, id: string, data: any) {
  await db.collection(collection).doc(id).set(data);
}

// Query documents by field
export async function queryDocs(
  collection: string,
  field: string,
  operator: FirebaseFirestore.WhereFilterOp,
  value: any
) {
  const snapshot = await db.collection(collection).where(field, operator, value).get();
  return snapshot.docs.map(doc => ({ ...doc.data(), id: doc.id }));
}

// Delete a document
export async function deleteDoc(collection: string, id: string) {
  await db.collection(collection).doc(id).delete();
}
```

Note: Engineer B will call `setDoc` and `getDoc` from this file. Engineer B will provide `callOpenRouter` at `../ai/openrouter.ts` which you will import in chat routes.

---

## 9. Config File (`src/config.ts`)

```typescript
import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  firebase: {
    projectId: process.env.FIREBASE_PROJECT_ID!,
    privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL!,
  },
  openrouter: {
    apiKey: process.env.OPENROUTER_API_KEY!,
    model: process.env.OPENROUTER_MODEL || 'deepseek/deepseek-v4-flash',
  },
};
```

---

## 10. Express App Entry Point (`src/index.ts`)

```typescript
import express from 'express';
import cors from 'cors';
import { config } from './config';
import workspaceRoutes from './routes/workspaces';
import repoRoutes from './routes/repos';
import chatRoutes from './routes/chat';
import aiRoutes from './routes/ai'; // Engineer B builds this, but you mount it

const app = express();

app.use(cors({ origin: config.corsOrigin }));
app.use(express.json({ limit: '5mb' })); // Large because files are sent in body

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Routes
app.use('/api', workspaceRoutes);
app.use('/api', repoRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/ai', aiRoutes); // Engineer B's routes

// Error handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error', details: err.message });
});

app.listen(config.port, () => {
  console.log(`Server running on http://localhost:${config.port}`);
});
```

---

## 11. Step-by-Step Build Order

### Step 1: Project Scaffold (30 min)
1. Create `server/` directory
2. `npm init -y`
3. Install: `npm install express cors dotenv uuid firebase-admin`
4. Install dev: `npm install -D typescript @types/node @types/express @types/cors @types/uuid ts-node nodemon`
5. Create `tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```
6. Add to `package.json`:
```json
"scripts": {
  "dev": "nodemon --exec ts-node src/index.ts",
  "build": "tsc",
  "start": "node dist/index.js"
}
```
7. Create `.env` with real values
8. Create `.gitignore`: `node_modules/`, `dist/`, `.env`

### Step 2: Types (15 min)
1. Create `src/types/index.ts` — copy all interfaces from Section 5 above

### Step 3: Config (10 min)
1. Create `src/config.ts` — copy from Section 9

### Step 4: Firebase Lib (30 min)
1. Create `src/lib/firebase.ts` — copy from Section 8
2. Test by writing a small script that connects to Firestore

### Step 5: Workspace Routes (1 hour)
1. Create `src/routes/workspaces.ts` with all 4 endpoints from Section 7.2
2. Test each endpoint with curl:
```bash
curl -X POST http://localhost:3001/api/workspaces \
  -H "Content-Type: application/json" \
  -d '{"name":"Test Workspace","description":"Testing"}'

curl http://localhost:3001/api/workspaces

curl http://localhost:3001/api/workspaces/<id>

curl -X DELETE http://localhost:3001/api/workspaces/<id>
```

### Step 6: Repo Routes (1 hour)
1. Create `src/routes/repos.ts` with all 5 endpoints from Section 7.3
2. Test each with curl:
```bash
curl -X POST http://localhost:3001/api/workspaces/<wsId>/repos \
  -H "Content-Type: application/json" \
  -d '{"githubUrl":"https://github.com/user/task-tracker"}'

curl http://localhost:3001/api/repos/<repoId>

curl -X DELETE http://localhost:3001/api/repos/<repoId>

curl -X POST http://localhost:3001/api/repos/<repoId>/run \
  -H "Content-Type: application/json" \
  -d '{"portalUrl":"https://xyz-3000.browserportal.io"}'

curl -X POST http://localhost:3001/api/repos/<repoId>/stop
```

### Step 7: Chat Context Builder (30 min)
1. Create `src/ai/prompts/chatContext.ts` — a function `buildChatSystemPrompt(scope)` that takes either a repo or workspace context and returns a system prompt string
2. For repo chat: read repo.analysis (overview + functions + techStack) and inject into prompt
3. For workspace chat: read all repos' analysis and inject all of them

### Step 8: Chat Routes (1.5 hours)
1. Create `src/routes/chat.ts` with all 4 endpoints from Section 7.4
2. Import `callOpenRouter` from Engineer B's `../ai/openrouter.ts` (he must build this first — coordinate)
3. Test with curl:
```bash
curl -X POST http://localhost:3001/api/chat/repo/<repoId> \
  -H "Content-Type: application/json" \
  -d '{"message":"What does this project do?"}'

curl http://localhost:3001/api/chat/repo/<repoId>

curl -X POST http://localhost:3001/api/chat/workspace/<wsId> \
  -H "Content-Type: application/json" \
  -d '{"message":"How do these repos relate?"}'

curl http://localhost:3001/api/chat/workspace/<wsId>
```

### Step 9: Integration (30 min)
1. Mount Engineer B's AI routes (`import aiRoutes from './routes/ai'`)
2. Test the AI extraction endpoint:
```bash
curl -X POST http://localhost:3001/api/ai/extract/<repoId> \
  -H "Content-Type: application/json" \
  -d '{"fileTree":"src/\n  index.js\npackage.json","files":[{"path":"package.json","content":"..."},{"path":"src/index.js","content":"..."}]}'

curl http://localhost:3001/api/ai/extract/<repoId>
```

### Step 10: Deploy (1 hour)
1. Deploy to Railway or Render
2. Set all env vars in deployment dashboard
3. Update frontend's `VITE_API_URL` to deployed URL
4. Test full flow end-to-end

---

## 12. What Engineer B Provides (You Import These)

Engineer B will create these files you depend on:

### `server/src/ai/openrouter.ts`
```typescript
export async function callOpenRouter(
  userMessage: string,
  systemPrompt: string,
  model?: string
): Promise<string>;

export async function callOpenRouterStructured<T>(
  userMessage: string,
  systemPrompt: string,
  jsonSchema: object
): Promise<T>;
```

### `server/src/routes/ai.ts`
```typescript
// POST /api/ai/extract/:repoId — triggers AI code analysis
// GET /api/ai/extract/:repoId — returns cached results
// You just mount this router in index.ts
const router = Router();
export default router;
```

---

## 13. How the Frontend Calls You

### Flow 1: User Creates Workspace
```
Frontend: POST /api/workspaces { name, description }
Backend:  Creates workspace doc in Firestore, returns workspace with ID
```

### Flow 2: User Adds Repo
```
Frontend: POST /api/workspaces/:wsId/repos { githubUrl }
Backend:  Creates repo doc with status "cloning", returns repo
Frontend: Boots BrowserPod, runs git clone
Frontend: Reads file tree + all file contents from pod
Frontend: POST /api/ai/extract/:repoId { fileTree, files[] } → triggers AI analysis
Frontend: Polls GET /api/repos/:repoId until status !== "analyzing"
```

### Flow 3: User Clicks Run
```
Frontend: BrowserPod runs npm install + npm start, captures Portal URL
Frontend: POST /api/repos/:repoId/run { portalUrl }
Backend:  Updates repo status to "running", saves portalUrl
```

### Flow 4: User Chats
```
Frontend: POST /api/chat/repo/:repoId { message }
Backend:  Builds system prompt with repo context, calls OpenRouter, returns reply
Frontend: Shows reply in chat UI
```

---

## 14. npm Packages (Complete List)

```json
{
  "dependencies": {
    "express": "^4.21.0",
    "cors": "^2.8.5",
    "dotenv": "^16.4.0",
    "uuid": "^10.0.0",
    "firebase-admin": "^12.0.0"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "@types/node": "^22.0.0",
    "@types/express": "^5.0.0",
    "@types/cors": "^2.8.17",
    "@types/uuid": "^10.0.0",
    "ts-node": "^10.9.0",
    "nodemon": "^3.1.0"
  }
}
```

---

## 15. Checklist (Do In Order)

- [ ] Step 1: Create `server/` directory, `npm init`, install all deps
- [ ] Step 2: Create `tsconfig.json`, `.env`, `.gitignore`, `package.json` scripts
- [ ] Step 3: Create `src/types/index.ts` with all interfaces
- [ ] Step 4: Create `src/config.ts` 
- [ ] Step 5: Create `src/lib/firebase.ts` with Firestore helpers
- [ ] Step 6: Create `src/index.ts` — Express app with CORS + health check + route mounting
- [ ] Step 7: Create `src/routes/workspaces.ts` — 4 endpoints
- [ ] Step 8: Create `src/routes/repos.ts` — 5 endpoints
- [ ] Step 9: Test all CRUD with curl
- [ ] Step 10: Coordinate with Engineer B — get the path to their `callOpenRouter` function
- [ ] Step 11: Create `src/ai/prompts/chatContext.ts` — system prompt builder
- [ ] Step 12: Create `src/routes/chat.ts` — 4 endpoints (depends on Engineer B's openrouter.ts)
- [ ] Step 13: Mount Engineer B's AI routes in `index.ts`
- [ ] Step 14: Test full flow with curl
- [ ] Step 15: Deploy backend to Railway/Render
- [ ] Step 16: Update frontend's `VITE_API_URL`

---

## 16. Firestore Indexes (If Needed)

Firebase may require composite indexes for queries. If you get index errors, create these:

- `chat_messages`: `scopeType` ASC, `scopeId` ASC, `timestamp` ASC
- `repos`: `workspaceId` ASC, `createdAt` ASC

Run these commands or create via Firebase Console UI.

---

## 17. Error Handling Rules

- Every endpoint wrapped in try/catch
- 400: Bad request (missing fields, invalid URL)
- 404: Document not found
- 500: Internal error (log full error, return `{ error: string }`)
- Never crash the server on a single request error
- Log all errors with `console.error`

---

## 18. CORS

The frontend runs on Vite dev server (port 5173). Configure CORS to allow that origin. In production, update to the Vercel deployment URL.

```typescript
app.use(cors({ origin: config.corsOrigin }));
```

---

## Summary

You build the skeleton + data layer + chat. Engineer B builds the AI brains. Together: the backend that powers DevHub.

**Start with Step 1 and work through the checklist. Everything you need is in this document.**