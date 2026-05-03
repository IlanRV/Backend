# DevHub

DevHub is a multi-repository developer workspace. A user can group GitHub repositories into a workspace, inspect source files in the browser, run compatible projects in BrowserPod, generate AI summaries of the codebase, review static and runtime security signals, and ask questions about a single repo or an entire workspace.

This repository is the backend and Firebase configuration layer for the project. The frontend lives in a separate sibling repository in the same hackathon workspace, but this README documents the whole product so the backend behavior makes sense in context.

## Product Summary

At a high level, DevHub does four things:

1. It organizes related repositories into a workspace.
2. It stores enough repo state to let the UI browse, analyze, and reason about code.
3. It generates structured AI output from cached source files.
4. It records security and runtime metadata so the frontend can make safer execution decisions.

The backend is the source of truth for:

- workspace state
- repo state
- cached repo files used for AI extraction
- AI extraction results and generated AI README content
- saved repo and workspace chat history
- runtime security events reported from BrowserPod or the frontend

The frontend is responsible for:

- UI and user interaction
- BrowserPod boot, clone, file access, and command execution
- collecting file trees and file contents for extraction
- showing run options, repo views, security views, and chat

## What The Project Does End To End

The normal flow for a repo looks like this:

1. A user creates a workspace.
2. The user adds a GitHub repository URL to that workspace.
3. The backend creates a repo record in Firestore with status `cloning`.
4. The frontend clones the repo inside BrowserPod.
5. The frontend reads a supported subset of files and sends them to the backend extraction endpoint.
6. The backend stores those files in Firestore and starts asynchronous AI extraction.
7. The backend produces:
    - detected tech stack
    - overview and purpose
    - function and class summaries
    - dependency inventory
    - static security analysis
    - runtime profile and runnability guidance
    - AI README markdown
8. The frontend fetches extraction state and renders the repo detail experience.
9. If the repo is runnable, the frontend starts it inside BrowserPod and registers the portal URL with the backend.
10. If the repo is only partially runnable, the frontend can present manual BrowserPod commands instead.
11. Runtime security events can be posted back to the backend while the repo is running.
12. Repo and workspace chat use saved extraction context plus previous chat history.

## Main Product Features

### Workspace management

- Create workspaces with a name and description.
- List all workspaces with repo counts.
- Fetch one workspace with all repos included.
- Delete a workspace and cascade-delete repo files, chat history, and runtime security events.
- Enforce a current workspace cap of 3.

### Repository management

- Add a repo to a workspace using a valid `https://github.com/{owner}/{repo}` URL.
- Fetch a normalized repo record for the UI.
- Delete repos globally or through a workspace-scoped endpoint.
- Store run state such as `status`, `portalUrl`, `runnability`, and `runtimeSecurity`.

### Source caching and code browsing support

- Accept file trees and file contents from the frontend.
- Save extracted source files to Firestore with a source hash.
- Serve cached file contents back to the frontend when BrowserPod is unavailable or when the frontend wants a persisted file read.

### AI extraction

The extraction pipeline can return:

- `techStack`
- `overview`
- `functions`
- `dependencies`
- `security`
- `runnability`
- `aiReadme`

The backend supports both AI-generated output and fallback extraction behavior when the AI provider is unavailable or partially fails.

### Chat

- Repo-scoped chat for questions about one codebase.
- Workspace-scoped chat for questions across several repos.
- Duplicate question caching to avoid repeated responses for the same immediately repeated input.
- Graceful degraded fallback replies when the AI provider is down or fails validation.

### Security analysis

Static security analysis covers:

- suspicious dependencies
- malicious or suspicious package versions
- risky npm lifecycle scripts
- secrets and dangerous config patterns
- execution, obfuscation, and supply-chain indicators

Runtime security support covers:

- runtime event ingestion
- event severity and categorization
- risk summaries derived from runtime events
- run gating for high-risk repositories

### Runtime guidance

The backend distinguishes between:

- whether a repo looks like a frontend app, API server, library, CLI, test-only repo, or unknown repo
- whether it should auto-preview in BrowserPod
- whether it should only offer manual BrowserPod commands
- whether it should only be analyzed and not run automatically

This is important because a repo can be healthy and useful even if it should not expose a live preview.

## Backend Architecture

The backend is a TypeScript Express service with Firebase Admin for persistence.

### Stack

- Node.js 22
- Express
- TypeScript
- Firebase Admin / Firestore
- Zod
- OpenRouter
- Vitest
- Supertest

### Entry points

- `server/src/index.ts`
   - starts the HTTP server
   - logs startup metadata
   - installs process-level error logging
- `server/src/app.ts`
   - constructs the Express app
   - sets CORS and JSON middleware
   - mounts routes
   - handles 404 and 500 responses
- `server/src/config.ts`
   - loads environment variables
   - normalizes Firebase private key formatting
   - parses OpenRouter settings and logging settings

### Backend modules

- `server/src/routes/workspaces.ts`
   - workspace CRUD
- `server/src/routes/repos.ts`
   - repo CRUD, run state, cached file access, and runtime security endpoints
- `server/src/routes/ai.ts`
   - extraction start and extraction status fetch
- `server/src/routes/chat.ts`
   - repo and workspace chat
- `server/src/ai/*`
   - extraction logic, prompts, schemas, and OpenRouter integration
- `server/src/lib/firebase.ts`
   - Firestore helpers and collection ID mapping
- `server/src/lib/repoFiles.ts`
   - repo file persistence helpers
- `server/src/lib/repoResponse.ts`
   - API repo normalization for consistent `id` and `repoId`

## Repository Layout

```text
Backend/
├── README.md
├── firebase.json
├── firestore.rules
├── firestore.indexes.json
├── server/
│   ├── .env.example
│   ├── package.json
│   ├── src/
│   │   ├── ai/
│   │   ├── app.ts
│   │   ├── config.ts
│   │   ├── index.ts
│   │   ├── lib/
│   │   ├── routes/
│   │   └── types/
│   └── tests/
└── Research/
```

## Firestore Data Model

The backend currently persists these main collections:

- `workspaces`
   - workspace metadata
- `repos`
   - repo metadata, extraction state, run state, AI README, and security summary
- `repo_files`
   - cached text files used for extraction and file fallback reads
- `chat_messages`
   - repo-scoped and workspace-scoped chat history
- `repo_security_events`
   - runtime events reported from BrowserPod and the frontend

### Workspace shape

Stored fields include:

- `workspaceId`
- `name`
- `description`
- `createdAt`

### Repo shape

Important repo fields include:

- `repoId`
- `workspaceId`
- `name`
- `githubUrl`
- `status`
- `runnability`
- `fileTree`
- `analysis`
- `analysisSourceHash`
- `analysisStartedAt`
- `analysisUpdatedAt`
- `analysisModel`
- `analysisError`
- `analysisProgress`
- `aiReadme`
- `aiReadmeStatus`
- `runtimeSecurity`
- `portalUrl`
- `createdAt`
- `updatedAt`

## API Reference

All routes are served under `/api` except chat routes, which are mounted under `/api/chat`, and AI routes, which are mounted under `/api/ai`.

### Health

`GET /api/health`

Returns a simple service heartbeat:

```json
{
   "status": "ok",
   "timestamp": "2026-05-03T12:00:00.000Z"
}
```

### Workspaces

`GET /api/workspaces`

- Returns all workspaces ordered by `createdAt`.
- Includes `repoCount` for each workspace.

`POST /api/workspaces`

Request body:

```json
{
   "name": "Security review",
   "description": "Repos to analyze for BrowserPod compatibility"
}
```

Behavior:

- validates name and description
- enforces the max workspace limit
- creates a Firestore document

`GET /api/workspaces/:id`

- returns one workspace plus its repos
- sorts repos by creation time

`DELETE /api/workspaces/:id`

- deletes the workspace
- deletes repos in the workspace
- deletes repo-scoped and workspace-scoped chat messages
- deletes cached repo files and runtime security events

### Repositories

`POST /api/workspaces/:id/repos`

Request body:

```json
{
   "githubUrl": "https://github.com/example/project"
}
```

Behavior:

- validates GitHub URL format
- extracts repo name from URL
- creates a repo record with status `cloning`

`GET /api/repos/:id`

- returns one repo record normalized for API use

`DELETE /api/repos/:id`

- deletes a repo and cascades related cached records

`DELETE /api/workspaces/:workspaceId/repos/:repoId`

- deletes a repo only if it belongs to the specified workspace
- returns:

```json
{
   "success": true,
   "repoId": "repo-id",
   "workspaceId": "workspace-id"
}
```

`POST /api/repos/:id/run`

Request body:

```json
{
   "portalUrl": "https://...",
   "sandboxConfirmed": true,
   "manualOverride": false
}
```

Behavior:

- stores the BrowserPod portal URL
- marks repo status as `running`
- blocks the run if the repo is not automatically runnable and no manual override was requested
- blocks the run if the repo is high risk and sandbox confirmation was not given

`POST /api/repos/:id/stop`

- clears the repo portal URL
- marks repo status as `ready`

`POST /api/repos/:id/security-events`

Accepts runtime security telemetry from the frontend or BrowserPod adapters.

Supported fields include:

- `source`
- `phase`
- `category`
- `severity`
- `title`
- `description`
- `evidence`
- `command`

The endpoint stores the event, recalculates the runtime risk summary, updates the repo, and returns the saved event plus the new summary.

`GET /api/repos/:id/security`

- returns both static security findings and runtime security state
- includes the raw runtime events array
- includes `runnability`

`GET /api/repos/:id/file?path=...`

- returns cached file contents for a saved repo file
- requires the file to have been saved previously during extraction collection

### AI Extraction

`POST /api/ai/extract/:repoId`

This route starts or reuses extraction.

Supported request shapes:

1. Send explicit files:

```json
{
   "fileTree": { "name": "repo", "path": "", "type": "directory", "children": [] },
   "files": [
      { "path": "package.json", "content": "{...}" },
      { "path": "README.md", "content": "# Demo" }
   ]
}
```

2. Use already cached files:

```json
{
   "useStoredFiles": true
}
```

Behavior:

- stores repo files and source hash
- reuses in-flight extraction if one is already active
- returns cached results if source hash did not change and analysis already exists
- otherwise marks the repo as `analyzing` and starts background extraction

`GET /api/ai/extract/:repoId`

Returns the current extraction state and saved result fields, including:

- `status`
- `aiReadmeStatus`
- `techStack`
- `overview`
- `functions`
- `dependencies`
- `security`
- `aiReadme`
- `runnability`
- `analysisUpdatedAt`
- `analysisModel`
- `analysisError`
- `analysisProgress`

### Chat

`POST /api/chat/repo/:repoId`

Request body:

```json
{
   "message": "What does this project do?"
}
```

Behavior:

- loads recent repo chat history
- builds a repo-scoped system prompt
- asks OpenRouter for a structured JSON reply
- persists both the user message and assistant reply
- falls back to a degraded response when AI fails

`GET /api/chat/repo/:repoId`

- returns repo-scoped chat history ordered by timestamp

`POST /api/chat/workspace/:wsId`

- same behavior as repo chat, but includes all repos in the workspace as context

`GET /api/chat/workspace/:wsId`

- returns workspace-scoped chat history ordered by timestamp

## Extraction And AI Behavior

The extraction pipeline is designed to work even when some AI steps fail.

### What the backend infers without a perfect README

The backend does not rely only on `README.md`.

It also inspects:

- `package.json`
- nested workspace package manifests
- dependencies and devDependencies
- scripts
- file extensions
- route definitions
- code patterns indicating frontend apps, API servers, CLIs, or libraries
- lockfiles and script contents for security signals

README instructions are treated as useful supporting evidence, not the only source of truth.

### Extraction progress phases

The backend can report these phases:

- `queued`
- `scanning`
- `querying`
- `saving`
- `readme`
- `complete`
- `error`

### Timeout behavior

- active extraction is deduplicated per repo
- timed-out extraction jobs are marked as failed
- the frontend can retry and start a fresh extraction

## Runnability And Runtime Profiles

The backend returns a `RunnabilityResult` that tells the frontend:

- whether the repo can be auto-run
- which command to use automatically
- which manual BrowserPod commands are safe to suggest
- which blockers explain why a repo should not auto-run

### Project kinds

- `preview-app`
- `api-server`
- `library`
- `cli`
- `test-only`
- `unknown`

### Support levels

- `auto-preview`
- `manual-only`
- `analysis-only`

### Current product rule

BrowserPod is the only execution path the frontend should use. The backend records and explains run state, but it does not execute repository code on the host machine.

## Security Model

### Static analysis

The extraction layer scans for:

- vulnerable or suspicious package versions
- risky lifecycle scripts like `postinstall`
- malware or obfuscation signals
- secret exposure patterns
- execution and network abuse signals
- configuration mistakes

### Runtime analysis

The backend can accept runtime events while the repo is executing in BrowserPod.

Runtime events are categorized by:

- source
- phase
- category
- severity
- title
- description
- evidence
- command

This allows the UI to show both static and runtime risk together.

### Run gating

The backend can reject a run request if:

- the repo is not automatically runnable and there is no manual override
- the repo has high or critical security findings and sandbox confirmation was not given

## Environment Variables

Use `server/.env.example` as the starting point.

Required or important variables:

- `PORT`
   - backend HTTP port
- `CORS_ORIGIN`
   - frontend origin allowed by CORS
- `OPENROUTER_API_KEY`
   - required for AI-backed extraction and chat
- `OPENROUTER_MODEL`
   - primary DeepSeek model name
- `OPENROUTER_FALLBACK_MODELS`
   - comma-separated fallback models
- `OPENROUTER_RETRY_COUNT`
   - retry count for provider calls
- `OPENROUTER_TIMEOUT_MS`
   - per-request timeout
- `OPENROUTER_MAX_TOKENS`
   - structured response token cap
- `OPENROUTER_STRICT_JSON_SCHEMA`
   - whether strict provider JSON schema mode is enabled
- `OPENROUTER_APP_NAME`
   - application name sent to the provider
- `OPENROUTER_SITE_URL`
   - optional site URL metadata
- `FIREBASE_PROJECT_ID`
   - Firebase project ID
- `FIREBASE_PRIVATE_KEY`
   - Firebase admin private key
- `FIREBASE_CLIENT_EMAIL`
   - Firebase service account email
- `LOG_LEVEL`
   - log verbosity

### Firebase private key note

The backend normalizes the Firebase private key by:

- stripping surrounding quotes
- converting literal `\n` into real newlines
- normalizing Windows line endings
- trimming surrounding whitespace

This makes Render-style and copy-pasted secret formats more reliable.

## Local Development

### Prerequisites

- Node.js 22
- npm
- a Firebase project with Firestore enabled
- a Firebase service account for admin access
- an OpenRouter API key for AI features
- a BrowserPod API key for the frontend repo

### Install backend dependencies

```bash
cd server
npm install
```

### Create backend environment file

Copy the example file and fill in real values:

```bash
cd server
cp .env.example .env
```

### Run the backend in development

```bash
cd server
npm run dev
```

The API will start on `http://localhost:3001` by default.

### Build and test

```bash
cd server
npm test
npm run build
npm run smoke
```

### Frontend environment

In the frontend repo, the client typically needs:

```env
VITE_API_URL=http://localhost:3001/api
VITE_BP_APIKEY=your-browserpod-api-key
```

## Example Backend Startup Checklist

1. Install backend dependencies.
2. Create `server/.env` from `server/.env.example`.
3. Make sure Firebase credentials are valid.
4. Make sure OpenRouter credentials are valid if you want AI features.
5. Start the backend with `npm run dev`.
6. Start the frontend separately in its own repository.
7. Open the frontend and verify `GET /api/health` succeeds.

## Development Workflow Notes

- The backend is tested with Vitest and Supertest.
- Firestore access is wrapped through helper functions so route logic stays simple.
- Repo deletion and workspace deletion are designed to clean up dependent records.
- Extraction is asynchronous and deduplicated to reduce repeated provider calls.
- Chat replies are schema-constrained JSON responses, then persisted as normal text messages.

## Operational Notes And Limitations

- BrowserPod is a frontend runtime concern. The backend records repo run state and security data, but does not boot the runtime itself.
- The backend can analyze cached files even when a repo cannot be run successfully.
- A repo can be useful while still being `manual-only` or `analysis-only`.
- Workspace count is intentionally capped right now.
- Extraction depends on cached text files, so very large repos or unsupported binary-heavy repos will only be partially represented.
- Runtime security insight depends on the frontend actually reporting BrowserPod events.

## Troubleshooting

### `npm run dev` fails in the wrong directory

The backend scripts live under `server/`, not the repo root.

Use:

```bash
cd server
npm run dev
```

### Firebase credentials error

Check:

- `FIREBASE_PROJECT_ID`
- `FIREBASE_PRIVATE_KEY`
- `FIREBASE_CLIENT_EMAIL`

If the private key came from a hosting dashboard, make sure escaped newlines were preserved correctly.

### AI extraction fails

Check:

- `OPENROUTER_API_KEY`
- model name
- timeout and retry settings
- whether repo files were actually cached before calling `useStoredFiles`

### Chat returns degraded responses

This usually means:

- the OpenRouter call failed
- the model response failed schema validation
- the provider was temporarily unavailable

The backend still returns a fallback response using saved extraction data when possible.

### Cached file fetch returns 404

`GET /api/repos/:id/file` only works for files already saved in `repo_files`. If the frontend has not uploaded files for extraction yet, there may be no cached content to serve.

## Current Product Rules

- BrowserPod is the only allowed execution path in the frontend.
- The backend stores metadata, analysis, cached files, and chat history, but it does not serve as the repo runtime.
- Workspace creation is capped at 3 workspaces.
- High-risk repos may require explicit confirmation before they can run.
- Deleting a workspace or repo deletes cached DevHub data, not the upstream GitHub repository.

## Project Status

Recent backend work included:

- runtime security telemetry support
- runtime profile inference
- monorepo workspace-script runnability detection
- workspace-scoped repository deletion
- improved README and backend documentation

If this repository grows further, the next sensible documentation split would be:

1. a short root product overview
2. a backend-only operations README inside `server/`
3. a frontend-only README in the frontend repository