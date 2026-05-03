# DevHub

DevHub is a multi-repo developer workspace. It lets a user group GitHub repositories into a workspace, inspect the code in the browser, run supported projects inside BrowserPod, generate AI summaries of the codebase, and chat with AI at either the repo or workspace level.

This README covers the whole platform, not just the backend. The current repository contains the backend and Firebase config. The frontend is a separate sibling repo in the same hackathon project.

## What The Project Does

DevHub is built around a simple workflow:

1. Create a workspace.
2. Add one or more GitHub repositories to that workspace.
3. Clone and inspect repo files in BrowserPod.
4. Send the repo source snapshot to the backend for AI extraction.
5. Generate:
   - tech stack detection
   - high-level repo overview
   - function and class summaries
   - dependency inventory
   - security findings
   - AI README content
   - runnability and runtime profile guidance
6. Run supported repos in BrowserPod.
7. Ask AI questions about one repo or the whole workspace.
8. Delete repos or workspaces when they are no longer needed.

## Core Features

### Workspace management

- Create and list workspaces.
- Delete a workspace and all of its cached data.
- Track how many repos belong to each workspace.
- Enforce a workspace cap of 3 workspaces in the current product flow.

### Repository management

- Add a GitHub repository to a workspace using a GitHub URL.
- Fetch repository metadata and cached analysis state.
- Delete a repo from a workspace without deleting the actual GitHub repository.
- Remove related cached files, chat history, and runtime security events when a repo is deleted.

### Code browsing

- Clone repo files into BrowserPod.
- Build a file tree for the frontend.
- Read supported source files directly in the browser.
- Cache extracted repo files in Firestore so the backend can analyze them without recloning.

### AI extraction

For each repo, the backend can analyze the stored source snapshot and return:

- detected language, framework, runtime, build tool, test framework, database, and other tools
- a one-line summary and longer explanation of the repo
- target users and repo purpose
- documented functions, classes, and methods
- dependency inventory
- static security findings
- generated AI README content
- runnability result
- runtime profile with automatic and manual command suggestions

The extraction flow is asynchronous and tracks progress so the frontend can show queued, scanning, querying, saving, readme, complete, or error states.

### AI chat

DevHub supports two AI chat scopes:

- repo chat: ask about one repository
- workspace chat: ask questions across all repos in a workspace

Chat history is persisted. If the model is unavailable, the backend falls back to a degraded reply built from saved extraction data instead of failing silently.

### Secure runtime via BrowserPod

DevHub does not run user repos directly on the host machine from the frontend flow.

BrowserPod is the required runtime for executable repo actions in the frontend:

- automatic preview runs
- manual sandbox commands
- repo file access during interactive exploration

The frontend can:

- boot a BrowserPod sandbox
- clone repo files into the sandbox
- infer runnability
- run an automatic preview command when available
- run manual sandbox commands for repos that are not preview apps
- stop running sandboxes

### Runtime profile and runnability

The backend separates repo type from whether it can be auto-run. A repo may still be useful even if it is not automatically previewable.

Runtime profiles classify repos as:

- preview app
- API server
- library
- CLI
- test-only
- unknown

Support levels classify runtime behavior as:

- auto-preview
- manual-only
- analysis-only

This lets the frontend distinguish between:

- repos that should open a live preview
- repos that should offer safe manual commands in BrowserPod
- repos that should only be analyzed

### Security analysis

The project includes two layers of security support.

Static security analysis:

- suspicious dependencies
- risky lifecycle scripts
- malware and supply-chain indicators
- secrets and config findings
- execution and network risks

Runtime security telemetry:

- BrowserPod and frontend-originated runtime events
- event severity, category, phase, command, and evidence
- aggregated runtime risk summary per repo

High-risk repos can require explicit sandbox confirmation before the frontend is allowed to run them.

## Architecture

### Frontend

The frontend is a React and Vite application written in TypeScript.

Main frontend responsibilities:

- landing page and dashboard UI
- workspace and repo navigation
- BrowserPod lifecycle management
- file tree and file viewer UI
- run buttons, run inspection, and manual command UI
- AI README, security, and extraction views
- repo and workspace chat panels
- optimistic workspace and repo state updates

Important frontend technologies:

- React 18
- Vite
- TypeScript
- Tailwind CSS
- Radix UI dialog/tabs primitives
- BrowserPod SDK
- Vitest and Testing Library

### Backend

The backend is an Express server written in TypeScript.

Main backend responsibilities:

- workspace and repo CRUD
- repo file caching
- AI extraction orchestration
- OpenRouter calls for structured AI output
- chat orchestration and fallback responses
- security analysis and runtime security event ingestion
- Firestore persistence

Important backend technologies:

- Node.js
- Express
- TypeScript
- Firebase Admin / Firestore
- Zod
- OpenRouter with DeepSeek models
- Vitest and Supertest

### Persistence

Firestore stores the product state. Main collections are:

- `workspaces`
- `repos`
- `repo_files`
- `chat_messages`
- `repo_security_events`

## API Overview

### Health

- `GET /api/health`

### Workspaces

- `GET /api/workspaces`
- `POST /api/workspaces`
- `GET /api/workspaces/:id`
- `DELETE /api/workspaces/:id`

### Repositories

- `POST /api/workspaces/:id/repos`
- `GET /api/repos/:id`
- `DELETE /api/repos/:id`
- `DELETE /api/workspaces/:workspaceId/repos/:repoId`
- `POST /api/repos/:id/run`
- `POST /api/repos/:id/stop`
- `GET /api/repos/:id/file`
- runtime security event endpoints for repo runtime telemetry

### AI

- `POST /api/ai/extract/:repoId`
- `GET /api/ai/extract/:repoId`

### Chat

- `POST /api/chat/repo/:repoId`
- `GET /api/chat/repo/:repoId`
- `POST /api/chat/workspace/:wsId`
- `GET /api/chat/workspace/:wsId`

## Local Development

### Prerequisites

- Node.js 22
- npm
- Firebase project with Firestore enabled
- OpenRouter API key for AI features
- BrowserPod API key for browser sandbox features in the frontend

### Backend setup

From the backend server directory:

```bash
cd server
npm install
```

Create `server/.env` with these values:

```env
PORT=3001
CORS_ORIGIN=http://localhost:5173

FIREBASE_PROJECT_ID=your-project-id
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
FIREBASE_CLIENT_EMAIL=your-service-account-email

OPENROUTER_API_KEY=your-openrouter-key
OPENROUTER_MODEL=deepseek/deepseek-v4-flash
OPENROUTER_FALLBACK_MODELS=deepseek/deepseek-chat-v3-0324
OPENROUTER_MAX_TOKENS=4096
OPENROUTER_RETRY_COUNT=0
OPENROUTER_TIMEOUT_MS=45000
OPENROUTER_STRICT_JSON_SCHEMA=true
OPENROUTER_APP_NAME=DevHub
OPENROUTER_SITE_URL=

LOG_LEVEL=info
```

Run the backend:

```bash
cd server
npm run dev
```

Useful backend commands:

```bash
cd server
npm test
npm run build
npm run smoke
```

### Frontend setup

In the frontend repo, install dependencies and provide the environment values the client expects:

```env
VITE_API_URL=http://localhost:3001/api
VITE_BP_APIKEY=your-browserpod-api-key
```

Then run:

```bash
npm install
npm run dev
```

Useful frontend commands:

```bash
npm test
npm run build
npm run lint
```

## How The Pieces Work Together

1. The frontend creates a workspace through the backend.
2. A repo is added to that workspace from a GitHub URL.
3. BrowserPod clones the repo and exposes files to the frontend.
4. The frontend sends files and file tree data to the backend extraction endpoint.
5. The backend stores files, runs structured AI extraction, and saves the results.
6. The frontend loads extraction data and renders overview, functions, AI README, security, and runtime guidance.
7. If the repo can run, the frontend starts it in BrowserPod and registers the portal URL with the backend.
8. If the repo is manual-only, the frontend offers safe BrowserPod command suggestions instead.
9. Repo and workspace chat use the saved analysis context and message history.
10. Delete actions clean up cached backend data while leaving the source GitHub repo untouched.

## Current Product Rules

- BrowserPod is the only allowed execution path in the frontend.
- The backend stores metadata, analysis, cached files, and chat history, but it does not serve as the repo runtime.
- Workspace creation is capped at 3 workspaces.
- High-risk repos may require explicit confirmation before they can run.
- Deleting a workspace or repo deletes cached DevHub data, not the upstream GitHub repository.

## Project Status

The backend and frontend both have automated test coverage and build validation. Recent work included:

- runtime security telemetry
- runtime profile inference
- workspace-scoped repository deletion
- BrowserPod-only execution rules in the frontend

If you want, the next step can be splitting this into:

1. a short landing-page style root README
2. a backend-only README
3. a frontend-only README

That usually reads better once the project grows.