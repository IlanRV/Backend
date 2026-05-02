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
- `OPENROUTER_MODEL` (the primary model for extraction and chat)
- `OPENROUTER_STRICT_JSON_SCHEMA` (defaults to `false`; prompt-only JSON mode avoids an extra failed schema call on models that do not support strict schema response format)
- `FIREBASE_PROJECT_ID`
- `FIREBASE_PRIVATE_KEY`
- `FIREBASE_CLIENT_EMAIL`

This project is currently configured for DeepSeek only through OpenRouter:

```env
OPENROUTER_MODEL=deepseek/deepseek-v4-flash
OPENROUTER_FALLBACK_MODELS=
OPENROUTER_RETRY_COUNT=0
OPENROUTER_STRICT_JSON_SCHEMA=false
```

Non-DeepSeek `OPENROUTER_MODEL` values are ignored by the backend config guard and replaced with `deepseek/deepseek-v4-flash`. Fallback models are also filtered to `deepseek/*` model IDs only.

If the model is rate-limited or unavailable, the backend falls back to local heuristic extraction, skips repeated AI calls while the model cools down, and returns a friendly degraded chat reply instead of a raw 500. Route-level extraction idempotency also prevents duplicate POSTs for the same repo source payload from starting a second paid extraction job.

Function documentation extraction uses source-file chunks before merging and deduplicating results. Keep chunk limits conservative because each chunk is one model call.

The health endpoint works without Firebase credentials, but CRUD/chat routes need Firestore configured.

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