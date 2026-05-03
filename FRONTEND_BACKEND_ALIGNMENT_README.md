# Frontend Alignment Guide for DevHub Backend Security and Runtime Profiles

## Status

The backend work needed for this frontend integration is implemented on the `runtime-profile-inference` branch. It includes the earlier runtime security telemetry work as well.

BrowserPod is mandatory for frontend execution.

- All executable repo actions in the frontend must run through BrowserPod only.
- No local shell, no host Node.js process, and no fallback execution path outside BrowserPod.
- Manual commands are sandbox commands, not machine commands.
- If the frontend cannot run a command in BrowserPod, it should not run it at all.

Validated backend state:

- `npm test`: 70 tests passing
- `npm run build`: passing
- Runtime profile fields are returned through `GET /api/ai/extract/:repoId`
- Runtime BrowserPod security events can be posted to the backend
- Run requests are gated when security risk or runnability needs user confirmation

This branch must be merged and deployed before the frontend can rely on the new fields in production.

## What Changed in the Backend

The backend now answers four separate questions instead of collapsing everything into `canRun`:

1. What kind of repo is this?
2. Is it previewable in BrowserPod?
3. What command should be auto-run, if any?
4. What manual commands should be suggested when auto-run is unsafe or unclear?

The frontend should use these new semantics instead of treating every `canRun: false` repo as a failure.

## Main Frontend Rule

Use `runnability.runtimeProfile` as the source of truth for repo type and preview behavior.

Use `runnability.canRun` only for the final yes/no decision of whether the frontend should show the normal automatic BrowserPod preview button.

BrowserPod is the only allowed runtime in the frontend. This applies to:

- automatic preview commands
- manual commands
- retries with install scripts enabled
- CLI help commands
- validation commands like `npm test`

A repo can be healthy and useful even when `canRun` is `false`. For example:

- libraries are usually `analysis-only`
- CLIs are usually `manual-only`
- test-only repos should suggest `npm test`
- unknown repos should show analysis but no preview button

## Backend Response Fields

### `RunnabilityResult`

Returned inside `GET /api/ai/extract/:repoId` as `runnability`.

```ts
type RunnabilityResult = {
  canRun: boolean;
  entryPoint: string | null;
  autoCommand?: string | null;
  manualCommands?: RuntimeCommandSuggestion[];
  runtimeProfile?: RepoRuntimeProfile;
  blockers: string[];
  blockerDetails?: RunnabilityBlocker[];
  previewPath?: string;
  previewPaths?: string[];
};
```

### `RepoRuntimeProfile`

```ts
type RepoProjectKind =
  | 'preview-app'
  | 'api-server'
  | 'library'
  | 'cli'
  | 'test-only'
  | 'unknown';

type RepoRuntimeSupportLevel =
  | 'auto-preview'
  | 'manual-only'
  | 'analysis-only';

type RuntimeCommandConfidence = 'high' | 'medium' | 'low';

type RuntimeCommandSuggestion = {
  command: string;
  label: string;
  reason: string;
  confidence: RuntimeCommandConfidence;
};

type RepoRuntimeProfile = {
  projectKind: RepoProjectKind;
  supportLevel: RepoRuntimeSupportLevel;
  previewExpected: boolean;
  autoCommand: string | null;
  manualCommands: RuntimeCommandSuggestion[];
  evidence: string[];
  reasoning: string;
};
```

### `RunnabilityBlocker`

```ts
type RunnabilityBlocker = {
  code:
    | 'missing-package-json'
    | 'missing-run-script'
    | 'unsupported-native-dependency'
    | 'not-preview-app'
    | 'manual-only-repo'
    | 'analysis-only-repo';
  severity: 'info' | 'warning' | 'error';
  title: string;
  description: string;
  recommendation: string;
  evidence?: string;
};
```

## Project Kind Meaning

### `preview-app`

A frontend app such as Vite, React, Next, Nuxt, Vue, or Svelte.

Expected frontend behavior:

- show normal BrowserPod preview button when `canRun` is true
- use `autoCommand`
- show preview path if provided

Example:

```json
{
  "projectKind": "preview-app",
  "supportLevel": "auto-preview",
  "previewExpected": true,
  "autoCommand": "npm run dev"
}
```

### `api-server`

A backend HTTP server such as Express, Fastify, Nest, Koa, or Hono.

Expected frontend behavior:

- show BrowserPod run button when `canRun` is true
- label preview as an API/server preview, not necessarily a visual web app
- show `previewPath` or `previewPaths` if available

Example:

```json
{
  "projectKind": "api-server",
  "supportLevel": "auto-preview",
  "previewExpected": true,
  "autoCommand": "npm run start"
}
```

### `library`

A package/library repo with exports, main/module/types fields, build scripts, tests, or package entry metadata.

Expected frontend behavior:

- do not show this as broken
- do not show a normal preview button
- show: "This is a library, not a live preview app."
- show suggested validation commands, usually `npm test` or `npm run lint`

Example:

```json
{
  "projectKind": "library",
  "supportLevel": "analysis-only",
  "previewExpected": false,
  "autoCommand": null,
  "manualCommands": [
    {
      "command": "npm test",
      "label": "Run tests",
      "reason": "The package.json test script can validate the project without opening a preview.",
      "confidence": "high"
    }
  ]
}
```

### `cli`

A command-line/tooling package with a `bin` field or CLI parser dependencies like commander, yargs, or cac.

Expected frontend behavior:

- do not show a live preview button
- show: "This is a CLI/tooling repo, not a preview app."
- show manual commands, usually a help command and tests

Example:

```json
{
  "projectKind": "cli",
  "supportLevel": "manual-only",
  "previewExpected": false,
  "autoCommand": null,
  "manualCommands": [
    {
      "command": "node bin/toolbox.js --help",
      "label": "Show CLI help",
      "reason": "The package exposes a bin entry, so help output is the safest manual check.",
      "confidence": "medium"
    }
  ]
}
```

### `test-only`

A repo with only validation-oriented scripts like test, lint, coverage, build, or harmless prepare scripts.

Expected frontend behavior:

- do not show a live preview button
- show manual validation commands
- message should say it is validation-oriented, not failed

### `unknown`

Weak or missing package/runtime evidence.

Expected frontend behavior:

- no auto preview
- show analysis results
- show: "No reliable preview command could be inferred."
- show manual commands if any were returned

## Button Decision Matrix

Use this decision order in the frontend.

### 1. Automatic BrowserPod preview

Show the normal run button only when all are true:

```ts
runnability.canRun === true
runnability.runtimeProfile?.supportLevel === 'auto-preview'
runnability.runtimeProfile?.previewExpected === true
Boolean(runnability.autoCommand || runnability.runtimeProfile?.autoCommand)
```

Button label examples:

- `preview-app`: "Run preview in BrowserPod"
- `api-server`: "Run API server in BrowserPod"

Command:

```ts
const command = runnability.autoCommand ?? runnability.runtimeProfile?.autoCommand;
```

### 2. Manual-only repo

If:

```ts
runnability.runtimeProfile?.supportLevel === 'manual-only'
```

Show:

- no normal preview button
- manual command cards
- a "Run in BrowserPod" button on each manual command card
- command logs/output in the UI after the user runs a manual command

Important:

- manual commands must still execute inside BrowserPod
- the frontend must never treat a manual command as permission to run on the host machine
- manual command buttons do not require a portal URL
- manual commands should not call `/api/repos/:id/run` unless they actually produce a BrowserPod portal
- use runtime security events to report timeouts, stop failures, suspicious logs, or resource abuse from manual commands

BrowserPod can run more than preview commands. The frontend should treat commands in two modes:

1. Preview mode: runs `npm run dev`, `npm run start`, or `npm run serve`, waits for a BrowserPod portal, then calls `/api/repos/:id/run` with the portal URL.
2. Task mode: runs commands like `npm test`, `npm run lint`, or CLI help commands inside BrowserPod, streams output/logs, skips portal wait, and does not mark the repo as preview-running.

### 3. Analysis-only repo

If:

```ts
runnability.runtimeProfile?.supportLevel === 'analysis-only'
```

Show:

- no run button by default
- analysis, README, security, dependency info
- manual suggestions only if backend returned them

### 4. Missing runtime profile fallback

The frontend should be backward compatible:

```ts
if (!runnability.runtimeProfile) {
  // old backend fallback
  if (runnability.canRun && runnability.entryPoint) {
    command = `npm run ${runnability.entryPoint}`;
  } else {
    show blockers or generic non-runnable state;
  }
}
```

## Security Fields

Static security data comes from `GET /api/ai/extract/:repoId`.

```ts
type SecurityScan = {
  riskLevel: 'critical' | 'high' | 'medium' | 'low' | 'info' | 'unknown';
  summary: string;
  findings: SecurityFinding[];
  dependencyRisks: SecurityDependencyRisk[];
  scannedFiles: string[];
  notes: string[];
};
```

The backend now has better security behavior:

- known bad package versions are detected from lockfiles
- harmless `prepare: npm run build` style scripts are lower risk
- suspicious `postinstall` scripts with remote fetch or shell pipes are higher risk
- security classification is separate from run classification

Frontend should show security results separately from runtime profile.

A library with security findings is still a library. Do not label it as "failed to run" just because it is not previewable.

## Runtime Security Events

The frontend must report BrowserPod runtime problems to the backend.

Endpoint:

```http
POST /api/repos/:id/security-events
```

Request shape:

```ts
type RuntimeSecurityEventInput = {
  source: 'browserpod' | 'frontend';
  phase: 'clone' | 'install' | 'start' | 'preview' | 'stop' | 'runtime';
  category:
    | 'filesystem'
    | 'network'
    | 'process'
    | 'resource'
    | 'install'
    | 'sandbox'
    | 'runtime'
    | 'other';
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  title: string;
  description: string;
  evidence?: string;
  command?: string;
};
```

Response shape:

```ts
type RuntimeSecurityEventResponse = {
  success: true;
  event: RuntimeSecurityEvent;
  runtimeSecurity: {
    riskLevel: 'critical' | 'high' | 'medium' | 'low' | 'info' | 'unknown';
    eventCount: number;
    latestEventAt: string | null;
  };
};
```

Combined security endpoint:

```http
GET /api/repos/:id/security
```

Response shape:

```ts
type RepoSecurityResponse = {
  success: true;
  repoId: string;
  staticSecurity: SecurityScan | null;
  runtimeSecurity: {
    riskLevel: 'critical' | 'high' | 'medium' | 'low' | 'info' | 'unknown';
    eventCount: number;
    latestEventAt: string | null;
    events: RuntimeSecurityEvent[];
  };
  runnability: RunnabilityResult | null;
};
```

## Run Endpoint Behavior

Endpoint:

```http
POST /api/repos/:id/run
```

Request shape:

```ts
type RunRepoRequest = {
  portalUrl: string;
  sandboxConfirmed?: boolean;
  manualOverride?: boolean;
};
```

Backend rules:

- `portalUrl` is required
- if static risk is `high` or `critical`, backend returns `409` unless `sandboxConfirmed: true`
- if `runnability.canRun` is false, backend returns `409` unless `manualOverride: true`

Frontend behavior:

- send `sandboxConfirmed: true` only after explicit high-risk confirmation
- send `manualOverride: true` only after explicit manual-run confirmation
- do not silently bypass either gate

## Recommended Frontend Flow

### Step 1. Start extraction

After repo files are available:

```http
POST /api/ai/extract/:repoId
```

Send the file tree and sampled/cached files as the current frontend already does.

### Step 2. Poll extraction state

Poll:

```http
GET /api/ai/extract/:repoId
```

Stop polling when status is ready, error, or when `analysisProgress.phase === 'complete'`.

Render:

- progress text
- status
- analysis error if present

### Step 3. Render repo profile card

Show:

- project kind
- support level
- preview expected yes/no
- reasoning
- evidence list

Suggested copy by kind:

```ts
const copyByKind = {
  'preview-app': 'Frontend preview app',
  'api-server': 'API/server project',
  library: 'Library package',
  cli: 'CLI/tooling project',
  'test-only': 'Validation-oriented repo',
  unknown: 'Unknown runtime type',
};
```

### Step 4. Render run section

For auto-preview:

- show command
- show preview paths if any
- show BrowserPod run button

For library:

- show "This is a library, not a live preview app."
- show test/lint/build commands as runnable BrowserPod task buttons
- button copy example: "Run `npm test` in BrowserPod"
- show logs/output after the command runs

For CLI:

- show "This is a CLI/tooling repo, not a preview app."
- show help/test commands as runnable BrowserPod task buttons
- button copy example: "Run CLI help in BrowserPod"
- show logs/output after the command runs

For test-only:

- show "This repository is validation-oriented and does not expose a live preview app."
- show test/coverage commands as runnable BrowserPod task buttons
- show logs/output after the command runs

For unknown:

- show "No reliable preview command could be inferred."

### Step 5. Render blocker details

If `blockerDetails` exists, show cards.

Each card should show:

- severity
- title
- description
- recommendation
- evidence

Fallback to old string blockers if needed.

```ts
const blockers = runnability.blockerDetails?.length
  ? runnability.blockerDetails
  : runnability.blockers.map((blocker) => ({
      severity: 'error',
      title: blocker,
      description: blocker,
      recommendation: 'Review repository setup and run commands.',
    }));
```

### Step 6. Render security panel

Show:

- risk badge
- summary
- findings grouped by severity
- dependency risks grouped separately
- scanned file count
- notes

Important UX rule:

Security findings are not the same thing as previewability.

A repo can be:

- previewable but risky
- non-previewable but safe
- a library with dependency risk
- a CLI with suspicious install script

### Step 7. Confirm high-risk runs

If static risk is `high` or `critical`, show a modal before BrowserPod run.

Suggested modal title:

```text
Run high-risk repository inside BrowserPod sandbox?
```

Suggested modal body:

```text
DevHub found high-risk security indicators in this repository. It may contain malicious install scripts, obfuscated code, credential theft attempts, destructive filesystem commands, or resource-heavy code.

The project will only run inside BrowserPod's isolated WebAssembly sandbox. It should not access your real filesystem, shell environment, SSH keys, cloud credentials, or local files. The sandbox can still hang, consume CPU, or fail to start.
```

Buttons:

- `Cancel`
- `Run in sandbox anyway`

Only after confirmation should the frontend use `sandboxConfirmed: true`.

### Step 8. BrowserPod execution

Never execute repo code outside BrowserPod.

This is a hard requirement, not a preference.

- no host terminal execution
- no local `npm install`
- no local `npm run dev`
- no local CLI execution
- no fallback run path if BrowserPod fails

Recommended lifecycle:

1. boot BrowserPod
2. clone repo with shallow clone if possible
3. install dependencies using safe mode first
4. start preview command if auto-preview
5. wait for portal URL
6. call backend `/run`
7. render portal
8. report runtime events as needed
9. stop/destroy sandbox on user stop

Manual task command lifecycle:

1. boot BrowserPod
2. clone repo with shallow clone if possible
3. install dependencies using safe mode first
4. run the selected manual command inside BrowserPod
5. stream stdout/stderr into the command card or terminal panel
6. skip BrowserPod portal waiting unless the user selected an auto-preview command
7. show exit status when the command finishes
8. post runtime security events for timeout, suspicious logs, resource spikes, or stop failures
9. destroy or reset the pod when the task is stopped or finished

Install command:

```bash
npm install --ignore-scripts
```

If this fails due required lifecycle scripts, show explicit retry:

```text
Retry install scripts inside sandbox
```

Only retry inside BrowserPod.

### Step 9. Timeouts

Use timeouts because malicious or broken repos can hang.

Suggested values:

- clone timeout: 60 seconds
- install timeout: 60 seconds
- preview startup timeout: 30 seconds
- stop timeout: 10 seconds

On timeout:

- stop the process if BrowserPod supports it
- otherwise destroy/recreate the pod
- post a runtime security event

## Runtime Event Examples

### Install timeout

```json
{
  "source": "browserpod",
  "phase": "install",
  "category": "resource",
  "severity": "high",
  "title": "Install timed out",
  "description": "The install command did not finish before the safety timeout.",
  "evidence": "npm install --ignore-scripts exceeded 60000ms",
  "command": "npm install --ignore-scripts"
}
```

### Preview startup timeout

```json
{
  "source": "browserpod",
  "phase": "start",
  "category": "resource",
  "severity": "high",
  "title": "Dev server did not become ready",
  "description": "The project started a process but did not expose a BrowserPod portal before the timeout.",
  "evidence": "No portal event was received within 30000ms.",
  "command": "npm run dev"
}
```

### Suspicious credential path access

```json
{
  "source": "browserpod",
  "phase": "runtime",
  "category": "filesystem",
  "severity": "high",
  "title": "Suspicious credential path access",
  "description": "Runtime logs referenced sensitive credential paths. BrowserPod isolates these paths from the real machine.",
  "evidence": "cat ~/.ssh/id_rsa"
}
```

### Destructive filesystem command

```json
{
  "source": "browserpod",
  "phase": "runtime",
  "category": "filesystem",
  "severity": "critical",
  "title": "Destructive filesystem command detected",
  "description": "Runtime logs included a destructive filesystem command. BrowserPod confines filesystem writes/deletes to the virtual sandbox.",
  "evidence": "rm -rf ~/.ssh ~/.aws"
}
```

### Suspicious network activity

```json
{
  "source": "browserpod",
  "phase": "runtime",
  "category": "network",
  "severity": "medium",
  "title": "Suspicious network activity",
  "description": "The project attempted network activity that may be telemetry, beaconing, or exfiltration. BrowserPod networking is proxied.",
  "evidence": "curl https://example.invalid/payload"
}
```

### Sandbox stop failure

```json
{
  "source": "browserpod",
  "phase": "stop",
  "category": "process",
  "severity": "high",
  "title": "Sandbox process did not stop cleanly",
  "description": "The frontend attempted to stop the BrowserPod process but it did not exit cleanly.",
  "evidence": "Process kill timed out after 10000ms."
}
```

## BrowserPod Preview UI Requirements

When a repo is running, show a persistent banner:

```text
Running inside BrowserPod sandbox. This project cannot access your real filesystem, shell environment, SSH keys, cloud credentials, or local files.
```

Always show:

- stop sandbox button
- risk badge
- command that was run
- project kind
- runtime event count if any

For high-risk runs, keep a warning visible while the preview is open.

## BrowserPod Manual Command UI Requirements

Manual commands are first-class actions, not just text hints.

For each `manualCommands[]` item, render:

- command label
- confidence badge
- reason text
- exact command string
- "Run in BrowserPod" button
- stdout/stderr output area after execution starts
- exit status when complete
- stop button while running

Do not wait for a portal for these commands unless the command is also the selected `autoCommand` for an auto-preview repo.

Recommended command card copy:

```text
Run in BrowserPod
```

Recommended helper:

```ts
function isPreviewCommand(runnability: RunnabilityResult | null, command: string): boolean {
  const autoCommand = runnability?.autoCommand ?? runnability?.runtimeProfile?.autoCommand;
  return Boolean(autoCommand && autoCommand === command && runnability?.runtimeProfile?.previewExpected);
}
```

Frontend execution rule:

```ts
if (isPreviewCommand(runnability, command)) {
  await runBrowserPodPreviewCommand(command);
} else {
  await runBrowserPodTaskCommand(command);
}
```

`runBrowserPodTaskCommand()` should run the command in BrowserPod, stream logs, and skip portal URL handling.

## Suggested Component Structure

```text
RepoAnalysisPage
  ExtractionProgressPanel
  RuntimeProfileCard
  RunnabilityPanel
  SecuritySummaryPanel
  DependencyRiskList
  BrowserPodRunPanel
  ManualCommandPanel
  ManualCommandCard
  BrowserPodTaskOutput
  RuntimeSecurityTimeline
  BrowserPodPreviewFrame
  HighRiskRunDialog
```

## Suggested Client Helpers

```ts
function getAutoPreviewCommand(runnability: RunnabilityResult | null): string | null {
  if (!runnability?.canRun) return null;
  if (runnability.runtimeProfile?.supportLevel !== 'auto-preview') return null;
  if (!runnability.runtimeProfile.previewExpected) return null;
  return runnability.autoCommand ?? runnability.runtimeProfile.autoCommand;
}

function requiresSecurityConfirmation(security: SecurityScan | null): boolean {
  return security?.riskLevel === 'high' || security?.riskLevel === 'critical';
}

function isManualOnly(runnability: RunnabilityResult | null): boolean {
  return runnability?.runtimeProfile?.supportLevel === 'manual-only';
}

function isAnalysisOnly(runnability: RunnabilityResult | null): boolean {
  return runnability?.runtimeProfile?.supportLevel === 'analysis-only';
}
```

## Example Outcomes

### `event-stream`

Expected UX:

- project kind: `library`
- support level: `analysis-only`
- preview expected: false
- show manual validation command if present
- show security/dependency risks separately
- do not show "failed to run"

### `rc`

Expected UX:

- likely `library` or `test-only`
- not a preview app
- show analysis and security notes
- do not frame lack of preview as a failure

### `node-ipc`

Expected UX:

- if backend finds a preview/server script with enough evidence: auto-preview
- otherwise show manual commands and clear reasoning
- security warnings remain separate from run classification

### Vite/React app

Expected UX:

- project kind: `preview-app`
- support level: `auto-preview`
- command: `npm run dev`
- show normal BrowserPod preview button

### Express API

Expected UX:

- project kind: `api-server`
- support level: `auto-preview`
- command: `npm run start` or `npm run dev`
- show API preview/server run button
- use `previewPath` if returned

## Test Checklist for Frontend

Add tests for:

- `preview-app` with `auto-preview` shows run button
- `api-server` with `auto-preview` shows API/server run button
- `library` shows analysis-only state, not an error
- `cli` shows manual commands and no preview button
- `test-only` shows `npm test` suggestion
- `unknown` shows no reliable preview command message
- `blockerDetails` render with title, description, recommendation, evidence
- old `blockers` fallback still works
- high/critical static risk opens confirmation dialog
- confirmed high/critical run sends `sandboxConfirmed: true`
- manual override sends `manualOverride: true`
- install timeout posts `/security-events`
- start timeout posts `/security-events`
- suspicious log match posts `/security-events`
- successful portal calls `/api/repos/:id/run`
- stop button calls `/api/repos/:id/stop`
- runtime security timeline renders events from `/api/repos/:id/security`

## Frontend Rollout Order

1. Add TypeScript types for the new backend fields.
2. Update API client methods.
3. Update extraction polling to retain full `runnability` and `security` objects.
4. Build runtime profile UI.
5. Replace old run button logic with the button decision matrix.
6. Add high-risk confirmation modal.
7. Add BrowserPod timeout handling.
8. Add runtime security event reporting.
9. Add runtime security timeline.
10. Add tests for all project kinds and risk paths.

## Compatibility Notes

The frontend should tolerate missing fields until the backend branch is deployed.

Safe fallbacks:

- if `runtimeProfile` is missing, use old `canRun` and `entryPoint`
- if `manualCommands` is missing, show no manual commands
- if `blockerDetails` is missing, render string `blockers`
- if `/api/repos/:id/security` is unavailable, rely on `GET /api/ai/extract/:repoId.security`

## Definition of Done

Frontend is aligned when:

- non-preview repos are no longer shown as failed runs
- project kind is visible to the user
- auto-preview only appears for confident BrowserPod previews
- libraries and CLIs show useful manual commands
- high-risk repos require explicit sandbox confirmation
- BrowserPod timeouts report runtime security events
- static security, runtime security, and run classification are visually separate
- all old repos still work with fallback fields
