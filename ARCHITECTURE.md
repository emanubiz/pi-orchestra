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
                     ┌─────────────────────────────┼─────────────────────────────┐
                     │                             │                             │
            ┌────────┴────────┐  ┌────────────────┴─────────┐  ┌────────────────┴────────┐
            │   PiRuntime     │  │     HermesRuntime        │  │    ClaudeRuntime        │
            │  (pi CLI + PTY) │  │  (hermes --tui + PTY     │  │  (claude + PTY          │
            │  + call-agent   │  │   + orchestra plugin)    │  │   + --settings hook     │
            │                 │  │                          │  │     bridge)              │
            └─────────────────┘  └──────────────────────────┘  └─────────────────────────┘
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

Spawns `hermes chat --tui` with `-t` / toolsets. Uses `HERMES_EPHEMERAL_SYSTEM_PROMPT`
env var for per-node system prompt isolation. Orchestration hooks run via a
plugin in `~/.hermes/plugins/orchestra/`. Used when `hermes` is on the backend PATH (auto-detected).

### ClaudeRuntime (`backend/src/pty/runtime/ClaudeRuntime.ts`)

Spawns interactive `claude` with `--append-system-prompt`, `--allowedTools`
(Claude's own tool vocabulary) and `--permission-mode acceptEdits`. Orchestration
runs via lifecycle hooks passed **inline** with `--settings` (nothing written to
`~/.claude`): one bundled bridge script (`backend/claude-hooks/orchestra-hook.mjs`)
handles `SessionStart` → ready, `UserPromptSubmit` → turn-started + per-turn
appendix (`additionalContext`), and `Stop` → sentinel parsing from the transcript
+ turn-ended. Used when `claude` is on the backend PATH (auto-detected).

### BoardManager (`backend/src/orchestra/BoardManager.ts`)

CRUD for boards, graphs, nodes, edges. Validates graph consistency (no
self-loops, non-final nodes must have outgoing edges). Persists to SQLite.

### Routes (`backend/src/routes/orchestra.ts`, `backend/src/index.ts`)

- `/api/v1/orchestra/*` — REST API for boards, graphs, nodes, edges, flows
- `/internal/*` — callbacks from pi extension and Hermes plugin
- `/internal/turn-started` — closed-loop submit confirmation (agent began a turn → disarms the submit watch, marks node busy)
- `/internal/turn-ended` — agent finished a turn (marks node idle, arms parked submit watches; Hermes-only: non-final node finished without handoff → nudge)
- `/ws` — WebSocket for live UI sync (pty_output, node_status, handoff events)

## Node runtime selection

```typescript
interface WorkflowNode {
  runtime?: "pi" | "hermes" | "claude";  // absent = "pi" (backward compat)
  runtimeConfig?: Record<string, unknown>;  // model, toolset, flags (no secrets!)
}
```

PtyHub selects the runtime at spawn time:
- `runtime: "hermes"` + `hermes` on backend PATH → HermesRuntime
- `runtime: "claude"` + `claude` on backend PATH → ClaudeRuntime
- Otherwise → PiRuntime (default)

## Handoff protocol

Agents communicate through a structured handoff. The *delivery* path is identical
across runtimes (`POST /internal/call-agent` → `PtyHub.deliverCall` → inject into
the target PTY → broadcast a `handoff` WebSocket event for the timeline). All
runtimes express the handoff with **one shared text protocol** — a
`@@HANDOFF:<recipient-handle> … @@END` block (and `@@CARD`, `@@DONE`) — so there
is a single orchestration standard, not a per-runtime split. Only *where the
text is parsed* differs:

| Runtime | Where the `@@HANDOFF` block is parsed |
|---|---|
| **pi** | The `call-agent.ts` extension parses `agent_end` output and POSTs. Works on any provider, no tool support required. |
| **Hermes** | The orchestra plugin's `transform_llm_output` hook parses the turn's output and POSTs — same protocol as pi, no bespoke tool. |
| **Claude Code** | The hook bridge (`claude-hooks/orchestra-hook.mjs`, `Stop` hook) parses the turn's final transcript message and POSTs — same protocol. Sentinels stay visible in the terminal (as with pi). |

A text protocol (rather than a native tool) is deliberate: it is provider- and
runtime-agnostic and can't break on a tool-schema/dispatch mismatch. The backend
contract (`/internal/call-agent`, recipient resolution, the `handoff` event) is
identical regardless of runtime.

## Determinism watchdog

Ensures non-final nodes always hand off:

**pi**: extension's `agent_end` checks if the turn ended without
handoff → re-prompts via `sendUserMessage` (max retries, then `handoff-failed`).

**Hermes / Claude Code** (server-side, `SERVER_NUDGED_RUNTIMES`): the runtime
bridge signals `POST /internal/turn-ended` (Hermes: `post_llm_call`; Claude:
`Stop` hook), handled by `PtyHub.handleTurnEnded` (owns the per-node retry
count). If non-final and no handoff, it injects a nudge into the PTY (up to
`MAX_TURN_ENDED_RETRIES`, 3), then reports the node as errored.

## Closed-loop submit confirmation (plan B)

After injecting a task (bracketed-paste + `\r`) the backend can't observe whether
the runtime's input line actually submitted it — a timing/async race can leave the
message sitting in the prompt, never sent (the pipeline then stalls silently).
So the loop is closed on the *outcome*: the recipient starting a turn proves the
message reached the model.

- Every runtime POSTs `/internal/turn-started` once per turn (pi:
  `before_agent_start`; Hermes: `pre_llm_call`, gated once per turn; Claude:
  `UserPromptSubmit` hook).
- `PtyHub.injectAndWatch` arms a submit watch when the `\r` is written;
  `handleTurnStarted` disarms it (confirmed) and marks the node busy.
- If the watch fires (`SUBMIT_CONFIRM_MS`, 1.5s) with no confirmation, it re-sends
  just `\r` (the paste is already in the buffer — never re-pasted, so no text
  duplication) and retries up to `MAX_SUBMIT_RETRIES` (3), then surfaces a
  "delivery may be stuck" error.
- An inject that lands while a node is busy parks its watch (`pendingArm`) and
  arms it when the turn ends, so it can't false-alarm mid-turn.

This acts on the real outcome (a turn started) rather than a time estimate, so it
covers every paste/submit race regardless of its true cause — and is
runtime-agnostic (works for pi, Hermes, and a future `acp` runtime).

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

See [docs/guides/SECURITY.md](./docs/guides/SECURITY.md) for the full threat model and controls.

Key points:
- Backend binds `127.0.0.1` by default
- CORS + WebSocket Origin checks prevent cross-origin attacks
- `PINODES_ORCHESTRA_TOKEN` provides shared-secret auth (required by VS Code extension)
- `runtimeConfig` must never contain secrets (credentials live in runtime-specific configs)

## Feature flags

| Flag | Default | Effect |
|------|---------|--------|
| `PINODES_ORCHESTRA_HERMES` | auto | Optional override for Hermes: default detects CLI on PATH; `false` off; `true` force on |
| `PINODES_ORCHESTRA_CLAUDE` | auto | Optional override for Claude Code: same semantics as the Hermes flag |
| `PINODES_ORCHESTRA_ENFORCE` | `true` | Default determinism watchdog state (can be toggled per-node) |
