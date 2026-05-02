# DevHub Backend Progress Tracker

Last updated: 2026-05-02

## Snapshot

This file tracks how much of the Engineer A and Engineer B backend work is done, what has been verified locally, and what is still pending.

### Current high-level status

- Engineer A: core backend is largely implemented and locally verified.
- Engineer B: extraction pipeline, prompts, AI routes, and live OpenRouter flow are implemented and locally verified.
- Main remaining blocker for full product validation: run the real BrowserPod/frontend add-repo flow on one or two actual GitHub repos and inspect generated README quality.

### Verified today

- Backend `npm run build` passes.
- Frontend `npm run build` passes.
- Backend `npm run smoke` passes against live Firestore.
- Backend `npm run smoke` passes against live Firestore and live OpenRouter when the server is running on Node 22.
- Backend repo responses now expose `runnable`, `runScript`, and `aiReadmeStatus` for frontend compatibility.
- Frontend workspace repo lists now poll active `cloning`/`analyzing` repos every 3 seconds until extraction completes or errors.
- Frontend `npm run build` passes after the extraction polling and repo-card compatibility updates.
- Repo chat and workspace chat return live OpenRouter responses.
- `GET /api/ai/extract/:repoId` now returns pending or partial data instead of a cache-miss 404.
- BrowserPod add-repo flow is aligned with the backend extraction contract.

---

## Engineer A Progress

Reference: `Research/plan.md` and `Research/engineerA_spec.md`

| ID | Task | Status | Notes |
|---|---|---|---|
| A1 | Scaffold Express + TypeScript project, middleware, CORS, env config | Verified | Implemented in `server/src/index.ts` and `server/src/config.ts` |
| A2 | Firebase Admin SDK setup and Firestore helpers | Verified | Implemented in `server/src/lib/firebase.ts` |
| A3 | Workspace CRUD endpoints | Verified | Covered by smoke test |
| A4 | Repo CRUD endpoints | Verified | Covered by smoke test |
| A5 | Run/stop state endpoints | Verified | Covered by smoke test |
| A6 | Chat message CRUD and history retrieval | Verified | Chat persistence and live replies validated locally |
| A7 | Workspace chat endpoint | Verified | Live OpenRouter response validated locally |
| A8 | Repo chat endpoint | Verified | Live OpenRouter response validated locally |
| A9 | Deploy + test all endpoints | Partial | Firestore rules/indexes deployed; CRUD, extraction, run/stop, and chat verified locally; deployment still pending |

### Engineer A summary

- Implemented: 9/9 tasks
- Locally verified: 8/9 tasks fully verified, 1 partial
- Practical status: backend infrastructure is in good shape and usable for frontend integration now

---

## Engineer B Progress

Reference: `Research/plan.md`, `Research/engineerB_spec.md`, and `Research/engineerB_handoff.md`

| ID | Task | Status | Notes |
|---|---|---|---|
| B1 | OpenRouter client wrapper | Implemented | `server/src/ai/openrouter.ts`; includes structured JSON retry logic |
| B2 | Tech stack extraction prompt | Implemented | `server/src/ai/prompts/techStack.ts` |
| B3 | Project overview extraction prompt | Implemented | `server/src/ai/prompts/overview.ts` |
| B4 | Function-level extraction prompt | Implemented | `server/src/ai/prompts/functions.ts` |
| B5 | AI README generation prompt | Implemented | `server/src/ai/prompts/aiReadme.ts` |
| B6 | `POST /api/ai/extract/:repoId` orchestration endpoint | Verified | Background extraction flow implemented and smoke-tested |
| B7 | `GET /api/ai/extract/:repoId` cached results endpoint | Verified | Now returns pending-safe payloads instead of 404 for existing repos |
| B8 | Test extraction pipeline with real repos | Partial | Live OpenRouter-backed smoke extraction passes; still needs BrowserPod/frontend validation with real GitHub repos |

### Engineer B summary

- Implemented: 8/8 tasks
- Locally verified: 7/8 verified locally, with final real-repo BrowserPod validation pending
- Practical status: the extraction stack is in place and works with live OpenRouter in local smoke tests

---

## Engineer B Spec Step Tracking

Reference: `Research/engineerB_spec.md`

| Spec Step | Description | Status |
|---|---|---|
| 1 | Understand shared code | Done |
| 2 | Build OpenRouter client | Done |
| 3 | Build tech stack prompt | Done |
| 4 | Build overview prompt | Done |
| 5 | Build functions prompt | Done |
| 6 | Build AI README prompt | Done |
| 7 | Build extraction orchestrator | Done |
| 8 | Build AI routes | Done |
| 9 | Integration testing | Partial |
| 10 | Coordinate with Engineer A | Done |

---

## Cross-Cutting Integration Notes

- Frontend BrowserPod flow sends `fileTree` as an object structure, not only as a newline string. The backend now accepts both forms.
- Frontend AI README loading no longer loops on a pending extraction state.
- Frontend workspace cards now refresh active extraction state automatically, so background completion should show without manual page refresh.
- Backend repo responses include derived run and AI README status fields that match frontend expectations.
- Existing repos without cached extraction now return a useful pending payload instead of an error response.
- Local extraction still works even when `OPENROUTER_API_KEY` is missing, through the heuristic fallback pipeline.

---

## Remaining Work

### Highest priority

1. Validate extraction on one or two real GitHub repos through the BrowserPod add-repo flow.
2. Review generated AI README quality and tune prompts if needed.
3. Rotate exposed local service/API keys before any public deployment.

### Nice to have

1. Add a reusable scripted smoke test for the chat endpoints.
2. Add a documented real-repo test checklist for BrowserPod clone, extraction readiness, and AI README generation.
3. Update handoff docs again after BrowserPod real-repo validation is complete.

---

## Bottom Line

- Engineer A work is mostly done and mostly verified.
- Engineer B implementation is effectively in place, including the prompt files and extraction orchestration.
- Live OpenRouter chat and smoke extraction were validated locally before the DeepSeek-only switch; the current DeepSeek model still needs one live validation pass.
- The main gap is real frontend/BrowserPod validation with actual GitHub repos.
