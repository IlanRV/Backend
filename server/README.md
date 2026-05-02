# DevHub Backend

Express + TypeScript API for DevHub workspaces, repositories, chat, Firestore storage, and AI integration handoff.

## Commands

```bash
npm install
npm run dev
npm run build
npm start
npm run smoke
```

Use `npm run dev` while building locally. Use `npm run build` followed by `npm start` for a production-style run from `dist/`. Do not run `npm run dev` and `npm start` at the same time because both use port `3001`.

The dev server runs on `http://localhost:3001` by default. The frontend in `/Users/yusufyusuf/Documents/Frontend` already uses `VITE_API_URL=http://localhost:3001/api`.

Run `npm run smoke` while the backend is running to create a temporary workspace/repo, exercise the Firestore-backed CRUD and extraction endpoints, and clean the temporary data up again.

Firestore rules and indexes live at the repo root. Deploy them from `/Users/yusufyusuf/Documents/Backend` with:

```bash
firebase deploy --only firestore:rules,firestore:indexes
```

## Environment

Copy `.env.example` to `.env` and fill in:

- `OPENROUTER_API_KEY`
- `FIREBASE_PROJECT_ID`
- `FIREBASE_PRIVATE_KEY`
- `FIREBASE_CLIENT_EMAIL`
- `LOG_LEVEL` optional, one of `debug`, `info`, `warn`, or `error`

The health endpoint works without Firebase credentials, but CRUD/chat routes need Firestore configured.

## Logging

The backend writes structured JSON logs to stdout/stderr with these fields:

- `timestamp`
- `level`
- `scope`
- `message`
- `meta`

Use `LOG_LEVEL=debug` during local development and `LOG_LEVEL=info` or `warn` for quieter runs. Logs intentionally include safe metadata such as IDs, counts, durations, route names, statuses, and feature flags. They redact sensitive key names and avoid logging raw prompts, repo source code, chat messages, API keys, Firebase private keys, and OpenRouter responses.

This local project is currently configured for Firebase project `devhub-backend-2026`, with the default Firestore database in `eur3`.

## Implemented In This Chunk

- `GET /api/health`
- Workspace CRUD routes
- Repo CRUD plus run/stop state routes
- Shared TypeScript interfaces
- Firebase Admin helper functions, including `setDoc(..., { merge: true })`
- Repo/workspace chat routes wired to `src/ai/openrouter.ts`
- Chat system prompt builder at `src/ai/prompts/chatContext.ts`
- Local heuristic `POST /api/ai/extract/:repoId` baseline that stores `analysis`, `aiReadme`, and `runnability`

## Engineer B Handoff

The expected paths already exist:

- `src/ai/openrouter.ts` has the base OpenRouter client.
- `src/routes/ai.ts` is mounted at `/api/ai` and currently contains a local heuristic extraction baseline.

Next, Engineer B can replace or extend the heuristic extraction in `src/routes/ai.ts` with the OpenRouter-backed pipeline and add the prompt/orchestration files described in `../Research/engineerB_spec.md`.

See `../Research/engineerB_handoff.md` for the current integration notes.
