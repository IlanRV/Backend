# Engineer B Handoff — Current Backend State

## Project Basics

- Backend package: `server/`
- API base URL in local dev: `http://localhost:3001/api`
- Firebase project: `devhub-backend-2026`
- Firestore database: default database in `eur3`
- Frontend folder: `/Users/yusufyusuf/Documents/Frontend`
- Frontend local env already points at `VITE_API_URL=http://localhost:3001/api`

## Commands

Run from `server/`:

```bash
npm run dev
npm run build
npm run smoke
```

Run from the repo root for Firebase config:

```bash
firebase deploy --only firestore:rules,firestore:indexes
```

## Already Implemented By Engineer A

- `GET /api/health`
- Workspace CRUD endpoints
- Repo CRUD endpoints
- Repo run/stop endpoints
- Repo and workspace chat endpoints
- Firestore helpers in `server/src/lib/firebase.ts`
- Shared types in `server/src/types/index.ts`
- Chat context prompt builder in `server/src/ai/prompts/chatContext.ts`
- OpenRouter client exports in `server/src/ai/openrouter.ts`
- Firestore rules and indexes at repo root

## AI Route Status

The mounted route is currently:

```typescript
app.use('/api/ai', aiRoutes);
```

from:

```typescript
server/src/routes/ai.ts
```

That file currently contains a local heuristic extraction baseline. It accepts:

```json
{
  "fileTree": "src/\n  index.ts\npackage.json",
  "files": [
    { "path": "package.json", "content": "..." },
    { "path": "src/index.ts", "content": "..." }
  ]
}
```

and stores these fields on the repo document:

- `status`
- `analysis`
- `aiReadme`
- `runnability`

You can replace or extend that route with the OpenRouter-backed extraction pipeline. Keep the mounted public API shape:

- `POST /api/ai/extract/:repoId`
- `GET /api/ai/extract/:repoId`

## Important Integration Points

- Keep `server/src/ai/openrouter.ts` exporting:
  - `callOpenRouter(userMessage, systemPrompt, model?)`
  - `callOpenRouterStructured<T>(userMessage, systemPrompt, jsonSchema)`
- `OPENROUTER_API_KEY` is still blank in local `server/.env`.
- `setDoc` supports a fourth `options` argument, so updates can use `{ merge: true }`.
- `getDoc` returns the document data plus collection-specific ID fields like `repoId`, `workspaceId`, and `messageId`.
- The local smoke test now verifies CRUD, extraction, run/stop, and cleanup.

## Do Not Commit

- `server/.env`
- `server/.secrets/`
- Any service account JSON key

## Current Verified State

As of 2026-05-02:

- `npm run build` passes.
- `npm run smoke` passes against live Firestore.
- Firestore rules and indexes are deployed.