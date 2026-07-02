# Structured Agent Runtime Plan

> **Status:** implementation plan
> **Date:** 2026-07-02
> **Decision:** add a second runtime family for structured/headless agents, then
> implement **Codex** first. Do not force Codex, OpenCode, or Zero through the
> existing PTY-only `PtyRuntime` shape.

## 0. Executive Summary

PiNodes Orchestra currently treats every node runtime as a long-lived interactive
terminal process. That is the right model for `pi`, `hermes`, and `claude`, but
it is the wrong first-class abstraction for newer coding agents that already
expose structured thread/session APIs.

The next runtime expansion should introduce a **structured runtime family**:

```text
PtyHub
  ├─ PTY runtimes:        pi | hermes | claude
  └─ structured runtimes: codex | opencode | zero
```

The first production target should be `runtime: "codex"` using Codex SDK or
Codex app-server. OpenCode should follow through its server/SDK/ACP surface.
Cursor should remain a separate PTY spike. Zero should remain headless-only
unless upstream adds the missing interactive hooks.

This preserves the existing live-terminal experience for shipped runtimes while
making room for agents that provide better structured events than terminal text.

## 1. Product Contract

### 1.1 Runtime Families

| Family | Runtime | Interaction model | UI rendering |
|---|---|---|---|
| PTY | `pi`, `hermes`, `claude` | one long-lived process in `node-pty` | raw xterm stream |
| Structured | `codex`, `opencode`, `zero` | thread/session plus one turn per inject | synthesized terminal/event stream |

Structured nodes are still Orchestra nodes: they have prompts, graph edges,
Kanban status, Timeline events, watchdog behavior, and handoff semantics. The
only difference is that their output is produced from structured agent events
instead of raw PTY bytes.

### 1.2 User-Visible Behavior

- Add-agent runtime picker can show `Codex` only when available.
- Node badge shows `codex`.
- Terminal panel remains available, but output is rendered from agent events.
- Human can inject follow-up messages between turns.
- Human cannot type arbitrary bytes into an active structured turn like a shell
  terminal. The input box should submit steering/follow-up messages.
- Handoff syntax remains the same: `@@HANDOFF`, `@@CARD`, `@@DONE`.

## 2. Current Architecture Constraints

`INodeRuntime` currently assumes a PTY-like runtime:

- `spawn()` creates one long-lived process.
- `write()` sends raw bytes.
- `inject()` bracket-pastes text and submits Enter.
- `resize()` changes terminal dimensions.
- `onOutput()` receives raw terminal output.

That maps cleanly to `PtyRuntime`, `PiRuntime`, `HermesRuntime`, and
`ClaudeRuntime`. It does not map cleanly to Codex SDK/app-server, OpenCode
server/ACP, or `zero exec` because those APIs expose sessions, turns, and event
streams instead of a terminal byte stream.

The implementation should avoid overloading PTY semantics until the runtime API
becomes misleading. Introduce capabilities explicitly.

## 3. Target Runtime Interface

### 3.1 Minimal Interface Change

Keep the public shape close to `INodeRuntime`, but add a capability discriminator:

```ts
export type RuntimeKind = "pty" | "structured";

export interface INodeRuntime {
  readonly kind: RuntimeKind;
  spawn(config: RuntimeSpawnConfig): void;
  write(data: string): void;
  inject(message: string, onSubmitSent?: () => void): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  markReady(): void;
  isRunning(): boolean;
  isReady(): boolean;
  size(): { cols: number; rows: number } | undefined;
}
```

For PTY runtimes:

- `kind = "pty"`
- `write()` writes bytes.
- `resize()` resizes PTY.
- `size()` returns xterm dimensions.

For structured runtimes:

- `kind = "structured"`
- `write()` treats newline-terminated user input as a user turn, or rejects raw
  byte input with a clear terminal message.
- `resize()` is a no-op.
- `size()` returns the last requested size or `undefined`.
- `inject()` starts or steers an agent turn.

This avoids a large frontend rewrite while leaving room for a richer typed event
interface later.

### 3.2 Optional Follow-Up Refactor

After Codex ships, consider splitting the interface:

```ts
interface BaseRuntime { ... }
interface PtyNodeRuntime extends BaseRuntime { writeBytes(...); resize(...); }
interface StructuredNodeRuntime extends BaseRuntime { sendMessage(...); }
```

Do not do this first unless the minimal discriminator approach becomes
unworkable. The first release should minimize blast radius.

## 4. Codex Runtime Design

### 4.1 Preferred Backend

Use Codex SDK or Codex app-server, not the interactive TUI.

Preferred order:

1. **Codex SDK** for implementation simplicity if the TypeScript SDK is stable
   enough in local testing.
2. **Codex app-server JSON-RPC** if SDK hides needed event details.
3. **`codex exec --json`** only for a spike or fallback, because process-per-turn
   resume is simpler but less suitable for long-running node sessions.

### 4.2 Runtime State

`CodexRuntime` owns per node:

```ts
type CodexRuntimeState = {
  threadId?: string;
  runningTurn?: AbortController;
  cwd: string;
  model?: string;
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  approvalMode: "untrusted" | "on-request" | "never";
  systemPrompt: string;
  appendix: string;
  lastOutputAt: number;
  handoffCalledThisTurn: boolean;
};
```

`threadId` is scoped to `boardId:nodeId`. A restarted node starts a fresh Codex
thread unless `runtimeConfig.resumeThreadId` is explicitly supplied.

### 4.3 Runtime Config

Allow only non-secret values in persisted `runtimeConfig`:

```ts
type CodexRuntimeConfig = {
  model?: string;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  approvalMode?: "untrusted" | "on-request" | "never";
  effort?: string;
  profile?: string;
  resumeThreadId?: string;
};
```

Never store API keys, auth tokens, or app-server bearer tokens in
`runtimeConfig`. Codex credentials remain in Codex's own auth/config or process
environment.

### 4.4 Spawn Flow

`spawn(config)` should:

1. Save `RuntimeSpawnConfig`.
2. Resolve Codex availability.
3. Initialize SDK/app-server connection if needed.
4. Create a Codex thread for this node.
5. Emit synthesized output:

   ```text
   - codex session ready -
   ```

6. Mark ready and call `config.onOutput(...)`.

Unlike PTY runtimes, `spawn()` does not start model work. It prepares the
session.

### 4.5 Inject Flow

`inject(message, onSubmitSent)` should:

1. If a turn is running, queue the message or convert it to a steer operation if
   the chosen Codex API supports active-turn steering.
2. Refresh orchestration context from `PtyHub.connectionsAppendix()` through the
   existing `config.appendix` equivalent.
3. Build the user payload:

   ```text
   <orchestra system/role context>

   <latest graph appendix>

   <message>
   ```

4. Call `onSubmitSent()` immediately after the Codex turn request is accepted.
5. Notify `PtyHub.handleTurnStarted()` through the same internal path used by
   other runtimes, or add a direct internal callback method if cleaner.
6. Stream Codex events to `onOutput()` using stable terminal text:
   - assistant deltas as text
   - tool start/end as dim status lines
   - file changes as summarized lines
   - errors as red/error lines
7. On turn completion:
   - parse final assistant text for `@@HANDOFF`, `@@CARD`, `@@DONE`
   - call existing internal delivery methods or HTTP endpoints
   - call `handleTurnEnded(..., handoffCalledThisTurn)`
   - clear running state

### 4.6 Handoff Parsing

Reuse the parser semantics from existing runtime bridges. If parser logic is
duplicated today, extract a shared backend utility before implementing Codex:

```text
backend/src/orchestra/sentinels.ts
  parseHandoffs(text)
  parseCards(text)
  parseDone(text)
```

This utility should be covered by tests using examples from:

- `backend/pi-extensions/call-agent.ts`
- `backend/hermes-plugins/orchestra/__init__.py`
- `backend/claude-hooks/orchestra-hook.mjs`

Codex should not introduce a second handoff syntax.

### 4.7 Watchdog Semantics

Codex structured runtime can implement stronger turn semantics than PTY:

- Turn started: Codex API accepted the turn and emitted first turn event.
- Turn ended: Codex API emitted completion/failure.
- Handoff called: final text contained a valid `@@HANDOFF` and delivery returned
  success.

The existing watchdog should remain in `PtyHub`, not move into `CodexRuntime`.
Runtime-specific code should only report facts.

## 5. OpenCode Runtime Design

OpenCode should be the second structured runtime, not a PTY runtime by default.

Preferred path:

```text
OpenCodeRuntime
  └─ opencode serve / @opencode-ai/sdk / opencode acp
       └─ session per Orchestra node
```

Why:

- OpenCode already has a server/client architecture.
- Official docs expose `opencode serve`, an OpenAPI endpoint, an SDK, and ACP.
- `opencode run --format json` exists for automation, but server/SDK is a better
  match for live sessions.

Implementation mirrors Codex:

- Session per node.
- Inject starts a message/turn.
- Stream events into synthesized terminal output.
- Parse final assistant output for existing sentinels.
- Keep credentials in OpenCode config/env, not `runtimeConfig`.

OpenCode can later gain a PTY mode if there is strong product demand for its
native TUI, but structured mode should be the production path.

## 6. Cursor Runtime Design

Cursor should remain a PTY spike before implementation.

Candidate path:

```text
CursorRuntime extends PtyRuntime
  └─ pty.spawn("agent", ...)
       ├─ Cursor hooks for ready/turn-ended
       └─ MCP server for handoff/card if text parsing is insufficient
```

Mandatory spike checklist:

1. Spawn `agent` TUI in `node-pty`.
2. Verify ANSI rendering and resize in xterm.
3. Verify bracketed-paste submit reliability.
4. Confirm per-node role/system prompt support.
5. Confirm per-turn appendix injection support.
6. Confirm stop/turn-ended hook with final output visibility.
7. Confirm multi-node isolation in the same cwd.
8. Confirm MCP approval behavior does not block unattended handoff.

If per-turn appendix cannot be injected, do not ship native Cursor runtime.
Use Cursor as IDE host and keep `pi` provider/proxy as the practical path.

## 7. Zero Runtime Design

Zero should not be implemented as a PTY runtime unless upstream changes.

Current viable path:

```text
ZeroRuntime
  └─ zero exec --output-format stream-json --resume <session>
```

This is a structured/headless runtime:

- one Zero session per node
- one `zero exec` invocation per injected turn
- stream-json events converted to terminal output
- final event parsed for sentinels

Do not represent Zero nodes as live terminals with arbitrary byte input. That
would mislead users and fight the available API.

Revisit PTY Zero only if upstream adds:

- per-node interactive system prompt flag or environment variable
- turn-start hook
- turn-end hook with final assistant output
- per-spawn hook config or reliable env-gated hook isolation

## 8. Backend Implementation Plan

### Phase 1: Runtime Capabilities

Files:

```text
backend/src/pty/runtime/INodeRuntime.ts
backend/src/pty/runtime/PtyRuntime.ts
backend/src/pty/PtyHub.ts
backend/src/types.ts
frontend/src/types.ts
```

Tasks:

1. Add `RuntimeKind`.
2. Add `readonly kind` to `INodeRuntime`.
3. Set `kind = "pty"` in `PtyRuntime`.
4. Update tests that use runtime mocks.
5. Add `codex` to `NodeRuntime` only when Codex runtime branch is ready, not in
   the capability-only commit.

Risk: medium. `PtyHub` touches every node runtime lifecycle.

### Phase 2: Sentinel Parser Extraction

Files:

```text
backend/src/orchestra/sentinels.ts
backend/src/orchestra/sentinels.test.ts
backend/pi-extensions/call-agent.ts
backend/claude-hooks/orchestra-hook.mjs
```

Tasks:

1. Extract TypeScript parser for backend structured runtimes.
2. Keep pi/Hermes/Claude behavior unchanged initially.
3. Use parser in Codex runtime.
4. Consider migrating existing bridges later.

Risk: low if new parser is additive.

### Phase 3: Codex Availability

Files:

```text
backend/src/pty/runtime/codexAvailability.ts
backend/src/pty/runtime/codexAvailability.test.ts
backend/src/index.ts
backend/src/ws/handler.ts
frontend/src/stores/runtimeStore.ts
frontend/src/components/RuntimeSelector.tsx
```

Tasks:

1. Detect Codex CLI/SDK availability.
2. Expose `runtimes.codex` in `/api/health`, `/api/info`, and WS connect.
3. Add runtime picker option behind availability.
4. Add `PINODES_ORCHESTRA_CODEX=false|true|auto`, matching Hermes/Claude style.

Risk: low.

### Phase 4: Codex Runtime

Files:

```text
backend/src/pty/runtime/CodexRuntime.ts
backend/src/pty/runtime/CodexRuntime.test.ts
backend/src/pty/PtyHub.ts
backend/src/types.ts
frontend/src/types.ts
```

Tasks:

1. Implement `CodexRuntime`.
2. Add `runtime: "codex"` selection in `PtyHub.spawn`.
3. Convert Codex events to terminal-safe output.
4. Wire turn-started/turn-ended into the existing watchdog.
5. Parse handoff/card/done on final response.
6. Add tests for:
   - spawn readiness
   - inject starts turn
   - output streaming
   - handoff delivery
   - turn-ended without handoff triggers watchdog path
   - kill cancels active turn
   - secrets are not read from `runtimeConfig`

Risk: medium-high. This is the first structured runtime and will expose wrong
assumptions in `PtyHub`.

### Phase 5: Frontend Structured Output Polish

Files:

```text
frontend/src/components/NodeTerminal.tsx
frontend/src/components/TerminalPanel.tsx
frontend/src/components/RuntimeBadge.tsx
frontend/src/components/RuntimeSelector.tsx
frontend/src/components/*.test.tsx
```

Tasks:

1. Ensure structured output does not rely on terminal resize.
2. Show runtime-specific empty/starting/ended messages.
3. Disable or reinterpret raw byte input for structured runtimes.
4. Keep frontend changes small; output should still flow through existing
   `pty_output` events for first release.

Risk: medium. UX must not imply an interactive shell where none exists.

### Phase 6: Docs and Examples

Files:

```text
README.md
ARCHITECTURE.md
docs/README.md
docs/guides/CODEX_RUNTIME.md
docs/guides/PROGRAMMATIC_API.md
docs/checklists/PRE_MERGE_TEST_CHECKLIST.md
```

Tasks:

1. Document runtime family distinction.
2. Document Codex auth/config expectations.
3. Document `runtimeConfig` fields.
4. Add manual smoke checklist.
5. Add one example flow using Codex as reviewer or implementer.

Risk: low.

## 9. Verification Plan

Run focused checks during implementation:

```bash
npm test --workspaces --if-present
npx tsc --noEmit -p backend
npx tsc --noEmit -p frontend
npm run build
```

For extension changes:

```bash
npx tsc --noEmit -p vscode-extension
cd vscode-extension && npx vitest run
```

Manual runtime smoke:

1. Start backend/frontend.
2. Confirm `/api/info` shows `runtimes.codex`.
3. Create a board.
4. Add `Architect -> Codex Developer -> Reviewer`.
5. Run entry node.
6. Confirm Codex node receives handoff.
7. Confirm Codex output appears in terminal panel.
8. Confirm Codex can hand off downstream.
9. Confirm non-final Codex node without handoff triggers watchdog nudge.
10. Restart Codex node and verify fresh session behavior.

## 10. Security Rules

- Never persist secrets in `runtimeConfig`.
- Do not pass API keys in graph JSON, WebSocket events, or SQLite graph data.
- Codex/OpenCode/Zero credentials live in their native config or process env.
- Default Codex sandbox should be `workspace-write`, not full access.
- `danger-full-access` must require explicit `runtimeConfig` and documentation.
- Structured runtimes must log tool/command events visibly in node output.
- Remote app-server transports must be loopback-only unless explicitly
  authenticated.

## 11. Rollout Plan

1. Land capability layer with no behavior change.
2. Land Codex runtime behind `PINODES_ORCHESTRA_CODEX=false` default if there is
   uncertainty, or `auto` if availability detection is robust.
3. Enable UI option only when backend reports Codex available.
4. Keep Programmatic API accepting `runtime: "codex"` only after backend support
   is merged.
5. Add OpenCode plan/implementation after Codex stabilizes.
6. Keep Cursor and Zero documented as deferred until their spikes pass.

## 12. Non-Goals

- Do not replace `pi`, `hermes`, or `claude`.
- Do not make all runtimes structured.
- Do not embed Codex TUI in xterm for the first implementation.
- Do not add a second handoff protocol.
- Do not make MCP/control-plane work a prerequisite for runtime support.
- Do not add raw terminal input over MCP/structured runtimes by default.

## 13. Recommendation

Implement **Codex structured runtime first**. It gives the project the most
useful new runtime while forcing the right abstraction: Orchestra nodes can be
backed either by live PTYs or by structured agent sessions.

After Codex:

1. OpenCode structured runtime.
2. Cursor PTY spike.
3. Zero headless runtime only if provider breadth becomes important enough to
   justify a non-live-terminal node.
