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
switcher, since the IDE already owns the cwd.

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
2. Click a prompt in the library → adds a node to the active board
3. Drag connections between nodes (defines hand-off permissions)
4. Select a node → interactive terminal in side panel
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

When `PINODES_ORCHESTRA_TOKEN` is set, browser clients must provide it. The VS Code extension passes its `pinodesOrchestra.token` setting automatically; standalone browser use can pass `?token=...` in the URL or store it in `localStorage` as `PINODES_ORCHESTRA_TOKEN`.

## Documentation

| Doc | Contents |
|-----|----------|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Current system design, WS protocol, handoff |
| [docs/EXTENSIONS_ROADMAP.md](./docs/EXTENSIONS_ROADMAP.md) | Host integrations — IDE extension (done), Hermes, OpenClaw |
| [vscode-extension/README.md](./vscode-extension/README.md) | VS Code extension — how it works, build, settings |
| [docs/HERMES_DESKTOP.md](./docs/HERMES_DESKTOP.md) | Hermes Desktop analysis |
| [docs/PROGRAMMATIC_API.md](./docs/PROGRAMMATIC_API.md) | REST/CLI API for programmatic orchestration (boards, flows, auth) |

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
