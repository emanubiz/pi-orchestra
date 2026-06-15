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
| `done` | Session completed successfully |
| `error` | Session exited with an error (message propagated to frontend) |

Status is driven by PTY lifecycle (`spawn` → `running`, `onExit` → `idle` / `done` / `error`). The frontend displays per-node error messages inline on the card when a node enters the `error` state.

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

**Terminal mirroring & PTY geometry.** Each node has a single backend PTY that can be viewed from two places: the read-only mini terminal on the node card and the interactive side-panel terminal. Both `attach_node` to the same session and replay its scrollback, but **only the interactive owner sizes the PTY** (`fit()` → `pty_resize`). Read-only mirrors attach with `spawn:false` and never resize — otherwise the PTY width would drift from the interactive xterm and pi's input line would wrap on every keystroke.

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
| UI | React 19, Vite, `@xyflow/react`, Tailwind v4 (`@tailwindcss/vite`), xterm.js, Zustand |
| Realtime | WebSocket (`@fastify/websocket`) |
| API | Fastify 5 REST (prompt CRUD, workflow CRUD, orchestration CRUD) |
| Orchestration | Node.js + `node-pty` + pi CLI + `BoardManager` |
| Handoff hook | pi extension (`call-agent.ts`) |
| Storage | SQLite (`better-sqlite3`) — prompts, workflows, boards |
| Auth (optional) | `PI_ORCHESTRA_TOKEN` — shared-secret for programmatic API |

## Project layout

```
pi-orchestra/
├── ARCHITECTURE.md          # this file
├── README.md
├── docs/
│   ├── EXTENSIONS_ROADMAP.md
│   ├── HERMES_DESKTOP.md
│   └── PROGRAMMATIC_API.md
├── prompts/                 # seed builtin markdown (9 roles)
├── backend/
│   ├── pi-extensions/
│   │   └── call-agent.ts    # @@HANDOFF / @@CARD parser
│   └── src/
│       ├── index.ts         # Fastify + REST + WS + static frontend
│       ├── db/index.ts      # SQLite schema, prompt CRUD, workflow CRUD, board CRUD
│       ├── pty/PtyHub.ts    # spawn pi, inject, handoff delivery, PTY lifecycle
│       ├── ws/handler.ts    # WebSocket protocol (attach, input, resize, graph load…)
│       ├── routes/orchestra.ts  # /api/v1/orchestra — programmatic board/flow REST API
│       ├── orchestra/BoardManager.ts  # board state + graph management, bridges db ↔ PtyHub
│       └── types.ts
└── frontend/
    └── src/
        ├── components/      # FlowCanvas, AgentNode, TerminalPanel, TerminalOverlay,
        │                    # KanbanBoard, PromptLibrary, WorkflowPicker, NodeInspector,
        │                    # SystemPromptModal, BoardTabs
        ├── stores/          # boardStore, runtimeStore, kanbanStore (zustand)
        ├── hooks/           # useOrchestraWs
        └── lib/             # api, ptyBus, termTheme, termFit
```

## WebSocket protocol

### Server → client

| Event | Payload |
|-------|---------|
| `connected` | handshake |
| `node_status` | `{ boardId, nodeId, status, message? }` |
| `pty_output` | `{ boardId, nodeId, data, replay?, cols?, rows? }` |
| `pty_size` | `{ boardId, nodeId, cols, rows }` — PTY geometry broadcast (read-only mirrors use this to scale) |
| `pty_exit` | `{ boardId, nodeId, code }` |
| `card_status` | `{ boardId, column }` |
| `stream` | `{ boardId, nodeId, kind, text }` — structured streaming (relayed from pi agent): `text`, `thinking`, `tool_start`, `tool_end` |
| `message_in` | `{ boardId, nodeId, source, text }` — completed message (relayed from pi agent) |
| `turn_end` | `{ boardId, nodeId }` — agent turn finished (relayed from pi agent); frontend flushes stream buffer |
| `error` | `{ message, boardId?, nodeId? }` |

### Client → server

| Command | Purpose |
|---------|---------|
| `load_graph` | Sync nodes/edges + cwd to PtyHub |
| `attach_node` | Subscribe to scrollback; optionally spawn pi (`spawn:false` for read-only mirrors) |
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

See [docs/PROGRAMMATIC_API.md](./docs/PROGRAMMATIC_API.md) for the full programmatic orchestration API (board lifecycle, graph load, flow execution, auth).

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` / `PI_ORCHESTRA_PORT` | `3847` | Backend listen port |
| `PI_ORCHESTRA_URL` | `http://localhost:<port>` | URL injected into pi nodes |
| `PI_ORCHESTRA_ROOT` | repo root | Bundled prompts location |
| `PI_ORCHESTRA_DATA_DIR` | `<root>/data` | SQLite database directory |
| `PI_ORCHESTRA_TOKEN` | (empty — no auth) | Shared secret for programmatic API auth |
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

## Key features

### canBeFinal — chain termination control

Each node has a `canBeFinal` flag (default: `true`). When `false`, the system prompt instructs the agent that it **must** hand off to a connected node — it is not allowed to end the chain. This is toggled live from the UI (flag icon on the node card); if a running node's finality flips, `PtyHub` injects a mid-flow rule-change notification so the agent adapts immediately.

### Prompt override

Every node carries a `promptId` (base prompt from the library) and an optional `promptOverride` string. The override replaces the base prompt content; if empty, the library prompt is used. The `NodeInspector` panel and `SystemPromptModal` provide the editing UI.

### Board persistence

Boards (cwd, label, graph snapshot) are persisted in the `boards` SQLite table. On backend restart, `BoardManager` re-hydrates all boards and replays their graphs into `PtyHub` so handles, handoff resolution, and status queries work immediately.

## Out of scope (v1 standalone)

- Per-node model config UI
- Run history / analytics
- Multi-user / RBAC
- Edge conditions / labels
