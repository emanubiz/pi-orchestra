# Programmatic API

REST and CLI surface for **host integrations** — Hermes Desktop tab, OpenClaw plugin, VSCode/Cursor extension, CI pipelines.

> **Status:** P0 and P2 orchestration endpoints are implemented and stable. This includes the CLI wrapper and granular node/edge editing.

## Design goals

1. Hosts can **create and run flows without the UI**
2. Same graph model as the canvas (`WorkflowGraph`)
3. UI and API share one backend — no divergent code paths
4. Idempotent operations where possible (safe for CI retry)

## Base URL

```
http://localhost:3847   # default standalone
```

Listen port is set by `PORT` (default 3847). `PINODES_ORCHESTRA_URL` overrides the callback URL pi nodes use, not the port clients connect to.

---

## Implemented today

### Info & health

```http
GET /api/health
→ { ok, name, version, port }

GET /api/info
→ { ok, name, version, port, defaultCwd, wsPath }
```

> Both endpoints are stable and used by host integrations (VSCode, Hermes, OpenClaw) for readiness checks.

### Prompts

```http
GET    /api/prompts
POST   /api/prompts        { name, content }
PUT    /api/prompts/:id    { name, content }
DELETE /api/prompts/:id
```

### Workflows (persistence only)

```http
GET    /api/workflows
GET    /api/workflows/:id
POST   /api/workflows      WorkflowGraph
DELETE /api/workflows/:id
```

Saving a workflow does **not** load it into PtyHub — use orchestration endpoints below.

### Orchestration boards (live backend state)

Prefix: `/api/v1/orchestra`

```http
POST /api/v1/orchestra/boards          { cwd: string, label?: string }
GET  /api/v1/orchestra/boards
DELETE /api/v1/orchestra/boards/:boardId

PUT /api/v1/orchestra/boards/:boardId/graph    WorkflowGraph
GET /api/v1/orchestra/boards/:boardId/graph

POST /api/v1/orchestra/boards/:boardId/run     { nodeId?: string, message: string }
POST /api/v1/orchestra/boards/:boardId/stop
GET  /api/v1/orchestra/boards/:boardId/status

POST /api/v1/orchestra/boards/:boardId/nodes/:nodeId/stop
POST /api/v1/orchestra/boards/:boardId/nodes/:nodeId/inject   { message: string }
POST /api/v1/orchestra/boards/:boardId/nodes/:nodeId/input    { data: string }

POST /api/v1/orchestra/boards/:boardId/nodes              { label, promptId, position, id?, promptOverride?, canBeFinal? }
PATCH /api/v1/orchestra/boards/:boardId/nodes/:nodeId     { label?, promptId?, promptOverride?, canBeFinal?, position? }
DELETE /api/v1/orchestra/boards/:boardId/nodes/:nodeId

POST /api/v1/orchestra/boards/:boardId/edges              { sourceNodeId, targetNodeId, id? }
DELETE /api/v1/orchestra/boards/:boardId/edges/:edgeId

POST /api/v1/orchestra/flows                   { name, cwd, graph, message, wait?, waitTimeoutMs? }
```

Boards are persisted in SQLite, so they survive a backend restart. `cwd` and any `graph.cwd` are validated to be existing directories.

### Path validation

```http
POST /api/validate-path    { path }
→ { ok, path } | { ok: false, error }
```

### Internal (pi extension callbacks)

```http
POST /internal/call-agent   { boardId, fromNodeId, targetNodeId, message }
POST /internal/card-status  { boardId, column }
```

---

## Orchestration REST API details

Prefix: `/api/v1/orchestra`

### Boards

```http
POST /api/v1/orchestra/boards
Body: { cwd: string, label?: string }
→ { boardId, cwd, label }

GET /api/v1/orchestra/boards
→ { boards: [{ boardId, cwd, label, nodeCount, runningCount }] }

DELETE /api/v1/orchestra/boards/:boardId
→ { ok: true }
```

### Graph (load into live backend)

```http
PUT /api/v1/orchestra/boards/:boardId/graph
Body: WorkflowGraph
→ { ok: true, nodeIds: string[] }

GET /api/v1/orchestra/boards/:boardId/graph
→ WorkflowGraph
```

Equivalent WebSocket command: `{ type: "load_graph", graph, cwd }`.

### Execution

```http
POST /api/v1/orchestra/boards/:boardId/run
Body: {
  nodeId?: string,         # defaults to entryNodeId
  message: string,
}
→ { ok: true, boardId, nodeId }

POST /api/v1/orchestra/boards/:boardId/nodes/:nodeId/inject
Body: { message: string }
→ { ok: true }
# Equivalent WS: inject_task

POST /api/v1/orchestra/boards/:boardId/nodes/:nodeId/input
Body: { data: string }     # raw terminal bytes
→ { ok: true }
# Equivalent WS: pty_input

POST /api/v1/orchestra/boards/:boardId/stop
→ { ok: true, killed: number }
# Equivalent WS: stop_board

POST /api/v1/orchestra/boards/:boardId/nodes/:nodeId/stop
→ { ok: true }
# Equivalent WS: abort_node
```

### Status

```http
GET /api/v1/orchestra/boards/:boardId/status
→ {
  boardId,
  cwd,
  label,
  nodes: [{ nodeId, label, status, startedAt? }],
  edges: [{ sourceNodeId, targetNodeId }]
}
```

### High-level flow helper (CI / hosts)

```http
POST /api/v1/orchestra/flows
Body: {
  name: string,
  cwd: string,
  entryNodeId?: string,
  graph: WorkflowGraph,
  message: string,
  wait?: boolean,              # block until entry node PTY exits
  waitTimeoutMs?: number
}
→ {
  ok: true,
  boardId,
  flowId,
  status: "running" | "done",
  nodeId,
  timedOut?: boolean
}
```

> **Note:** When `wait: true` and the flow completes (`timedOut: false`), the temporary
> board is automatically deleted to avoid leaking resources. The `boardId` in the
> response is provided for reference but subsequent requests to it will return 404.
> If the flow times out (`timedOut: true`) the board is kept so you can inspect
> or interact with it via the CLI or UI.

Example:

```bash
curl -s http://localhost:3847/api/v1/orchestra/flows \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Implement auth",
    "cwd": "/path/to/repo",
    "graph": {
      "name": "auth flow",
      "nodes": [
        { "id": "arch", "label": "Architect", "promptId": "builtin-architect", "position": { "x": 0, "y": 0 } },
        { "id": "dev", "label": "Developer", "promptId": "builtin-developer", "position": { "x": 300, "y": 0 } }
      ],
      "edges": [
        { "id": "e1", "sourceNodeId": "arch", "targetNodeId": "dev" }
      ],
      "entryNodeId": "arch"
    },
    "message": "Design and implement the auth module",
    "wait": true,
    "waitTimeoutMs": 120000
  }'
```

---

## Auth

Standalone localhost deployments can run with no auth (default). For remote embeds, set the environment variable:

```bash
PINODES_ORCHESTRA_TOKEN=<shared-secret>
```

When set, every `/api/v1/orchestra/*` request must include one of:

```http
X-PiNodes-Orchestra-Token: <shared-secret>
# or
Authorization: Bearer <shared-secret>
```

Missing or invalid tokens receive `401 Unauthorized`.

---

## CLI Wrapper (Implemented)

The `pinodes-orchestra` CLI wraps the REST API for scripting and CI.

**Installation & Setup**
Run via npm: `npm run cli -- <command>`
Env vars: `PINODES_ORCHESTRA_URL` (default `http://localhost:3847`), `PINODES_ORCHESTRA_TOKEN`.

**Available Commands:**
- `board create <cwd> [label]` | `board list` | `board delete <id>` | `board status <id>` | `board graph <id> [file.json]`
- `node add <boardId> <label> <promptId> [--x X] [--y Y] [--override O] [--canBeFinal bool]`
- `node update <boardId> <nodeId> [--label L] [--promptId P] [--override O] [--canBeFinal bool] [--x X] [--y Y]`
- `node delete <boardId> <nodeId>`
- `edge add <boardId> <srcId> <tgtId>` | `edge delete <boardId> <edgeId>`
- `run <boardId> <message> [--nodeId NID]`
- `inject <boardId> <nodeId> <message>`
- `stop <boardId>`
- `flow <name> <cwd> <graph.json> <message> [--wait] [--timeout MS]`


---

## WebSocket (live control — implemented)

Connect: `ws://localhost:3847/ws`

Prefer WebSocket for:

- streaming `pty_output`
- low-latency `pty_input`
- UI sync

Prefer REST for:

- CRUD workflows/prompts/boards
- CI one-shot `flows` creation
- host integrations without persistent socket

### Example: programmatic flow start (today, via WS)

```javascript
const ws = new WebSocket("ws://localhost:3847/ws");

ws.onopen = () => {
  ws.send(JSON.stringify({
    type: "load_graph",
    boardId: "ci-board",
    cwd: "/path/to/repo",
    graph: {
      name: "CI flow",
      nodes: [
        { id: "arch", label: "Architect", promptId: "builtin-architect", position: { x: 0, y: 0 } },
        { id: "dev", label: "Developer", promptId: "builtin-developer", position: { x: 300, y: 0 } },
      ],
      edges: [
        { id: "e1", sourceNodeId: "arch", targetNodeId: "dev" },
      ],
      entryNodeId: "arch",
    },
  }));

  ws.send(JSON.stringify({
    type: "inject_task",
    boardId: "ci-board",
    nodeId: "arch",
    message: "Design the auth module for project X",
  }));
};
```

---

## Planned — node runtime field

```typescript
interface WorkflowNode {
  // ...existing fields
  runtime?: "pi" | "cursor" | "hermes" | "openclaw";
  runtimeConfig?: Record<string, unknown>;
}
```

| runtime | spawn |
|---------|-------|
| `pi` (default) | `pi` CLI via PtyHub |
| `cursor` | Cursor agent via SDK / CLI bridge |
| `hermes` | TUI gateway session |
| `openclaw` | Gateway `agent` RPC |

---

## Implementation priority

| Endpoint group | Priority | Status |
|----------------|----------|--------|
| Boards + graph + run + status | P0 | ✅ Implemented |
| Node stop / inject / input | P0 | ✅ Implemented |
| Auth token | P0 | ✅ Implemented |
| `POST /flows` | P1 | ✅ Implemented |
| CLI wrapper | P2 | ✅ Implemented |
| Granular node/edge CRUD | P2 | ✅ Implemented |
