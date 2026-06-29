# Architecture — PiNodes Orchestra

## System overview

PiNodes Orchestra is a web application (React + Fastify + WebSocket + SQLite + PTY)
that provides a visual canvas of agent consoles. Each node on the canvas is a
live terminal backed by a real AI agent process (pi or hermes) in a PTY.

```
┌─────────────────────┐     WebSocket      ┌──────────────────────┐
│   Frontend (React)  │ ◄────────────────► │   Backend (Fastify)  │
│   xterm.js + React  │                    │   /api/v1/orchestra  │
│   Flow + Kanban     │                    │   /internal/*        │
└─────────────────────┘                    └────────┬─────────────┘
                                                    │
                                          ┌─────────┴─────────┐
                                          │     PtyHub         │
                                          │  (runtime-agnostic)│
                                          └────────┬───────────┘
                                                   │
                              ┌────────────────────┼────────────────────┐
                              │                    │                    │
                     ┌────────┴────────┐  ┌───────┴────────┐         ...
                     │   PiRuntime     │  │ HermesRuntime  │
                     │  (pi CLI + PTY) │  │(hermes --tui    │
                     │  + call-agent   │  │  + PTY + plugin)│
                     └─────────────────┘  └────────────────┘
```

## Backend layers

### PtyHub (`backend/src/pty/PtyHub.ts`)

Central orchestrator — runtime-agnostic. Manages:
- **Graph**: nodes, edges, cwd per board
- **Sessions**: maps `boardId:nodeId` → `INodeRuntime` instance + scrollback buffer
- **Orchestration context**: outgoing targets, handles, canBeFinal, enforcement
- **Inject lifecycle**: ready-gated queue, fallback timeout, markReady
- **Handoff resolution**: resolves recipients by handle / UUID / partial label

### INodeRuntime (`backend/src/pty/runtime/INodeRuntime.ts`)

Interface abstracting PTY operations. Methods: `spawn(config)`, `write(data)`,
`inject(message)`, `resize(cols, rows)`, `kill()`, `markReady()`, `isRunning()`,
`isReady()`, `size()`.

### PtyRuntime (`backend/src/pty/runtime/PtyRuntime.ts`)

Abstract base class with common PTY logic (write, inject with bracketed paste,
resize, kill, state tracking). Subclasses only override `spawn()`.

### PiRuntime (`backend/src/pty/runtime/PiRuntime.ts`)

Spawns `pi` CLI with `--tools`, `--system-prompt`, `--extension call-agent.ts`.
Windows-aware (handles `.cmd`/`.bat` npm shims on PATH).

### HermesRuntime (`backend/src/pty/runtime/HermesRuntime.ts`)

Spawns `hermes --tui` with `--toolsets`. Uses `HERMES_EPHEMERAL_SYSTEM_PROMPT`
env var for per-node system prompt isolation. Orchestration hooks run via a
plugin in `~/.hermes/plugins/orchestra/`. Gated behind
`PINODES_ORCHESTRA_HERMES=true` (off by default).

### BoardManager (`backend/src/orchestra/BoardManager.ts`)

CRUD for boards, graphs, nodes, edges. Validates graph consistency (no
self-loops, non-final nodes must have outgoing edges). Persists to SQLite.

### Routes (`backend/src/routes/orchestra.ts`, `backend/src/index.ts`)

- `/api/v1/orchestra/*` — REST API for boards, graphs, nodes, edges, flows
- `/internal/*` — callbacks from pi extension and Hermes plugin
- `/internal/turn-ended` — Hermes watchdog signal (non-final node finished without handoff → nudge)
- `/ws` — WebSocket for live UI sync (pty_output, node_status, handoff events)

## Node runtime selection

```typescript
interface WorkflowNode {
  runtime?: "pi" | "hermes";  // absent = "pi" (backward compat)
  runtimeConfig?: Record<string, unknown>;  // model, toolset, flags (no secrets!)
}
```

PtyHub selects the runtime at spawn time:
- `runtime: "hermes"` + `PINODES_ORCHESTRA_HERMES=true` → HermesRuntime
- Otherwise → PiRuntime (default)

## Handoff protocol

Agents communicate through a structured handoff:

1. Agent A ends its turn with a `@@HANDOFF:<recipient-handle>` block
2. The pi extension (or Hermes plugin) calls `POST /internal/call-agent`
3. PtyHub resolves the recipient and injects the task into the target node's PTY
4. A `handoff` event is broadcast via WebSocket for the timeline

The same protocol works for both pi (via `call-agent.ts` extension) and Hermes
(via `orchestra_handoff` tool in the plugin).

## Determinism watchdog

Ensures non-final nodes always hand off:

**pi**: extension's `before_agent_start` checks if the last turn ended without
handoff → re-prompts via `sendUserMessage` (max retries, then `handoff-failed`).

**Hermes**: `post_llm_call` hook → `POST /internal/turn-ended`. If non-final and
no handoff, the backend injects a nudge into the PTY (up to `MAX_STEER_RETRIES`).

## Data flow

### Graph sync
1. Frontend serializes React Flow nodes → `WorkflowGraph` via `graphFromFlow()`
2. `PUT /api/v1/orchestra/boards/:id/graph` or WS `load_graph`
3. Backend validates → persists to SQLite → load into PtyHub

### Terminal stream
1. Agent process writes to PTY → `term.onData` → PtyHub accumulates buffer (256k scrollback)
2. PtyHub broadcasts `pty_output` via WebSocket
3. Frontend writes to xterm.js (interactive panel) or scaled mirror (node card)

### Inject flow
1. Task arrives (user starts, agent hands off, watchdog nudge)
2. `scheduleInject` → if node is spawned and ready, inject immediately
3. If not ready, queue → flushed on `markReady` (or after 10s fallback timeout)

## Security

See [docs/SECURITY.md](./docs/SECURITY.md) for the full threat model and controls.

Key points:
- Backend binds `127.0.0.1` by default
- CORS + WebSocket Origin checks prevent cross-origin attacks
- `PINODES_ORCHESTRA_TOKEN` provides shared-secret auth (required by VS Code extension)
- `runtimeConfig` must never contain secrets (credentials live in runtime-specific configs)

## Feature flags

| Flag | Default | Effect |
|------|---------|--------|
| `PINODES_ORCHESTRA_HERMES` | `false` | Enable HermesRuntime for `runtime: "hermes"` nodes |
| `PINODES_ORCHESTRA_ENFORCE` | `true` | Default determinism watchdog state (can be toggled per-node) |
