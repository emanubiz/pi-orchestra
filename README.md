# pi-orchestra

Visual canvas of **pi** agent consoles. Semi-automatic multi-agent pipeline with human intervention on any node.

This is a **web app / PWA**: React frontend + Node.js backend (Fastify + WebSocket + SQLite + PTY).

## Quick start

```bash
cd pi-orchestra
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

## Requirements

- Node.js 22+
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
| `PI_ORCHESTRA_PORT` | Backend port (default 3847) |
| `PI_ORCHESTRA_URL` | URL pi nodes use to call back (default `http://localhost:<port>`) |
| `PI_ORCHESTRA_DATA_DIR` | SQLite location |
| `PI_ORCHESTRA_TOKEN` | Shared secret for programmatic API auth (optional) |
| `VITE_API_BASE` | Custom backend URL at frontend build time |

## Documentation

| Doc | Contents |
|-----|----------|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Current system design, WS protocol, handoff |
| [docs/EXTENSIONS_ROADMAP.md](./docs/EXTENSIONS_ROADMAP.md) | VSCode, Cursor, Hermes, OpenClaw — planned integrations |
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

## Extension roadmap (not implemented yet)

Standalone is the reference implementation. Future hosts:

- **VSCode / Cursor** — webview extension with same React UI
- **Hermes Desktop** — Orchestra tab via remote dashboard or embedded webview
- **OpenClaw** — Orchestra tab via Gateway HTTP route or external WS client

Details: [docs/EXTENSIONS_ROADMAP.md](./docs/EXTENSIONS_ROADMAP.md).
