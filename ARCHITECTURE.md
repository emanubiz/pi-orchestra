# pi-orchestra — Architecture

Visual canvas of **pi** agent terminals connected in a graph. Semi-automatic pipeline with human intervention on any node.

## Product thesis

The core value is **not** a chatbot. It is:

- a **visual graph** of running agents
- **live terminals** embedded in each node (xterm.js)
- **human-in-the-loop** — type directly into any node's pi session
- **visible handoffs** — edges light up, output streams in real time

## Core model

- **Board** = one repo folder (`cwd`) + workflow graph + isolated pi sessions
- **Node** = one pi CLI session with a system prompt (from DB + optional override)
- **Edge** = permission: source may hand off work to target
- **Flow** = semi-automatic: starts when a message enters a node; propagates when an agent emits a hand-off block

```
User / Kanban / handoff  →  inject into node terminal
                                │
                                ▼
                           pi CLI (node-pty)
                                │
         @@HANDOFF:<handle> … @@END  →  deliverCall()  →  inject into target terminal
```

## Node states

| State | Meaning |
|-------|---------|
| `idle` | No active pi process (or exited) |
| `running` | pi terminal alive / working |

Status is driven by PTY lifecycle (`spawn` → `running`, `onExit` → `idle`).

## User intervention

| Action | Mechanism |
|--------|-----------|
| Select node | Opens interactive terminal in side panel |
| Type in terminal | `pty_input` → writes to node's pi PTY |
| Stop node | `abort_node` → kills PTY |
| Stop board | `stop_board` → kills all PTYs on board |
| Restart node | `restart_node` → kill + respawn fresh pi |
| Run from entry | `inject_task` → bracketed paste into entry node |

There is no separate `steer` API: intervention is **terminal-native** — you type into the pi TUI like a normal console.

## Handoff protocol

Agents delegate via a **text block** parsed by `backend/pi-extensions/call-agent.ts` on `turn_end`:

```
@@HANDOFF:<recipient-handle>
<complete, self-contained instructions for the next agent>
@@END
```

Why output parsing instead of a custom pi tool?

- Works on **any provider**, including Cursor composer (which may not expose extension tools)
- No model cooperation required beyond following the system prompt appendix

**Recipient addressing.** Node ids are UUIDs, which models don't echo reliably, and labels (roles) repeat when a role is parallelised. So each node gets a short, unique **handle** derived from its label (`developer-1`, `developer-2`), listed in the orchestration appendix; that handle is what agents write after `@@HANDOFF:`. `PtyHub.deliverCall` resolves the recipient against the sender's *outgoing* neighbours by handle, then raw UUID, then an unambiguous label, with a single-target fallback — and nudges the sender if it still can't resolve, so a hand-off never fails silently.

**Direction & termination.** Only outgoing edges define who an agent may delegate to. Handing off the next step is the default, but it is not mandatory: a node may end the chain (e.g. an approved final review) by not emitting a block. The backend validates the resolved edge `source → target`, ensures the target terminal exists, and injects the message.

### Kanban integration

When a board is Kanban-tracked (`track_kanban`), agents may also emit:

```
@@CARD:<column>
```

Valid columns: `todo`, `in_progress`, `test`, `review`, `done`.

## Stack

| Layer | Tech |
|-------|------|
| UI | React 19, Vite, `@xyflow/react`, Tailwind, xterm.js |
| Realtime | WebSocket |
| API | Fastify REST |
| Orchestration | Node.js + `node-pty` + pi CLI |
| Handoff hook | pi extension (`call-agent.ts`) |
| Storage | SQLite (`better-sqlite3`) |

## Project layout

```
pi-orchestra/
├── ARCHITECTURE.md          # this file
├── README.md
├── docs/
│   ├── EXTENSIONS_ROADMAP.md
│   ├── HERMES_DESKTOP.md
│   └── PROGRAMMATIC_API.md
├── prompts/                 # seed builtin markdown
├── backend/
│   ├── pi-extensions/
│   │   └── call-agent.ts    # @@HANDOFF / @@CARD parser
│   └── src/
│       ├── index.ts         # Fastify + REST + static frontend
│       ├── db/              # SQLite schema, prompts, workflows
│       ├── pty/PtyHub.ts    # spawn pi, inject, handoff delivery
│       ├── ws/handler.ts    # WebSocket protocol
│       └── types.ts
└── frontend/
    └── src/
        ├── components/      # FlowCanvas, AgentNode, TerminalPanel, KanbanBoard…
        ├── stores/          # board + runtime state (zustand)
        └── hooks/           # useOrchestraWs
```

## WebSocket protocol

### Server → client

| Event | Payload |
|-------|---------|
| `connected` | handshake |
| `node_status` | `{ boardId, nodeId, status }` |
| `pty_output` | `{ boardId, nodeId, data, replay? }` |
| `pty_exit` | `{ boardId, nodeId, code }` |
| `card_status` | `{ boardId, column }` |
| `error` | `{ message, boardId?, nodeId? }` |

### Client → server

| Command | Purpose |
|---------|---------|
| `load_graph` | Sync nodes/edges + cwd to PtyHub |
| `attach_node` | Subscribe to scrollback; optionally spawn pi |
| `pty_input` | User keystrokes into pi |
| `pty_resize` | Terminal geometry |
| `inject_task` | Start flow at a node (Kanban / Run) |
| `track_kanban` | Enable @@CARD appendix on this board |
| `restart_node` | Fresh pi session |
| `abort_node` | Kill one node |
| `stop_board` | Kill all nodes on board |

All messages may include `boardId` (defaults to `default`).

## REST API (standalone)

| Endpoint | Purpose |
|----------|---------|
| `GET /api/health` | Liveness |
| `GET /api/info` | `{ defaultCwd, port, wsPath }` |
| `GET/POST/PUT/DELETE /api/prompts` | Prompt library CRUD |
| `GET/POST/DELETE /api/workflows` | Workflow persistence |
| `POST /api/validate-path` | Validate board cwd |
| `POST /internal/call-agent` | Handoff delivery (from pi extension) |
| `POST /internal/card-status` | Kanban card move (from pi extension) |

See [docs/PROGRAMMATIC_API.md](./docs/PROGRAMMATIC_API.md) for the planned extension/orchestration API.

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` / `PI_ORCHESTRA_PORT` | `3847` | Backend listen port |
| `PI_ORCHESTRA_URL` | `http://localhost:<port>` | URL injected into pi nodes |
| `PI_ORCHESTRA_ROOT` | repo root | Bundled prompts location |
| `PI_ORCHESTRA_DATA_DIR` | `<root>/data` | SQLite database directory |
| `VITE_API_BASE` | (empty) | Frontend build-time backend URL |

## Multi-board (repo tabs)

Each board tab = one `cwd` + workflow snapshot + isolated `boardId:nodeId` PTY sessions.

- Left sidebar: tabs per repo, **+** to add (validates via `/api/validate-path`)
- Switching tab loads snapshot and syncs graph via `load_graph`
- Runtime state keyed by `boardId:nodeId`
- **Stop board** aborts only the active board's nodes

## Views

| View | Purpose |
|------|---------|
| **Agenti** | Flow canvas + terminals + inspector |
| **Kanban** | Task cards that launch boards at entry node |

## Runtime types (current + planned)

| Runtime | Status | Notes |
|---------|--------|-------|
| **pi CLI** | ✅ implemented | `PtyHub` spawns `pi` with `--extension call-agent.ts` |
| **Cursor agent** | 🔜 planned | pi with Cursor SDK bridge, or dedicated node type |
| **Hermes** | 🔜 planned | TUI gateway JSON-RPC per node |
| **OpenClaw** | 🔜 planned | Gateway `agent` RPC per node |

See [docs/EXTENSIONS_ROADMAP.md](./docs/EXTENSIONS_ROADMAP.md).

## Out of scope (v1 standalone)

- Per-node model config UI
- Run history / analytics
- Auth / multi-user
- Edge conditions / labels
