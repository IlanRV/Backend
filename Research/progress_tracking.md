# DevHub Backend Progress Tracker

Last updated: 2026-05-02

## Snapshot

This file tracks how much of the Engineer A and Engineer B backend work is done, what has been verified locally, and what is still pending.

### Current high-level status

- Engineer A: core backend is largely implemented and locally verified.
- Engineer B: extraction pipeline, prompts, and AI routes are implemented; local fallback flow is verified.
- Main remaining blocker for full end-to-end AI validation: `OPENROUTER_API_KEY` is blank in local `server/.env`.

### Verified today

- Backend `npm run build` passes.
- Frontend `npm run build` passes.
- Backend `npm run smoke` passes against live Firestore.
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
| A6 | Chat message CRUD and history retrieval | Implemented | Present in `server/src/routes/chat.ts`; not fully exercised with live AI replies yet |
| A7 | Workspace chat endpoint | Implemented | Depends on live OpenRouter key for full response validation |
| A8 | Repo chat endpoint | Implemented | Depends on live OpenRouter key for full response validation |
| A9 | Deploy + test all endpoints | Partial | Firestore rules/indexes deployed; CRUD, extraction, run/stop verified locally; chat still needs live OpenRouter validation |

### Engineer A summary

- Implemented: 9/9 tasks
- Locally verified: 6/9 tasks fully verified, 2 implemented but not AI-validated, 1 partial
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
| B8 | Test extraction pipeline with real repos | Partial | Smoke test and BrowserPod integration path verified; live OpenRouter-backed extraction still needs API key and real repo validation |

### Engineer B summary

- Implemented: 8/8 tasks
- Locally verified: 2/8 directly verified at route level, remaining prompt/client pieces implemented and wired in, with full live AI validation pending
- Practical status: the extraction stack is in place and works locally through the fallback path; OpenRouter-backed validation is the next step

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
| 10 | Coordinate with Engineer A | Partial |

---

## Cross-Cutting Integration Notes

- Frontend BrowserPod flow sends `fileTree` as an object structure, not only as a newline string. The backend now accepts both forms.
- Frontend AI README loading no longer loops on a pending extraction state.
- Existing repos without cached extraction now return a useful pending payload instead of an error response.
- Local extraction still works even when `OPENROUTER_API_KEY` is missing, through the heuristic fallback pipeline.

---

## Remaining Work

### Highest priority

1. Add a real `OPENROUTER_API_KEY` to local `server/.env`.
2. Validate repo chat and workspace chat with live model responses.
3. Validate extraction on one or two real GitHub repos through the BrowserPod add-repo flow.

### Nice to have

1. Add a dedicated smoke test for the chat endpoints once OpenRouter credentials are available.
2. Add a documented real-repo test checklist for BrowserPod clone, extraction readiness, and AI README generation.
3. Update handoff docs again after live OpenRouter validation is complete.

---

## Bottom Line

- Engineer A work is mostly done and mostly verified.
- Engineer B implementation is effectively in place, including the prompt files and extraction orchestration.
- The main gap is not missing code anymore; it is live AI validation with a real OpenRouter key.