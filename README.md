# pinodes-orchestra

Visual canvas of **pi** agent consoles. Semi-automatic multi-agent pipeline with human intervention on any node.

This is a **web app / PWA**: React frontend + Node.js backend (Fastify + WebSocket + SQLite + PTY).

## Quick start

```bash
cd pinodes-orchestra
npm install
npm run dev
```

Starts:

- backend → `http://localhost:3847`
- Vite dev server → `http://localhost:5173`

Open <http://localhost:5173> in your browser.

## Production / self-hosted

```bash
npm run build
npm run start
```

Backend serves `frontend/dist` on `http://localhost:3847`.

## Install as PWA

In Chrome/Edge, use the browser **Install** action. The service worker caches static assets; agent execution still needs the backend running.

## IDE extension (Cursor, Windsurf, VS Code, …)

The same VS Code–compatible extension (`vscode-extension/`) embeds the canvas
in an editor webview. It bundles a self-contained backend (native modules per
platform) and binds the board to the open workspace folder — no repo-tab
switcher, since the IDE already owns the cwd. Each window runs its **own**
backend on its own port with an isolated database, so multiple windows work in
parallel without sharing state (see [docs/MULTI_INSTANCE.md](./docs/MULTI_INSTANCE.md)).

**Recommended — install from Open VSX** (works out of the box in **Cursor**,
**Windsurf**, and other VS Code–compatible editors):

1. Extensions panel → search **PiNodes Orchestra** (publisher: `emanubiz`)
2. Install → Activity Bar → **PiNodes Orchestra** → **Open PiNodes Orchestra**

Open VSX listing: <https://open-vsx.org/extension/emanubiz/pinodes-orchestra-vscode>

**VS Code (Marketplace or manual):** same extension ID
(`emanubiz.pinodes-orchestra-vscode`). You can also sideload a `.vsix` if you
prefer.

**Build from source** (contributors / unreleased builds):

```bash
npm run build
cd vscode-extension && npm install && npm run compile
npx @vscode/vsce package --target linux-x64   # pick your platform
code --install-extension pinodes-orchestra-vscode-*.vsix
```

Details: [`vscode-extension/README.md`](./vscode-extension/README.md),
[`docs/EXTENSION_PUBLISHING.md`](./docs/EXTENSION_PUBLISHING.md).

## Requirements

- Node.js 24.x (native modules `node-pty`/`better-sqlite3` are built for Node 24 / ABI 137)
- `@earendil-works/pi-coding-agent` globally or in `backend/node_modules`
- API keys in `~/.pi/agent/auth.json` or env vars

## Usage

1. **Left tabs**: one board per repo folder; **+** to open another path
2. Click a prompt in the library → adds a node to the active board (14 built-in roles available)
3. Drag connections between nodes (defines hand-off permissions)
4. Select a node → interactive terminal in side panel; **Timeline** tab shows handoff/event chronology
5. Agents hand off via `@@HANDOFF` blocks (see [ARCHITECTURE.md](./ARCHITECTURE.md))
6. **Save** / **Load…** for workflows (stored with cwd + entry node)
7. **Kanban** view: launch tasks into entry nodes

## Configuration

| Variable | Purpose |
|----------|---------|
| `PORT` | Port the backend listens on (default 3847) |
| `PINODES_ORCHESTRA_HOST` | Listen host (default `127.0.0.1`; set `0.0.0.0` only for explicit LAN/remote use) |
| `PINODES_ORCHESTRA_ALLOWED_ORIGINS` | Comma-separated extra browser origins allowed by CORS and WebSocket Origin checks |
| `PINODES_ORCHESTRA_URL` | Base URL pi nodes use to call back (default `http://localhost:<port>`) |
| `PINODES_ORCHESTRA_PORT` | Override only the port in that callback URL (does **not** change the listen port — set `PORT` for that) |
| `PINODES_ORCHESTRA_DATA_DIR` | SQLite location |
| `PINODES_ORCHESTRA_TOKEN` | Optional shared secret for all API/internal routes and WebSocket handshakes (except `/api/health`) |
| `VITE_API_BASE` | Custom backend URL at frontend build time |

When `PINODES_ORCHESTRA_TOKEN` is set, browser clients must provide it. The VS Code extension passes its `pinodesOrchestra.token` setting automatically; when no token is configured, the extension **auto-generates an ephemeral token per session** so the backend is always protected against other local processes. Standalone browser use can pass `?token=...` in the URL or store it in `localStorage` as `PINODES_ORCHESTRA_TOKEN`.

## Documentation

| Doc | Contents |
|-----|----------|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Current system design, WS protocol, handoff |
| [docs/SECURITY.md](./docs/SECURITY.md) | Threat model, current controls, configuration, known limitations |
| [docs/EXTENSIONS_ROADMAP.md](./docs/EXTENSIONS_ROADMAP.md) | Host integrations — IDE extension (done), Hermes, OpenClaw |
| [vscode-extension/README.md](./vscode-extension/README.md) | VS Code extension — how it works, build, settings |
| [docs/HERMES_DESKTOP.md](./docs/HERMES_DESKTOP.md) | Hermes Desktop analysis |
| [docs/PROGRAMMATIC_API.md](./docs/PROGRAMMATIC_API.md) | REST/CLI API for programmatic orchestration (boards, flows, auth) |
| [docs/MULTI_INSTANCE.md](./docs/MULTI_INSTANCE.md) | Why one backend is shared today, and the path to per-workspace isolation |
| [docs/EXPANSION_MOBILE_AND_PHYSICAL.md](./docs/EXPANSION_MOBILE_AND_PHYSICAL.md) | Visione espansione: Mobile Companion + Physical Runtime (perché, cosa, come) |
| [docs/TEST_COVERAGE.md](./docs/TEST_COVERAGE.md) | Test coverage gap review — what's covered, what was added, what's still missing |

## Built-in Prompt Library

The project ships 14 built-in system prompts (`prompts/*.md`), seeded into SQLite on first start:

| ID | Role | Focus |
|----|------|-------|
| `builtin-pm` | Project Manager | Process, planning, coordination |
| `builtin-po` | Product Owner | User stories, value, priorities, acceptance criteria |
| `builtin-architect` | Architect | High-level architecture, ADRs, trade-off analysis, design docs |
| `builtin-arch-reviewer` | Architectural Reviewer | Review architecture designs, ADRs, risk register |
| `builtin-ux` | UX/UI Designer | User flows, consistency, accessibility, states |
| `builtin-design-reviewer` | Design Reviewer | Visual audit, usability heuristics, a11y check |
| `builtin-developer` | Developer | General implementation, code quality, testing |
| `builtin-backend` | Backend Developer | API design, DB, auth, middleware, server operations |
| `builtin-frontend` | Frontend Developer | UI components, state management, styling, a11y |
| `builtin-devops` | DevOps | CI/CD, infra, monitoring, deployment |
| `builtin-qa` | QA Engineer | Test plans, automation, regression, quality gates |
| `builtin-auditor` | Auditor | 360° codebase audit: architecture, security, performance, debt |
| `builtin-security-reviewer` | Security Reviewer | Threat modelling, OWASP, dependency scanning, hardening |
| `builtin-writer` | Technical Writer | READMEs, API docs, changelogs, guides |

Users can create custom prompts via the UI or the REST API; custom prompts coexist with built-ins.

## Programmatic API

Board lifecycle, graph load, and flow execution are available as a REST API at `/api/v1/orchestra/*`. Useful for CI pipelines, host integrations (VSCode, Hermes, OpenClaw), and scripting.

```bash
# Create a board, load a graph, and run a flow
curl -s http://localhost:3847/api/v1/orchestra/flows \
  -H 'Content-Type: application/json' \
  -d '{ "name": "auth", "cwd": "/path/to/repo", "graph": { ... }, "message": "Implement auth", "wait": true }'
```

Details: [docs/PROGRAMMATIC_API.md](./docs/PROGRAMMATIC_API.md).

## Host integrations

Standalone (browser/PWA) is the reference implementation. Hosts:

- **Cursor / Windsurf / VS Code–compatible IDEs** — ✅ same extension via
  [Open VSX](https://open-vsx.org/extension/emanubiz/pinodes-orchestra-vscode)
  (see above)
- **VS Code (Marketplace)** — ✅ same extension; optional if you already use Open VSX
- **Hermes Desktop** — Orchestra tab via remote dashboard or embedded webview (planned)
- **OpenClaw** — Orchestra tab via Gateway HTTP route or external WS client (planned)

Native `runtime: "cursor"` agent nodes (beyond pi) remain on the roadmap.
Details: [docs/EXTENSIONS_ROADMAP.md](./docs/EXTENSIONS_ROADMAP.md).

## Hermes runtime nodes

Orchestra now supports **Hermes** agent nodes alongside pi. Each node has an
optional `runtime` field (`"pi"` | `"hermes"`, default `"pi"`).

**Feature flag:** Hermes nodes are gated behind `PINODES_ORCHESTRA_HERMES=true`.
When off (default), `runtime: "hermes"` degrades to pi — production is unchanged.

**Requirements for Hermes nodes:**
- Hermes installed and on PATH (`hermes --version`)
- The `orchestra` plugin installed in `~/.hermes/plugins/orchestra/`
  (bundled in `backend/hermes-plugins/orchestra/` — copy or symlink it)

**How it works:**
- Each Hermes node runs `hermes --tui` in a PTY, just like pi.
- System prompt is passed via `HERMES_EPHEMERAL_SYSTEM_PROMPT` env var
  (per-process, per-node, isolated — same as `--system-prompt` for pi).
- Orchestration hooks (handoff, context, watchdog) run via a Hermes plugin
  instead of `--extension call-agent.ts`.
- The xterm UI renders Hermes identically to pi — zero frontend changes needed.

**Where the per-turn appendix lands differs from pi — by design, not a bug.**
pi's extension refreshes the *system prompt* every turn (`before_agent_start`).
Hermes has no equivalent hook for that: `pre_llm_call` instead returns
`{"context": "<appendix>"}`, which Hermes appends to that turn's **user
message**, not the system prompt — confirmed against Hermes source
(`agent/turn_context.py`). Functionally equivalent (the model sees the
recipients/finality/kanban context every turn, never persisted into history),
but if you inspect a Hermes session's raw messages, don't expect to find the
appendix in the system prompt slot — look at the per-turn user message
instead. See [docs/HERMES_TUI_SPIKE_RESULT.md](./docs/HERMES_TUI_SPIKE_RESULT.md)
(§3, "Sistema plugin/hook") for the verified hook contract.

**Details:** [docs/HERMES_TUI_IMPLEMENTATION_PLAN.md](./docs/HERMES_TUI_IMPLEMENTATION_PLAN.md),
[docs/HERMES_TUI_SPIKE_RESULT.md](./docs/HERMES_TUI_SPIKE_RESULT.md).
