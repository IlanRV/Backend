# DevHub Backend

Express + TypeScript API for DevHub workspaces, repositories, chat, Firestore storage, and AI integration handoff.

## Commands

```bash
npm install
npm run dev
npm run build
npm start
```

The dev server runs on `http://localhost:3001` by default. The frontend in `/Users/yusufyusuf/Documents/Frontend` already uses `VITE_API_URL=http://localhost:3001/api`.

## Environment

Copy `.env.example` to `.env` and fill in:

- `OPENROUTER_API_KEY`
- `FIREBASE_PROJECT_ID`
- `FIREBASE_PRIVATE_KEY`
- `FIREBASE_CLIENT_EMAIL`

The health endpoint works without Firebase credentials, but CRUD/chat routes need Firestore configured.

## Implemented In This Chunk

- `GET /api/health`
- Workspace CRUD routes
- Repo CRUD plus run/stop state routes
- Shared TypeScript interfaces
- Firebase Admin helper functions, including `setDoc(..., { merge: true })`
- Repo/workspace chat routes wired to `src/ai/openrouter.ts`
- Chat system prompt builder at `src/ai/prompts/chatContext.ts`

## Engineer B Handoff

The expected paths already exist:

- `src/ai/openrouter.ts` has the base OpenRouter client.
- `src/routes/ai.ts` is mounted at `/api/ai` and currently returns `501` for `POST /extract/:repoId`.

Next, replace or extend `src/routes/ai.ts` with the extraction pipeline and add the prompt/orchestration files described in `../Research/engineerB_spec.md`.