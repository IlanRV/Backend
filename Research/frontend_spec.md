# Frontend Engineer — Complete Frontend Specification for DevHub

> **Paste this entire document into Replit Agent (or any AI coding tool) to build the frontend.**

---

## 1. What We're Building

**DevHub** is a multi-repo workspace platform where users:
1. Paste GitHub repo URLs
2. Repos get cloned inside **BrowserPod** (in-browser Node.js Wasm sandbox)
3. Browse repo files in a GitHub-style file viewer (Monaco Editor)
4. Run the project in-browser and see a live preview via BrowserPod Portals
5. Chat with an AI assistant about repos (workspace-wide and repo-specific)
6. View AI-generated documentation (AIreadme, tech stack, function docs)

**No authentication, no users, no login.** Anyone lands on `/dashboard` and starts using it.

**This is the frontend only.** It calls a REST API backend (Express + Firebase + OpenRouter) that's being built separately by 2 backend engineers.

---

## 2. Tech Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Build tool | Vite | latest |
| UI framework | React | 18+ |
| Language | TypeScript | strict mode |
| Styling | Tailwind CSS | v3 |
| Components | shadcn/ui | latest |
| Code editor | `@monaco-editor/react` | latest |
| Sandbox | `@leaningtech/browserpod` | v2.0 |
| Icons | `lucide-react` | latest |
| Toasts | `sonner` | latest |
| HTTP | `fetch` (native) | — |
| Routing | `react-router-dom` | v6 |

---

## 3. Environment Variables (`.env`)

```
VITE_BP_APIKEY=bp_xxxxxxxxxxxxxxxxxxxxx
VITE_API_URL=http://localhost:3001/api
```

Get the BrowserPod API key from https://console.browserpod.io

---

## 4. Vite Config (CRITICAL — BrowserPod won't boot without this)

```typescript
// vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
```

Without these headers, `SharedArrayBuffer` is unavailable and BrowserPod **will not boot**.

---

## 5. TypeScript Interfaces (`src/types/index.ts`)

```typescript
export interface Workspace {
  workspaceId: string;
  name: string;
  description: string;
  createdAt: string;
  repoCount?: number;
}

export interface Repo {
  repoId: string;
  workspaceId: string;
  name: string;
  githubUrl: string;
  status: 'cloning' | 'analyzing' | 'ready' | 'running' | 'error';
  runnability: RunnabilityResult | null;
  analysis: ExtractionResult | null;
  aiReadme: string | null;
  portalUrl: string | null;
  createdAt: string;
}

export interface RunnabilityResult {
  canRun: boolean;
  entryPoint: string | null;
  blockers: string[];
}

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

export interface ChatMessage {
  messageId: string;
  scopeType: 'repo' | 'workspace';
  scopeId: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}
```

---

## 6. API Client (`src/lib/api.ts`)

```typescript
const API_URL = import.meta.env.VITE_API_URL;

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// Workspaces
export const getWorkspaces = () => request<Workspace[]>('/workspaces');
export const createWorkspace = (data: { name: string; description: string }) =>
  request<Workspace>('/workspaces', { method: 'POST', body: JSON.stringify(data) });
export const getWorkspace = (id: string) => request<Workspace & { repos: Repo[] }>(`/workspaces/${id}`);
export const deleteWorkspace = (id: string) => request<{ success: boolean }>(`/workspaces/${id}`, { method: 'DELETE' });

// Repos
export const addRepo = (workspaceId: string, githubUrl: string) =>
  request<Repo>(`/workspaces/${workspaceId}/repos`, { method: 'POST', body: JSON.stringify({ githubUrl }) });
export const getRepo = (id: string) => request<Repo>(`/repos/${id}`);
export const deleteRepo = (id: string) => request<{ success: boolean }>(`/repos/${id}`, { method: 'DELETE' });
export const runRepo = (id: string, portalUrl: string) =>
  request<{ success: boolean }>(`/repos/${id}/run`, { method: 'POST', body: JSON.stringify({ portalUrl }) });
export const stopRepo = (id: string) =>
  request<{ success: boolean }>(`/repos/${id}/stop`, { method: 'POST' });

// AI
export const extractRepo = (repoId: string, fileTree: string, files: { path: string; content: string }[]) =>
  request<{ success: boolean }>(`/ai/extract/${repoId}`, { method: 'POST', body: JSON.stringify({ fileTree, files }) });
export const getExtraction = (repoId: string) =>
  request<ExtractionResult & { aiReadme: string | null }>(`/ai/extract/${repoId}`);

// Chat
export const sendRepoMessage = (repoId: string, message: string) =>
  request<{ reply: string }>(`/chat/repo/${repoId}`, { method: 'POST', body: JSON.stringify({ message }) });
export const getRepoMessages = (repoId: string) => request<ChatMessage[]>(`/chat/repo/${repoId}`);
export const sendWorkspaceMessage = (workspaceId: string, message: string) =>
  request<{ reply: string }>(`/chat/workspace/${workspaceId}`, { method: 'POST', body: JSON.stringify({ message }) });
export const getWorkspaceMessages = (workspaceId: string) => request<ChatMessage[]>(`/chat/workspace/${workspaceId}`);
```

---

## 7. BrowserPod Manager (`src/lib/browserpod.ts`)

This is the core file that manages BrowserPod instances. Each repo gets its own pod.

```typescript
import { BootedPod } from '@leaningtech/browserpod';

const apiKey = import.meta.env.VITE_BP_APIKEY;

// Store active pods: repoId → BootedPod
const activePods = new Map<string, BootedPod>();

export async function createPod(repoId: string): Promise<BootedPod> {
  const { BrowserPod } = await import('@leaningtech/browserpod');
  const pod = await BrowserPod.boot({ apiKey });
  activePods.set(repoId, pod);
  return pod;
}

export async function cloneRepo(pod: BootedPod, githubUrl: string): Promise<void> {
  await pod.run('git', ['clone', githubUrl, '/repo']);
}

export async function getFileTree(pod: BootedPod): Promise<string> {
  const process = await pod.run('find', ['/repo', '-type', 'f', '-not', '-path', '*/node_modules/*', '-not', '-path', '*/.git/*']);
  let output = '';
  await process.waitOnStdout((line: string) => { output += line + '\n'; });
  await process.exited;
  return output;
}

export async function readFile(pod: BootedPod, path: string): Promise<string> {
  const process = await pod.run('cat', [path]);
  let content = '';
  await process.waitOnStdout((line: string) => { content += line + '\n'; });
  await process.exited;
  return content;
}

export async function readPackageJson(pod: BootedPod): Promise<any> {
  const content = await readFile(pod, '/repo/package.json');
  return JSON.parse(content);
}

export async function checkRunnability(pod: BootedPod): Promise<RunnabilityResult> {
  try {
    const pkg = await readPackageJson(pod);
    const blockers: string[] = [];
    const NATIVE_BLACKLIST = [
      'esbuild', 'sharp', 'bcrypt', 'node-gyp', 'puppeteer',
      'canvas', 'sqlite3', 'better-sqlite3', 'electron',
      'node-sass', '@swc/core', 'fibers', 'rollup'
    ];

    // Check for native binary deps
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const dep of NATIVE_BLACKLIST) {
      if (allDeps[dep]) blockers.push(`Contains native binary: ${dep}`);
    }

    // Check engines.node
    if (pkg.engines?.node) {
      const version = pkg.engines.node.replace(/[^0-9.]/g, '');
      if (parseFloat(version) > 22) blockers.push(`Requires Node.js ${version} (pod has Node 22)`);
    }

    // Find entry point
    const scripts = pkg.scripts || {};
    const entryPoint = scripts.dev ? 'npm run dev' : scripts.start ? 'npm start' : scripts.serve ? 'npm run serve' : null;
    if (!entryPoint) blockers.push('No dev, start, or serve script found');

    return { canRun: blockers.length === 0, entryPoint, blockers };
  } catch {
    return { canRun: false, entryPoint: null, blockers: ['package.json not found or invalid'] };
  }
}

export async function installDeps(pod: BootedPod): Promise<void> {
  const process = await pod.run('npm', ['install'], { cwd: '/repo' });
  await process.exited;
}

export async function startProject(pod: BootedPod, entryPoint: string): Promise<void> {
  const [cmd, ...args] = entryPoint.split(' ');
  // entryPoint is like "npm run dev" → run npm with args ["run", "dev"]
  const process = await pod.run(cmd, args.slice(1), { cwd: '/repo' });
  // Don't await — it's a long-running process
}

export function onPortal(pod: BootedPod, callback: (url: string) => void): void {
  pod.onPortal(({ url }: { url: string }) => callback(url));
}

export function destroyPod(repoId: string): void {
  const pod = activePods.get(repoId);
  if (pod) {
    pod.close();
    activePods.delete(repoId);
  }
}

export function getPod(repoId: string): BootedPod | undefined {
  return activePods.get(repoId);
}
```

---

## 8. Routes

```
/                           → Redirect to /dashboard
/dashboard                  → Grid of workspace cards + Create Workspace button
/workspace/:workspaceId     → Workspace detail (repo list + workspace chat)
/workspace/:workspaceId/repo/:repoId → Repo detail (file viewer + run + repo chat)
```

---

## 9. Pages — Detailed Specifications

### 9.1 Dashboard Page (`/dashboard`)

**Layout:**
```
┌─────────────────────────────────────────┐
│  [Navbar: DevHub logo | New Workspace]  │
├─────────────────────────────────────────┤
│                                         │
│  ┌──────────┐  ┌──────────┐  ┌──────┐  │
│  │Workspace │  │Workspace │  │  +   │  │
│  │  Card    │  │  Card    │  │ New  │  │
│  │3 repos   │  │1 repo    │  │      │  │
│  └──────────┘  └──────────┘  └──────┘  │
│                                         │
└─────────────────────────────────────────┘
```

**States:**
- **Loading**: 3 skeleton cards (pulsing gray rectangles)
- **Empty**: "No workspaces yet. Create your first workspace to get started." with a big "Create Workspace" button
- **Error**: "Failed to load workspaces" with retry button
- **Data**: Grid of workspace cards

**Create Workspace Modal:**
- Two fields: name (required), description (optional)
- Submit calls `POST /api/workspaces`
- On success: toast "Workspace created", navigate to `/workspace/:newId`
- On error: toast with error message

**Workspace Card:**
- Shows name, description (truncated if long), "X repos" badge
- Click navigates to `/workspace/:workspaceId`
- Right-click or "..." menu: Delete option (with confirmation dialog)

---

### 9.2 Workspace Page (`/workspace/:workspaceId`)

**Layout:**
```
┌──────────────────────────────────────────────────────────┐
│  [Navbar: ← Back | Workspace Name          | Delete WS]  │
├─────────────────────────┬────────────────────────────────┤
│  LEFT PANEL (40%)       │  RIGHT PANEL (60%)             │
│                         │                                │
│  Repos in this WS:      │  💬 Workspace Chat             │
│  ┌──────────────────┐   │  ┌─────────────────────────┐  │
│  │ task-tracker     │   │  │ AI: All repos context...│  │
│  │ ● ready  ▶ Run   │   │  │ User: How do these...   │  │
│  └──────────────────┘   │  │ AI: The task-tracker...  │  │
│  ┌──────────────────┐   │  │                         │  │
│  │ markdown-live    │   │  │ [Type message...] [Send]│  │
│  │ ● analyzing      │   │  └─────────────────────────┘  │
│  └──────────────────┘   │                                │
│                         │                                │
│  [+ Add Repo] button    │                                │
└─────────────────────────┴────────────────────────────────┘
```

**Repo Card in Left Panel:**
- Repo name (bold), status badge (colored dot + text: cloning=blue, analyzing=yellow, ready=green, running=green pulse, error=red)
- If `runnability.canRun === true`: show green "▶ Run" text or icon (clicking navigates to repo page — Run happens on repo page)
- If `runnability.canRun === false`: show subtle "Can't run" indicator with tooltip listing blockers
- "AI Readme" badge if `aiReadme` is not null
- Click navigates to `/workspace/:workspaceId/repo/:repoId`

**Add Repo Modal:**
- Single input: GitHub URL
- Validates URL starts with `https://github.com/`
- On submit: calls `POST /api/workspaces/:workspaceId/repos`, returns repo with `status: "cloning"`
- Then immediately:
  1. Boots a new BrowserPod instance for this repo
  2. Runs `git clone <url> /repo`
  3. Reads file tree + all files from pod
  4. Calls `POST /api/ai/extract/:repoId` with file data → backend starts AI analysis
  5. Polls `GET /api/repos/:repoId` every 3 seconds until `status !== "analyzing" && status !== "cloning"`
- Shows progress in the modal: "Cloning repo..." → "Analyzing code with AI..." → "Ready!"
- On complete: close modal, repo card appears in list, toast "Repo added and analyzed"

**Workspace Chat (Right Panel):**
- Reusable ChatPanel component (see Section 10)
- Calls `GET /api/chat/workspace/:workspaceId` to load history
- Calls `POST /api/chat/workspace/:workspaceId` to send messages
- Context: backend injects ALL repos in workspace into the AI system prompt

---

### 9.3 Repo Detail Page (`/workspace/:workspaceId/repo/:repoId`)

**THIS IS THE MAIN PAGE — spend the most time here.**

**Layout:**
```
┌──────────────────────────────────────────────────────────────┐
│  [← Back to WS | repo-name | ● ready | ▶ Run | Stop | AI RD] │
├────────────────┬──────────────────────┬───────────────────────┤
│  FILE TREE     │  CODE VIEWER         │                       │
│  (left, 250px) │  (center, flex)      │                       │
│                │                      │                       │
│  📁 src/       │  1 │ const express   │                       │
│    📄 index.js │  2 │ const app = ..  │                       │
│    📁 routes/  │  3 │                 │                       │
│      📄 tasks. │  4 │ app.get('/'..   │                       │
│  📄 package.js │  5 │                 │                       │
│  📄 README.md  │                      │                       │
│                │                      │                       │
├────────────────┴──────────────────────┴───────────────────────┤
│  BOTTOM PANEL (tabs)                                         │
│  [Code | AI Readme | Live Preview | 💬 Chat]                 │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │ (Tab content here)                                       │ │
│  └──────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

**Top Bar:**
- Back button (← Back to workspace)
- Repo name (bold)
- Status badge
- "▶ Run" button (GREEN, shown only if `runnability.canRun === true` AND status is "ready")
- "⏹ Stop" button (RED, shown only if status is "running")
- "AI Readme" badge/tab shortcut
- Portal URL link (shown when running, copyable)

**File Tree (Left Sidebar):**
- Parse the file tree string (from pod or from extraction response) into nested structure
- Collapsible folders (click to expand/collapse)
- File icons based on extension: 📄 for files, 📁 for folders
- Click file → read file content from BrowserPod pod → display in Monaco Editor
- Active file highlighted
- Loading state while fetching file contents

**Code Viewer (Center):**
- Monaco Editor in read-only mode
- Syntax highlighting based on file extension:
  - `.js`, `.ts`, `.tsx`, `.jsx` → JavaScript/TypeScript
  - `.json` → JSON
  - `.md` → Markdown
  - `.css`, `.scss` → CSS
  - `.html` → HTML
  - `.py` → Python
  - `.yml`, `.yaml` → YAML
  - `.env` → plaintext
  - All others → plaintext
- Line numbers, minimap enabled
- "No file selected" state when nothing is clicked
- Loading state while fetching file

**Bottom Panel Tabs:**

**Tab 1: "Code"** — just shows the current file in Monaco (this is the default view, same as center panel essentially — can be a larger view of the code)

**Tab 2: "AI Readme"** — renders `repo.aiReadme` as markdown (use `react-markdown` or a simple markdown renderer). Should look like a nice README with headings, code blocks with syntax highlighting, etc.
- Empty state: "AI Readme is being generated..." (if status is "analyzing")
- Error state: "Failed to generate AI Readme"

**Tab 3: "Live Preview"** — if status is "running" and `portalUrl` is set, show the Portal URL in a full-width iframe:
```tsx
<iframe src={repo.portalUrl} className="w-full h-full border-0" />
```
- Not running state: "Run the project to see a live preview"
- Loading state while iframe loads

**Tab 4: "💬 Chat"** — Reusable ChatPanel component for repo-scoped chat
- Calls `GET /api/chat/repo/:repoId` for history
- Calls `POST /api/chat/repo/:repoId` to send

**Run Flow (when user clicks "▶ Run"):**
1. Update local state to show "Starting..."
2. Call `installDeps(pod)` (npm install)
3. Show terminal output in a collapsible console at the bottom
4. Call `startProject(pod, entryPoint)` (npm run dev)
5. Listen for portal URL via `pod.onPortal()`
6. Once portal URL received:
   a. Call `POST /api/repos/:repoId/run` with portalUrl
   b. Update local state: status = "running", show portal iframe
   c. Toast: "Project is running!"
7. If any step fails: toast error, set status back

**Stop Flow:**
1. Destroy the pod (kills the process)
2. Call `POST /api/repos/:repoId/stop`
3. Hide iframe, update status to "ready"
4. Create a new pod for the repo (so user can run again later)

---

## 10. ChatPanel Component (Reusable)

Used in both Workspace page (workspace chat) and Repo detail page (repo chat).

**Props:**
```typescript
interface ChatPanelProps {
  scopeType: 'repo' | 'workspace';
  scopeId: string;
}
```

**Behavior:**
- Loads chat history from the appropriate endpoint on mount
- Polls for new messages every 5 seconds (or simpler: just fetch on send and on mount)
- Message list: scrollable, auto-scrolls to bottom on new message
- User messages: right-aligned, blue/primary background bubble
- AI messages: left-aligned, gray background bubble, with AI avatar icon
- Input bar at bottom: text input + send button (or Enter to send)
- Empty state: "Ask a question about this repo/workspace"
- Loading state: "AI is thinking..." animated dots, disable input while waiting
- Error state: "Failed to send message. Retry?" button

**Message Bubble:**
```
User:                          AI:
┌──────────────────┐           ┌──────────────────────────┐
│ What does this   │           │ 🤖 This file is the      │
│ file do?         │           │ entry point...           │
└──────────────────┘           └──────────────────────────┘
```

---

## 11. Loading, Empty, Error States (CRITICAL)

**Every page must handle these 3 states:**

### Loading State
- Skeleton loaders (pulsing gray rectangles) matching the layout
- Use a `Skeleton` component from shadcn or custom

### Empty State
- Friendly message with icon
- Call-to-action button where applicable
- Examples:
  - Dashboard: "No workspaces yet. Create your first workspace!" + button
  - Workspace: "No repos yet. Add a repo to get started!" + button
  - File viewer: "Select a file from the tree to view its contents"
  - Chat: "Ask a question about this codebase"
  - AI Readme: "AI Readme will appear here after analysis"

### Error State
- Red/amber banner with error message
- "Retry" button
- Never show raw error objects — show user-friendly messages
- For API errors: "Failed to load data. Please try again."

---

## 12. Toast Notifications (sonner)

Use `sonner` for all toasts:

| Action | Toast |
|--------|-------|
| Workspace created | "Workspace 'My Project' created" |
| Workspace deleted | "Workspace deleted" |
| Repo added | "Repo 'task-tracker' added. Analyzing..." |
| Repo deleted | "Repo removed" |
| AI analysis complete | "Analysis complete for task-tracker" |
| AI analysis failed | "Failed to analyze repo" |
| Project started | "Project is running! Live preview available" |
| Project stopped | "Project stopped" |
| Message sent | (no toast needed — message appears in chat) |
| Error (any) | Toast with error message |
| Clipboard copied | "Portal URL copied to clipboard" |

---

## 13. UI Components (shadcn/ui)

Install these shadcn components:
```
button, card, input, dialog, badge, tabs, scroll-area, separator, 
skeleton, toast (sonner), tooltip, dropdown-menu, alert-dialog
```

---

## 14. File Structure

```
src/
├── main.tsx                     ← ReactDOM.createRoot
├── App.tsx                      ← BrowserRouter + Routes
├── index.css                    ← Tailwind directives + global styles
├── lib/
│   ├── api.ts                   ← API client (all fetch calls)
│   ├── browserpod.ts            ← BrowserPod manager
│   └── utils.ts                 ← Helper functions (getFileExtension, parseFileTree, etc.)
├── types/
│   └── index.ts                 ← All TypeScript interfaces
├── components/
│   ├── ui/                      ← shadcn UI components
│   │   ├── button.tsx
│   │   ├── card.tsx
│   │   ├── input.tsx
│   │   ├── dialog.tsx
│   │   ├── badge.tsx
│   │   ├── tabs.tsx
│   │   ├── scroll-area.tsx
│   │   ├── skeleton.tsx
│   │   ├── tooltip.tsx
│   │   └── ...
│   ├── layout/
│   │   └── Navbar.tsx           ← Top navigation bar (DevHub logo, back btn, actions)
│   ├── workspace/
│   │   ├── WorkspaceCard.tsx    ← Card for dashboard grid
│   │   ├── RepoCard.tsx         ← Repo card in workspace page list
│   │   ├── CreateWorkspaceDialog.tsx
│   │   └── AddRepoDialog.tsx
│   ├── repo/
│   │   ├── FileTree.tsx         ← Collapsible directory tree
│   │   ├── FileViewer.tsx       ← Monaco Editor wrapper
│   │   ├── RunButton.tsx        ← Green "▶ Run" button with state handling
│   │   ├── StopButton.tsx       ← Red "⏹ Stop" button
│   │   ├── PortalPreview.tsx    ← iframe wrapper for live preview
│   │   ├── RunnabilityBadge.tsx ← Shows canRun / can't run + blockers tooltip
│   │   └── StatusBadge.tsx      ← Colored status dot + label
│   ├── chat/
│   │   ├── ChatPanel.tsx        ← Full chat (message list + input)
│   │   ├── ChatMessage.tsx      ← Single message bubble
│   │   └── ChatInput.tsx        ← Input bar + send button
│   └── ai/
│       └── AiReadmeViewer.tsx   ← Markdown renderer for AIreadme
├── pages/
│   ├── DashboardPage.tsx        ← /dashboard
│   ├── WorkspacePage.tsx        ← /workspace/:workspaceId
│   └── RepoPage.tsx             ← /workspace/:workspaceId/repo/:repoId
└── hooks/
    ├── useWorkspaces.ts         ← Fetch workspaces
    ├── useWorkspace.ts          ← Fetch single workspace
    ├── useRepo.ts               ← Fetch single repo + polling
    └── usePod.ts                ← Manage BrowserPod instance lifecycle
```

---

## 15. Custom Hooks

### `usePod(repoId: string)`
```typescript
// Returns:
{
  pod: BootedPod | null,
  status: 'idle' | 'booting' | 'cloning' | 'ready' | 'running' | 'error',
  error: string | null,
  boot: () => Promise<void>,
  clone: (url: string) => Promise<void>,
  getTree: () => Promise<string>,
  readFile: (path: string) => Promise<string>,
  checkRunnable: () => Promise<RunnabilityResult>,
  run: (entryPoint: string) => Promise<void>,
  stop: () => void,
  portalUrl: string | null,
  terminalOutput: string[],
}
```

### `useRepo(repoId: string)`
```typescript
// Returns:
{
  repo: Repo | null,
  loading: boolean,
  error: string | null,
  refetch: () => Promise<void>,
}
// Polls GET /api/repos/:repoId every 3 seconds while status is "cloning" or "analyzing"
```

### `useWorkspace(workspaceId: string)`
```typescript
// Returns:
{
  workspace: (Workspace & { repos: Repo[] }) | null,
  loading: boolean,
  error: string | null,
  refetch: () => Promise<void>,
}
```

### `useWorkspaces()`
```typescript
// Returns:
{
  workspaces: Workspace[],
  loading: boolean,
  error: string | null,
  refetch: () => Promise<void>,
}
```

---

## 16. Key Helper Functions (`src/lib/utils.ts`)

```typescript
// Parse file tree string into nested object
export function parseFileTree(tree: string): FileNode[] { ... }

// Get file extension
export function getFileExtension(filename: string): string { ... }

// Map extension to Monaco language
export function getLanguageFromExtension(ext: string): string { ... }

// Extract repo name from GitHub URL
export function getRepoNameFromUrl(url: string): string {
  const parts = url.split('/');
  return parts[parts.length - 1].replace('.git', '');
}

// Get file icon based on extension
export function getFileIcon(filename: string): string { ... }
```

---

## 17. Dark Mode

- Use Tailwind `dark:` classes throughout
- Toggle in Navbar (sun/moon icon)
- Store preference in `localStorage`
- Default to system preference via `prefers-color-scheme`

---

## 18. Responsive Design

- Desktop: Full 3-panel layout (file tree | editor | details/chat)
- Tablet (<1024px): File tree collapses to hamburger menu, editor takes full width
- Mobile (<768px): Single column, file tree as overlay/drawer, bottom panel tabs become accordion

---

## 19. Things NOT to Build (Out of Scope)

- ❌ Authentication / login / user management
- ❌ Real-time collaboration (WebSocket)
- ❌ File editing/saving (read-only viewer only)
- ❌ Git operations beyond clone (no commit, push, branch switch)
- ❌ Security scanning (nice to have, not in MVP)
- ❌ File upload (only GitHub URLs)

---

## 20. Build Order (Do In Order)

| Step | What | Time |
|------|------|------|
| 1 | Scaffold Vite + React + TS + Tailwind + shadcn/ui | 30 min |
| 2 | Configure vite.config.ts with COOP/COEP headers | 5 min |
| 3 | Create types (`src/types/index.ts`) | 15 min |
| 4 | Create API client (`src/lib/api.ts`) | 30 min |
| 5 | Create BrowserPod manager (`src/lib/browserpod.ts`) | 1 hour |
| 6 | Create utility functions (`src/lib/utils.ts`) | 30 min |
| 7 | Create Navbar component | 30 min |
| 8 | Create Dashboard page (loading, empty, data states) | 1.5 hours |
| 9 | Create WorkspaceCard + CreateWorkspaceDialog | 30 min |
| 10 | Create WorkspacePage + RepoCard + AddRepoDialog | 2 hours |
| 11 | Create FileTree component | 1.5 hours |
| 12 | Create FileViewer (Monaco Editor wrapper) | 30 min |
| 13 | Create RepoPage (file tree + editor + bottom tabs) | 2 hours |
| 14 | Create RunButton + StopButton + PortalPreview | 1.5 hours |
| 15 | Create ChatPanel + ChatMessage + ChatInput | 2 hours |
| 16 | Create AiReadmeViewer (markdown render) | 30 min |
| 17 | Add all loading/empty/error states | 1 hour |
| 18 | Add dark mode toggle | 30 min |
| 19 | Add responsive styles | 1 hour |
| 20 | Create custom hooks (useWorkspaces, useWorkspace, useRepo, usePod) | 1.5 hours |
| 21 | Polish + test full flow | 1 hour |
| 22 | Deploy to Vercel | 30 min |

---

## 21. npm Packages (Complete List)

```json
{
  "dependencies": {
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "react-router-dom": "^6.26.0",
    "@leaningtech/browserpod": "^2.0.0",
    "@monaco-editor/react": "^4.6.0",
    "lucide-react": "^0.441.0",
    "sonner": "^1.5.0",
    "react-markdown": "^9.0.0",
    "tailwind-merge": "^2.5.0",
    "clsx": "^2.1.0"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.3.0",
    "vite": "^5.4.0",
    "typescript": "^5.5.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "tailwindcss": "^3.4.0",
    "autoprefixer": "^10.4.0",
    "postcss": "^8.4.0"
  }
}
```

---

## Summary

This is the complete frontend for DevHub. It communicates with the backend API (built by Engineers A & B) and manages BrowserPod instances entirely in the browser. No authentication. No file editing. Pure viewing, analysis, running, and chatting.

**Start from step 1. Build page by page. Add loading/empty/error states to everything.**