# pinodes-orchestra — Architecture

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

There is no separate *user-facing* `steer` API: intervention is **terminal-native** — you type into the pi TUI like a normal console. (Internally, the explicit-intent watchdog injects a follow-up message at `agent_end` to ask a pipeline node whether it means to hand off or is done — see *Handoff protocol*. It can be disabled per node.)

**Terminal mirroring & PTY geometry.** Each node has a single backend PTY that can be viewed from two places: the read-only mini terminal on the node card and the interactive side-panel terminal. Both `attach_node` to the same session and replay its scrollback. The node-card mirrors attach with `spawn:true, resize:false` so a board's pi sessions **boot automatically on load** (no need to open the side panel), while **only the interactive owner sizes the PTY** (`fit()` → `pty_resize`); mirrors never resize — otherwise the PTY width would drift from the interactive xterm and pi's input line would wrap on every keystroke. Because the mirror renders pi's absolute-cursor TUI at the PTY's real `cols×rows`, it scales the grid to the card width by measuring `.xterm-screen` (the true grid, not the stretched `.xterm` container) and applying a CSS transform.

## Handoff protocol

Agents delegate via a **text block** parsed by `backend/pi-extensions/call-agent.ts` on `agent_end`:

```
@@HANDOFF:<recipient-handle>
<complete, self-contained instructions for the next agent>
@@END
```

To end the chain instead of delegating, a node closes with `@@DONE` on its own line (see *Explicit intent* below).

Why output parsing instead of a custom pi tool?

- Works on **any provider**, including Cursor composer (which may not expose extension tools)
- No model cooperation required beyond following the system prompt appendix

**Recipient addressing.** Node ids are UUIDs, which models don't echo reliably, and labels (roles) repeat when a role is parallelised. So each node gets a short, unique **handle** derived from its label (`developer-1`, `developer-2`), listed in the orchestration appendix; that handle is what agents write after `@@HANDOFF:`. `PtyHub.deliverCall` resolves the recipient against the sender's *outgoing* neighbours by handle, then raw UUID, then an unambiguous label, with a single-target fallback — and nudges the sender if it still can't resolve, so a hand-off never fails silently.

**Direction & termination.** Only outgoing edges define who an agent may delegate to. The backend validates the resolved edge `source → target`, ensures the target terminal exists, and injects the message. A node with `canBeFinal = true` may end the chain (e.g. an approved final review) by not emitting a block. A node with `canBeFinal = false` **must** hand off — see determinism below.

**Per-turn orchestration context.** The appendix listing recipients, the finality rule, and the Kanban hint is **not frozen at spawn**. Each turn, the extension's `before_agent_start` hook pulls the current context from `GET /internal/orchestra-context` and refreshes the system prompt (wrapped in a sentinel so it never accumulates). A graph edit — wiring/unwiring an edge, flipping `canBeFinal` — is therefore picked up on the node's **next turn**, with no message typed into the PTY. This is deliberate: typing orchestration updates into the PTY made pi treat them as a new user task. The spawn-time appendix is still baked into `PINODES_ORCHESTRA_FALLBACK_APPENDIX` (env) so the extension degrades gracefully if the backend is briefly unreachable.

**Explicit intent (determinism).** Enforcement runs on `agent_end` — when the agent has finished its *whole* response and is awaiting input — **not** on `turn_end` (which fires once per loop iteration, mid-work). At that point the final message must carry an **explicit** terminal intent, never inferred from prose:

- one or more `@@HANDOFF:<handle> … @@END` blocks → delegate downstream (**fan-out allowed** — more than one runs agents in parallel), or
- `@@DONE` → end the chain here.

If a **pipeline node** (non-final, *or* final-but-with-outgoing-edges) ends with **neither**, the extension asks the model to choose (`pi.sendUserMessage(...)`, capped at `PINODES_ORCHESTRA_MAX_STEER_RETRIES`, default 2). A non-final node that writes `@@DONE` is rejected — it must hand off. After the cap a non-final node is reported via `/internal/handoff-failed` (`node_status: "error"` on the card); a final-capable node is allowed to end. A **pure leaf** (final, no outgoing) may end freely. Handoff delivery uses retry + backoff and is **not** retried on a deterministic rejection (unresolvable recipient). A contradictory state — `canBeFinal = false` with no outgoing edge — is rejected at graph-edit time (`BoardManager.validateGraph`).

**Per-node watchdog toggle.** The explicit-intent check can be turned **off per node** (shield icon on the card, or WS `set_enforcement` / env `PINODES_ORCHESTRA_ENFORCE`) so you can chat freely with one node without being asked "hand off or done?". Handoffs and card moves still deliver while it's off — only the confirmation prompt is suppressed. The flag is read per loop via `orchestra-context`, so toggling takes effect on the node's next turn.

**Ready-gated delivery.** A task injected into a node waits for the node's pi to report `session_start` (`POST /internal/ready`) before the paste, instead of guessing the boot time with a fixed timer. A conservative fallback timeout still fires if the extension never reports ready (old pi / load failure), so a task is never dropped.

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
| Auth | `PINODES_ORCHESTRA_TOKEN` — shared-secret for API/internal routes and WebSocket handshakes; VS Code extension auto-generates an ephemeral token when none is configured |

## Project layout

```
pinodes-orchestra/
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
│       ├── utils/security.ts    # CORS allowlist, auth token, WS handshake validation
│       ├── utils/paths.ts      # resolveCwd, resolveBoardCwd (shared path validation)
│       └── types.ts
├── frontend/
│   └── src/
│       ├── components/      # FlowCanvas, AgentNode, TerminalPanel, TerminalOverlay,
│       │                    # KanbanBoard, PromptLibrary, WorkflowPicker, NodeInspector,
│       │                    # SystemPromptModal, BoardTabs
│       ├── stores/          # boardStore, runtimeStore, kanbanStore (zustand)
│       ├── hooks/           # useOrchestraWs
│       └── lib/             # api, ptyBus, termTheme, termFit, embed (host-embed flags)
└── vscode-extension/        # VS Code host: spawns the backend, frames the UI in a webview
    └── src/                 # extension, backend (subprocess mgr), panel (webview), controlView
                             # sessionToken.ts (ephemeral auto-token), sessionToken.test.ts
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
| `node_ready` | `{ boardId, nodeId }` — pi has booted (reported `session_start`); clients clear the "starting pi…" overlay. Also sent to a late-attaching client if the node is already ready |
| `card_status` | `{ boardId, column }` |
| `enforcement` | `{ boardId, nodeId, enabled }` — per-node determinism-watchdog state (UI toggle sync) |
| `stream` | `{ boardId, nodeId, kind, text }` — structured streaming (relayed from pi agent): `text`, `thinking`, `tool_start`, `tool_end` |
| `message_in` | `{ boardId, nodeId, source, text }` — completed message (relayed from pi agent) |
| `turn_end` | `{ boardId, nodeId }` — agent turn finished (relayed from pi agent); frontend flushes stream buffer |
| `error` | `{ message, boardId?, nodeId? }` |

### Client → server

| Command | Purpose |
|---------|---------|
| `load_graph` | Sync nodes/edges + cwd to PtyHub |
| `attach_node` | Subscribe to scrollback; spawn pi if missing (`spawn`), claim PTY resize authority (`resize`). Node-card mirrors pass `resize:false` |
| `pty_input` | User keystrokes into pi |
| `pty_resize` | Terminal geometry |
| `inject_task` | Start flow at a node (Kanban / Run) |
| `track_kanban` | Enable @@CARD appendix on this board |
| `set_enforcement` | Toggle the determinism watchdog for one node (`{ nodeId, enabled }`) |
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
| `GET /internal/orchestra-context` | Per-turn appendix + recipients + finality (from pi extension) |
| `POST /internal/ready` | Ready marker — flushes queued injects (from pi extension) |
| `POST /internal/handoff-failed` | Determinism watchdog gave up → node card error (from pi extension) |

See [docs/PROGRAMMATIC_API.md](./docs/PROGRAMMATIC_API.md) for the full programmatic orchestration API (board lifecycle, graph load, flow execution, auth).

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3847` | Backend listen port |
| `PINODES_ORCHESTRA_HOST` | `127.0.0.1` | Backend listen host; use `0.0.0.0` only for explicit LAN/remote access |
| `PINODES_ORCHESTRA_ALLOWED_ORIGINS` | loopback + Vite dev origins | Extra comma-separated browser origins allowed by CORS and WebSocket Origin checks |
| `PINODES_ORCHESTRA_URL` | `http://localhost:<port>` | Callback URL injected into pi nodes |
| `PINODES_ORCHESTRA_PORT` | `PORT` | Overrides only the port in that callback URL — **not** the listen port |
| `PINODES_ORCHESTRA_ROOT` | repo root | Bundled prompts location |
| `PINODES_ORCHESTRA_DATA_DIR` | `<root>/data` | SQLite database directory |
| `PINODES_ORCHESTRA_TOKEN` | (empty — no auth) | Optional shared secret for all API/internal routes and WebSocket handshakes except `/api/health`; standalone browser clients pass it with `?token=...` or `localStorage.PINODES_ORCHESTRA_TOKEN`. **The VS Code extension auto-generates an ephemeral token per session when this is not set** (see `vscode-extension/src/sessionToken.ts`) |
| `PINODES_ORCHESTRA_MAX_STEER_RETRIES` | `2` | Confirm retries before a non-final node that won't hand off is marked `error` |
| `PINODES_ORCHESTRA_ENFORCE` | `true` | Default for the per-node determinism watchdog (`false` = off everywhere unless re-enabled per node) |
| `VITE_API_BASE` | (empty) | Frontend build-time backend URL |

## Multi-board (repo tabs)

Each board tab = one `cwd` + workflow snapshot + isolated `boardId:nodeId` PTY sessions.

- Left sidebar: tabs per repo, **+** to add (validates via `/api/validate-path`)
- Switching tab loads snapshot and syncs graph via `load_graph`
- Runtime state keyed by `boardId:nodeId`
- **Stop board** aborts only the active board's nodes

When **embedded in a host** (VS Code) the iframe URL carries `?embed=vscode&cwd=…`: the frontend collapses to a single board bound to the host workspace folder (`boardStore.bindWorkspace`) and hides the repo-tab sidebar — the host already owns the "current project". See `frontend/src/lib/embed.ts` and [docs/EXTENSIONS_ROADMAP.md](./docs/EXTENSIONS_ROADMAP.md).

## Views

| View | Purpose |
|------|---------|
| **Agents** | Flow canvas + terminals + inspector |
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

Each node has a `canBeFinal` flag (default: `true`). When `false`, the per-turn orchestration appendix instructs the agent that it **must** hand off to a connected node — it is not allowed to end the chain — and the explicit-intent watchdog enforces it on `agent_end` (ask-to-confirm, then `error`; see *Handoff protocol → Explicit intent*). This is toggled live from the UI (flag icon on the node card); the change is read on the node's **next turn** via the per-turn context refresh (see *Handoff protocol → Per-turn orchestration context*), not pushed into a running pi. A node cannot be `canBeFinal = false` with no outgoing edge — that contradictory state is rejected at graph-edit time by `BoardManager.validateGraph`.

### Prompt override

Every node carries a `promptId` (base prompt from the library) and an optional `promptOverride` string. The override replaces the base prompt content; if empty, the library prompt is used. The `NodeInspector` panel and `SystemPromptModal` provide the editing UI.

### Board persistence

Boards (cwd, label, graph snapshot) are persisted in the `boards` SQLite table. On backend restart, `BoardManager` re-hydrates all boards and replays their graphs into `PtyHub` so handles, handoff resolution, and status queries work immediately.

## Out of scope (v1 standalone)

- Per-node model config UI
- Run history / analytics
- Multi-user / RBAC
- Edge conditions / labels (`@@HANDOFF:<handle> IF <condition>` guards)
- Handoff log / timeline panel (a view of the from→to handoff stream; `handoff-failed` would surface here too)
- CLI `--json` flag (machine-readable output; the CLI prints human-friendly text today)
