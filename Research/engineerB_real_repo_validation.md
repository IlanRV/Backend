# Engineer B Real-Repo Validation Checklist

Use this checklist after the backend is running with the intended OpenRouter model.

## Current Model

- Provider route: OpenRouter
- Model: `deepseek/deepseek-v4-flash`
- Fallback models: none
- Strict JSON schema response format: disabled by default to avoid an extra failed API call on unsupported models

## Wallet-Safe Defaults

- Duplicate `POST /api/ai/extract/:repoId` requests are deduped while an extraction is active.
- Completed extraction requests with the same source hash return cached results instead of starting a new model run.
- Function documentation is capped at three source chunks.
- Structured extraction stops after validation/provider failure and falls back locally instead of spending calls on later steps.
- Duplicate immediate chat sends reuse the previous assistant reply.

## Manual BrowserPod Flow

1. Start backend from `server/`: `npm run dev`.
2. Start frontend from `/Users/yusufyusuf/Documents/Frontend`: `npm run dev`.
3. Add a small Express API repo, such as TaskTracker.
4. Confirm the Add Repo modal reaches "Sending source context for AI extraction" and closes without errors.
5. Confirm the repo transitions from `cloning` to `analyzing` to `ready`.
6. Open the AI README tab and verify the README is present, specific, and not generic boilerplate.
7. Open repo chat and ask one concrete question about a documented function or route.
8. Send the exact same chat message again and confirm the backend returns a cached reply.
9. Repeat with a small frontend repo, such as MarkdownLive.

## Backend API Checks

Use the same payload twice for the same repo:

```bash
curl -X POST http://localhost:3001/api/ai/extract/<repoId> \
  -H "Content-Type: application/json" \
  -d @payload.json

curl -X POST http://localhost:3001/api/ai/extract/<repoId> \
  -H "Content-Type: application/json" \
  -d @payload.json
```

The second response should include either `"deduped": true` or `"cached": true`.

## Pass Criteria

- `GET /api/ai/extract/:repoId` returns `techStack`, `overview`, `functions`, `dependencies`, `aiReadme`, and `runnability`.
- Generated docs mention real files/functions from the repo.
- Chat replies cite extracted context and do not claim live access to files.
- Repeated extraction/chat actions do not trigger duplicate paid model calls.
