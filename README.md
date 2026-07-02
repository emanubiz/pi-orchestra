# pinodes-orchestra

[![Open VSX](https://img.shields.io/open-vsx/v/emanubiz/pinodes-orchestra-vscode?label=Open%20VSX)](https://open-vsx.org/extension/emanubiz/pinodes-orchestra-vscode)

**Visual multi-agent orchestration on a canvas of live terminals.** Every node
is a real AI agent process (**pi** or **Hermes**, mixed freely) in its own PTY;
edges define who may hand off to whom; you can type into any terminal at any
time. Semi-automatic pipelines with a human in the loop on every node.

- **Multi-runtime nodes** — `pi` (default), `hermes --tui` and **Claude Code**, chosen per node and mixed freely on one board
- **One handoff standard** — agents delegate with `@@HANDOFF` text blocks, identical across runtimes, gated by graph edges
- **Deterministic delivery** — closed-loop submit confirmation + handoff watchdog: tasks can't silently stall
- **Kanban + Timeline** — cards advance with node status; every handoff is logged
- **29 built-in roles** — software team + research / writing / business / data pipelines
- **Programmatic API + CLI** — run whole flows from CI or scripts, no UI needed
- **IDE extension** — same canvas inside VS Code / Cursor / Windsurf, one isolated backend per window

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
parallel without sharing state (see [docs/guides/MULTI_INSTANCE.md](./docs/guides/MULTI_INSTANCE.md)).

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
[`docs/guides/EXTENSION_PUBLISHING.md`](./docs/guides/EXTENSION_PUBLISHING.md).

## Requirements

- Node.js 24.x (native modules `node-pty`/`better-sqlite3` are built for Node 24 / ABI 137)
- `@earendil-works/pi-coding-agent` globally or in `backend/node_modules`
- API keys in `~/.pi/agent/auth.json` or env vars
- *(optional)* the `hermes` CLI on PATH to enable Hermes runtime nodes — auto-detected, zero further setup ([guide](./docs/guides/HERMES_RUNTIME.md))
- *(optional)* the `claude` CLI on PATH to enable Claude Code runtime nodes — auto-detected ([guide](./docs/guides/CLAUDE_RUNTIME.md))

## Usage

1. **Left tabs**: one board per repo folder; **+** to open another path
2. Click **+ Add agent** (toolbar or empty canvas) → pick a prompt, optionally preview it, choose **pi** or **hermes** runtime, then confirm
3. Drag connections between nodes (defines hand-off permissions)
4. Select a node → interactive terminal in side panel; runtime badge on the card is read-only; **Timeline** tab shows handoff chronology
5. Per-node card controls (icons on the card header): **flag** toggles `canBeFinal` (may end the chain vs. must hand off), **shield** toggles the handoff watchdog (on = must hand off or say it's done; off = free chat), **scroll** opens the per-node system-prompt override. Kanban cards advance through columns automatically as nodes change status.
6. Agents hand off via `@@HANDOFF` blocks (see [ARCHITECTURE.md](./ARCHITECTURE.md))
7. **Save** / **Load…** for workflows (stored with cwd + entry node)
8. **Kanban** view: launch tasks into entry nodes

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
| `PINODES_ORCHESTRA_HERMES` | *(auto)* | Optional override: `false` disables Hermes; `true` forces it on. Default: detect `hermes` on backend PATH |
| `PINODES_ORCHESTRA_CLAUDE` | *(auto)* | Optional override: `false` disables Claude Code; `true` forces it on. Default: detect `claude` on backend PATH |
| `VITE_API_BASE` | Custom backend URL at frontend build time |

Two additional variables are set automatically by hosts and rarely need manual
tuning: `PINODES_ORCHESTRA_PARENT_PID` (backend self-exits if the given parent
process dies — used by the IDE extension for lifecycle) and
`PINODES_ORCHESTRA_ROOT` (override for the bundled-assets root, e.g. seed
prompts; defaults to the repo root).

When `PINODES_ORCHESTRA_TOKEN` is set, browser clients must provide it. The VS Code extension passes its `pinodesOrchestra.token` setting automatically; when no token is configured, the extension **auto-generates an ephemeral token per session** so the backend is always protected against other local processes. Standalone browser use can pass `?token=...` in the URL or store it in `localStorage` as `PINODES_ORCHESTRA_TOKEN`.

## Documentation

**Full index:** [docs/README.md](./docs/README.md)

| Doc | Contents |
|-----|----------|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | System design, runtimes, WS protocol, handoff |
| [docs/guides/HERMES_RUNTIME.md](./docs/guides/HERMES_RUNTIME.md) | Hermes nodes — setup, UI, flags |
| [docs/guides/SECURITY.md](./docs/guides/SECURITY.md) | Threat model, controls, configuration |
| [docs/roadmaps/EXTENSIONS_ROADMAP.md](./docs/roadmaps/EXTENSIONS_ROADMAP.md) | Host integrations & runtime roadmap |
| [docs/guides/PROGRAMMATIC_API.md](./docs/guides/PROGRAMMATIC_API.md) | REST/CLI API for boards, flows, auth |
| [docs/guides/MULTI_INSTANCE.md](./docs/guides/MULTI_INSTANCE.md) | Per-window backend isolation (extension) |
| [docs/guides/EXTENSION_PUBLISHING.md](./docs/guides/EXTENSION_PUBLISHING.md) | VSIX build & publish |
| [docs/guides/TEST_COVERAGE.md](./docs/guides/TEST_COVERAGE.md) | Test coverage notes |

## Built-in Prompt Library

The project ships 29 built-in system prompts (`prompts/*.md`), seeded into SQLite on first start — 14 software-team roles plus 4 non-coding pipeline packs:

**Software team (14):**

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

**Non-coding pipeline packs (15):**

| Pack | Roles |
|------|-------|
| Research & Analysis | Researcher, Fact-Checker, Analyst, Research Editor |
| Content & Writing | Content Strategist, Writer, Copy Editor, Proofreader & SEO |
| Business & Strategy | Market Analyst, Business Strategist, Financial Modeler, Strategy Reviewer |
| Data & Insights | Data Analyst, Statistician, Report Writer |

Users can create custom prompts via the UI or the REST API; custom prompts coexist with built-ins.

## Programmatic API

Board lifecycle, graph load, and flow execution are available as a REST API at `/api/v1/orchestra/*`. Useful for CI pipelines, host integrations (VSCode, Hermes, OpenClaw), and scripting.

```bash
# Create a board, load a graph, and run a flow
curl -s http://localhost:3847/api/v1/orchestra/flows \
  -H 'Content-Type: application/json' \
  -d '{ "name": "auth", "cwd": "/path/to/repo", "graph": { ... }, "message": "Implement auth", "wait": true }'
```

Details: [docs/guides/PROGRAMMATIC_API.md](./docs/guides/PROGRAMMATIC_API.md).

## Host integrations

Standalone (browser/PWA) is the reference implementation. Hosts:

- **Cursor / Windsurf / VS Code–compatible IDEs** — ✅ same extension via
  [Open VSX](https://open-vsx.org/extension/emanubiz/pinodes-orchestra-vscode)
  (see above)
- **VS Code (Marketplace)** — ✅ same extension; optional if you already use Open VSX
- **Hermes Desktop** — Orchestra tab via remote dashboard or embedded webview (planned)
- **OpenClaw** — Orchestra tab via Gateway HTTP route or external WS client (planned)

Native `runtime: "cursor"` agent nodes (beyond pi) remain on the roadmap.
Details: [docs/roadmaps/EXTENSIONS_ROADMAP.md](./docs/roadmaps/EXTENSIONS_ROADMAP.md).

## Hermes runtime nodes

See **[docs/guides/HERMES_RUNTIME.md](./docs/guides/HERMES_RUNTIME.md)** for full setup.

Summary:

- Each node: optional `runtime` (`"pi"` | `"hermes"` | `"claude"`, default `"pi"`) — **chosen at creation**, locked afterward (Claude Code: [docs/guides/CLAUDE_RUNTIME.md](./docs/guides/CLAUDE_RUNTIME.md))
- Use **+ Add agent** → prompt picker → runtime step (pi default, hermes when flag is on)
- Feature flag: Hermes auto-detected on backend PATH (`PINODES_ORCHESTRA_HERMES=false` to disable)
- Requires only the Hermes CLI on PATH — the orchestra plugin ships with the app and auto-installs + enables itself into `~/.hermes/plugins/` on first Hermes spawn (no manual setup)
- xterm renders Hermes like pi; handoff uses the **same** `@@HANDOFF` text protocol as pi (parsed by the plugin, not a native tool)

Per-turn orchestration context lands in the **user message** on Hermes (not the system prompt slot) — by design. Details in the guide and [docs/archive/HERMES_TUI_SPIKE_RESULT.md](./docs/archive/HERMES_TUI_SPIKE_RESULT.md).
