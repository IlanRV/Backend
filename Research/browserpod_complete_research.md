# BrowserPod – Complete Research & Showcase Analysis

> **Document Purpose**: Exhaustive research into BrowserPod – what it is, its evolution, every showcase project built so far, how they were created, tutorials, common pitfalls, and the patterns that emerge. This is the knowledge base for our hackathon project ideation.

---

## 1. What Is BrowserPod?

BrowserPod is a **WebAssembly-powered in-browser code sandbox** made by **Leaning Technologies** (the team behind Cheerp, CheerpJ, CheerpX, and WebVM). It lets you run **full server-side runtimes entirely in the user's browser tab** – no cloud servers, no backend infrastructure.

| Property | Detail |
|---|---|
| **NPM Package** | `@leaningtech/browserpod` |
| **Current Runtime** | Node.js 22 + bash + git + coreutils |
| **Upcoming** | Python (Apr 2026), Ruby (May), Go (Jul), Rust (Aug) |
| **Pricing** | **1,000 free hours/month**, then $0.01/hour |
| **Console** | https://console.browserpod.io |
| **GitHub** | https://github.com/leaningtech/browserpod-meta |
| **Showcase Repo** | https://github.com/leaningtech/browserpod-showcase |

---

## 2. Release History & Blog Timeline

### 2.1 Beta Announcement (Jan 2026)
- **Authors**: Alessandro Pignotti (CTO) & Stefano De Rossi (CEO)
- **Key message**: BrowserPod Beta launched with Node.js 22 support only
- **Core thesis**: Cloud sandboxes have latency, cost, and data exposure problems. BrowserPod flips the model by keeping execution in-browser via Wasm
- **Technical deep-dive**:
  - Built on 10+ years of Wasm experience (Cheerp → CheerpJ → CheerpX → WebVM)
  - Uses Linux syscall emulation layer (same one from WebVM/CheerpX)
  - Virtual filesystem uses Ext2 block device on top of streaming disk blocks via HTTP/WebSockets
  - Networking solved via edge-computing-based proxying → **Portals** (public URLs for in-browser servers)
  - Node.js V8 API calls replaced with custom browser-native implementation
  - Runs the actual unmodified Node C++ source compiled to Wasm

### 2.2 BrowserPod 1.0 (February 18, 2026)
- **Author**: Alessandro Pignotti (CTO)
- **What shipped**: Node.js as the first production-ready engine
- **Why Node first**: Node is one of the most *challenging* runtimes (package managers, build pipelines, file watchers, complex dependency trees) — forcing robustness from day one
- **4 Official Use Cases**:
  1. In-browser agentic coding (sandboxed AI code execution)
  2. Web-based IDEs and full-stack dev environments
  3. Interactive docs and live library demos
  4. Education at scale (no per-student sandbox infra)
- **Portals highlight**: Dev servers inside pods get shareable public URLs, enabling live previews, collaborative troubleshooting, and QR-code-based cross-device testing

### 2.3 BrowserPod 2.0 (April 16, 2026) — LATEST
- **Author**: Yuri Iozzelli (Senior Software Engineer)
- **Major additions**:
  - ✅ **git** — full `git clone`, `git add`, `git commit`, `git push` inside the pod
  - ✅ **bash** — real interactive shell (replaced previous `sh -c` emulation hacks)
  - ✅ **coreutils** via BusyBox — `cp`, `rm`, `ls`, `sed`, `grep`, `vi`, `curl`, etc.
- **Technical breakthrough**: Implemented `fork()` in WebAssembly (normally impossible) using compiler-injected instrumentation, stack unwinding via exceptions, and an embedded Wasm interpreter
- **Impact**: Bash enables a new level of interactivity — both for humans and AI agents. Previously you could only run commands via API; now you get a real shell session

### 2.4 Upcoming Roadmap (2026)
| Month | Milestone |
|---|---|
| April 2026 | Python support |
| May 2026 | Ruby support |
| July 2026 | Go support |
| August 2026 | Rust support |
| Late 2026 | Full Linux-class workloads (CheerpX integration) |

---

## 3. Architecture & Key Concepts

### 3.1 How It Works
```
Your Web App (Vite/React/etc)
    ↓ import @leaningtech/browserpod
    ↓ BrowserPod.boot({ apiKey })
    ↓
Wasm-compiled Node.js + bash + git
    ├── Runs in WebWorkers (true multi-threading)
    ├── Virtual POSIX filesystem (Ext2 on IndexedDB)
    ├── Linux syscall emulation layer
    └── Portals (edge proxy → public URL for each port)
```

### 3.2 Portals (The Killer Feature)
When a process inside the pod listens on a port, BrowserPod automatically creates a globally-accessible URL:
```
https://<random-string>-<port>.browserportal.io
```
- Multiple ports = multiple portal URLs
- Anyone can access the URL from anywhere (desktop, mobile, other devices)
- Close the browser tab → the portal disappears (ephemeral by design)
- Enables: live previews, multiplayer games, collaborative debugging, shareable demos

### 3.3 Cross-Origin Isolation (MUST-HAVE)
```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```
Without these headers → `SharedArrayBuffer` is unavailable → **pod will not boot**.

### 3.4 Virtual Filesystem
- POSIX-style paths (`/project/main.js`)
- Persisted via IndexedDB (scoped to origin)
- Two file modes: `"binary"` and `"utf-8"`
- File handles must be explicitly closed (`file.close()`)

---

## 4. Every Showcase Project (Detailed Breakdown)

### 4.1 🪝 General Hook
| Field | Detail |
|---|---|
| **Category** | Developer Tools |
| **What it does** | Free mock API server + webhook inspector running entirely in-browser |
| **Features** | Define custom routes, import OpenAPI/Postman specs, capture live webhooks |
| **Key BrowserPod usage** | Boots Express server in pod → Portal exposes the mock endpoints → incoming webhooks route through portal to in-browser server |
| **No account, no backend** | Everything runs client-side, nothing leaves the device |
| **Source** | `npx degit leaningtech/browserpod-showcase/tree/main/projects/api_webhook_tester` |
| **Tutorial** | https://browserpod.io/blog/api-webhook-tester |

**Pattern**: Express server → Portal URL → External services hit the portal → Pod receives the traffic

---

### 4.2 📦 Package Pod
| Field | Detail |
|---|---|
| **Category** | Developer Tools |
| **What it does** | Install, unpack, and analyze NPM packages in-browser |
| **How it works** | User types a package name → pod runs `npm install <package>` → inspects the installed files, dependencies, size |
| **Key BrowserPod usage** | Full `npm install` executes inside the pod's virtual filesystem. Real Node.js resolves dependencies |
| **Live demo** | https://package-pod.vercel.app/ |
| **Source** | `npx degit leaningtech/browserpod-showcase/.../npm_package_tester` |
| **Tutorial** | https://browserpod.io/blog/build-a-disposable-npm-package-sandbox-in-the-browser |

**Pattern**: User input → `pod.run("npm", ["install", pkg])` → read filesystem to display results

---

### 4.3 🖥️ VimAmp
| Field | Detail |
|---|---|
| **Category** | Developer Tools |
| **What it does** | Vim text editor running in the browser, backed by a BrowserPod Node.js workspace |
| **Features** | `:BPEdit` to open project files, `:BPSave` to sync buffers back, run npm/node from console |
| **How it was built** | Vim compiled to Wasm + BrowserPod provides the Node.js workspace for actually running the code you edit |
| **Source** | `npx degit leaningtech/browserpod-showcase/.../web_vim_with_node` |
| **Tutorial** | https://browserpod.io/blog/build-browser-vim-for-nodejs-that-can-open-project-files-and-run-code |

**Pattern**: Wasm Vim editor ↔ BrowserPod filesystem ↔ pod.run("node", [...]) for execution

---

### 4.4 📄 Trapeze (PDF Editor)
| Field | Detail |
|---|---|
| **Category** | Productivity |
| **What it does** | PDF editor running entirely in the browser |
| **How it was built** | BrowserPod boots an Express runtime → copies the editor project into the pod → embeds it through the portal URL in an iframe |
| **Persistence** | Draft state saved back to IndexedDB between sessions |
| **Source** | `npx degit leaningtech/browserpod-showcase/.../pdf_editor` |
| **Tutorial** | https://browserpod.io/blog/build-a-browser-based-pdf-editor-without-moving-the-whole-app-to-your-backend |

**Pattern**: Express + pdf-lib running in pod → Portal → embedded in iframe → IndexedDB for persistence

---

### 4.5 💬 Say Something (Ephemeral Survey)
| Field | Detail |
|---|---|
| **Category** | Productivity |
| **What it does** | Short-lived survey app: create a survey, share a link, collect responses, close the tab = survey gone |
| **Architecture** | BrowserPod boots Express → writes survey config into pod → creates shareable client link + admin dashboard via Portal URL |
| **Ephemeral** | Close the tab and the survey disappears. No database, no backend |
| **Live demo** | https://saysomething-xi.vercel.app/ |
| **Source** | `npx degit leaningtech/browserpod-showcase/.../ephemeral_survey` |
| **Tutorial** | https://browserpod.io/blog/build-a-short-lived-survey-app-without-keeping-a-backend-running |

**Pattern**: Express + in-memory state → Portal for respondents → admin dashboard on different route → dies with the tab

---

### 4.6 🎯 Better Demo (Project Previewer)
| Field | Detail |
|---|---|
| **Category** | Product Demos |
| **What it does** | Upload a Node.js project → get an instant interactive preview via Portal URL |
| **How it works** | User uploads a zip/project → BrowserPod boots it in a sandbox → exposes it through a portal URL → shares a live link |
| **No backend required** | Everything runs in the user's browser |
| **Source** | `npx degit leaningtech/browserpod-showcase/.../node_project_demo` |
| **Tutorial** | https://browserpod.io/blog/upload-and-preview-a-node-js-project-with-browserpod |

**Pattern**: File upload → extract to virtual FS → npm install → node start → Portal → shareable link

---

### 4.7 ♟️ PawnHub (Multiplayer Chess)
| Field | Detail |
|---|---|
| **Category** | Games |
| **What it does** | PvP chess with an in-browser WebSocket server + AI Stockfish play option |
| **Architecture** | Host opens the page → BrowserPod boots a Node.js WebSocket server → one Portal URL is all it takes to invite another player |
| **Multiplayer** | The host's browser IS the game server. Other players connect via the Portal URL |
| **No matchmaking service** | Zero backend infrastructure |
| **Source** | `npx degit leaningtech/browserpod-showcase/.../pvp_chess_via_node` |
| **Tutorial** | https://browserpod.io/blog/build-a-multiplayer-chess-demo-without-standing-up-a-backend-first |

**Pattern**: WebSocket server in pod → Portal URL → second player connects → real-time multiplayer

---

## 5. Common Patterns Across All Projects

Every showcase project follows the same core architecture:

```
1. Boot pod          → BrowserPod.boot({ apiKey })
2. Setup terminal    → pod.createDefaultTerminal(element)  [optional UI]
3. Copy files in     → pod.createFile() or git clone
4. Install deps      → pod.run("npm", ["install"], { cwd })
5. Start server      → pod.run("node", ["server.js"], { cwd })
6. Capture portal    → pod.onPortal(({ url }) => iframe.src = url)
7. Display in iframe → User sees the live app
```

### Key Technical Patterns:
- **File injection**: Use `fetch()` to grab files from your web app, then `pod.createFile()` + `file.write()` + `file.close()` to put them in the pod
- **git clone (v2.0)**: `pod.run("git", ["clone", repoUrl])` replaces manual file copying
- **Portal as iframe**: Most projects embed the portal URL in an `<iframe>` for seamless UX
- **Ephemeral by design**: Everything dies when the tab closes — great for demos, surveys, previews
- **Persistence available**: IndexedDB survives page reloads if you want it

---

## 6. Common Errors & Debugging

| Error | Cause | Fix |
|---|---|---|
| `pod.run` with `&&` or `\|` fails | `pod.run` is `execve`, not a shell | Write a JS script instead, or use bash (v2.0) |
| `The 'terminal' argument is required` | Terminal DOM element removed/unmounted | Keep `consoleEl` in DOM (hide with CSS if needed) |
| `Unsupported 'mode' argument` | Only `"binary"` or `"utf-8"` accepted | Use `"binary"` for ArrayBuffer, `"utf-8"` for strings |
| Install crashes for esbuild/rollup | Native binaries don't work in Wasm | Add `overrides` in package.json for Wasm alternatives |
| Pod won't boot | Missing COOP/COEP headers | Add both headers to your dev server config |

---

## 7. What BrowserPod Has Been Used For (Summary)

| Category | Projects | Key Insight |
|---|---|---|
| **Developer Tools** | General Hook, Package Pod, VimAmp | API mocking, package analysis, code editing — all zero-backend |
| **Productivity** | Trapeze, Say Something | PDF editing and ephemeral surveys — privacy-first |
| **Product Demos** | Better Demo | Instant shareable previews for any Node.js project |
| **Games** | PawnHub | Multiplayer WebSocket games where the host's browser IS the server |

### Cross-cutting themes:
1. **Zero backend** — Every project eliminates server infrastructure
2. **Portals are the glue** — Every project uses Portal URLs for sharing/interaction
3. **Ephemeral** — Most projects are designed to disappear when the tab closes
4. **Privacy-first** — Data never leaves the user's device
5. **Express.js dominant** — Almost every project runs an Express server inside the pod
6. **npm ecosystem** — Full npm install works, giving access to the entire Node.js package ecosystem

---

## 8. Untapped Capabilities (Not Yet Explored in Showcase)

Based on what's available in BrowserPod 2.0 but NOT yet demonstrated:

1. **git integration** — No showcase project uses `git clone` yet (all use manual file copy)
2. **bash scripting** — Interactive shell sessions not showcased
3. **Multi-pod architectures** — Running multiple pods simultaneously
4. **AI/LLM integration** — No project connects to AI APIs from within the pod
5. **Collaborative editing** — No real-time multi-user editing via Portals
6. **Build pipelines** — No CI/CD simulation demonstrated
7. **Data processing** — No data analysis/transformation tools
8. **WebSocket-based real-time apps beyond games** — Chat, collaboration tools
9. **File format conversion** — Beyond PDF editing

---

## 9. Technical Requirements Checklist (For Our Hackathon)

- [ ] Get API key from https://console.browserpod.io
- [ ] Set up Vite project with `@leaningtech/browserpod`
- [ ] Configure COOP/COEP headers in `vite.config.js`
- [ ] Store API key in `.env` as `VITE_BP_APIKEY`
- [ ] Use `overrides` in package.json for any native binary packages
- [ ] Set up Portal handler with `pod.onPortal()`
- [ ] Use `git clone` (v2.0) instead of manual file copying where possible
- [ ] Test on HTTPS for production deployment

---

*Research compiled from: BrowserPod docs, blog (beta/1.0/2.0), all 7 showcase projects, 2 demo tutorials, and debugging guide. Last updated: May 2, 2026.*
