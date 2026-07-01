# Hermes TUI Runtime — Implementation Plan (Test-First)

> **Date:** 2026-06-28
> **Revision:** 2026-06-29 (v3) — **architecture decided after web research**: path A (`hermes --tui` in PTY + Hermes plugin). The "gateway/JSON-RPC" path is discarded. Full pi→Hermes mapping. See *Revision Changelog* at the bottom.
> **Status:** ✅ **Completed** — branch `feat/multi-runtime` (2026-07). Operational guide: [guides/HERMES_RUNTIME.md](../guides/HERMES_RUNTIME.md)
> **Guiding principle:** Every phase starts with tests. Never change existing behavior without first having tests that capture it. Backward compatibility always guaranteed.

---

## Architectural Decision — PATH A (`hermes --tui` in a PTY)

One Hermes node = **one `hermes --tui` process launched in a PTY**, exactly as a pi node launches a `pi` process. No external service, no JSON-RPC gateway.

**Why path A (and not the gateway):**

- `hermes --tui` is **self-sufficient**: *"By default the TUI spawns its own in-process gateway, so each TUI instance is self-contained — there's nothing to configure"* (official docs). No need to keep `hermes dashboard` running.
- Output is the **Ink TUI rendered as ANSI** in a terminal → **xterm draws it for free**, zero frontend rendering work. (This is exactly what we already do for pi.)
- It is the mode the user wants (nicer UI) and the one **recommended** by Nous for interactive use.
- It aligns with Orchestra's philosophy (*live terminals inside each node, human intervention by typing in the terminal*).

**Why NOT the gateway (path B, discarded):** it would require `hermes dashboard --tui` always running (external moving part + token that regenerates), events would be structured JSON **not** ANSI (→ substantial frontend rendering work), and it brings no advantage for our use case. It remained an option only because previous docs assumed it without verifying.

---

## pi → Hermes Mapping (full feature parity)

Hermes has a **complete plugin/hook system** (`~/.hermes/plugins/`): a Python plugin registers **custom tools** (which can do HTTP) **and** **lifecycle hooks** via `ctx.register_hook()`, and reads **env vars** set at spawn. It is the equivalent — richer — of pi's `--extension call-agent.ts`.

| What pi does | Hermes equivalent | Status |
|---|---|---|
| `--system-prompt <role>` | env **`HERMES_EPHEMERAL_SYSTEM_PROMPT=<role>`** at spawn (per-process → isolated per node, like pi) | ✅ |
| `--tools read,bash,edit,write,grep` | `--toolsets "..."` | ✅ |
| `--extension call-agent.ts` | a **plugin** `~/.hermes/plugins/orchestra/` (tool + hook) | ✅ |
| cwd (from node-pty) | cwd (from node-pty) — identical | ✅ |
| env `PINODES_ORCHESTRA_URL/_BOARD/_NODE/_TOKEN` | same env, read by the plugin (`os.environ`) | ✅ |
| hook `session_start` → `POST /internal/ready` | hook **`on_session_start`** → `POST /internal/ready` | ✅ |
| hook `before_agent_start` → `GET /internal/orchestra-context`, refresh appendix every turn | hook **`pre_llm_call`** → returns `{"context": "<appendix>"}` (injected into the turn message, every turn) | ✅ |
| textual `@@HANDOFF` parsed on `agent_end` | **custom tool `orchestra_handoff`** that the agent calls → handler does `POST /internal/call-agent` | ✅ (cleaner) |
| `@@CARD:<col>` kanban | tool `orchestra_card` (or same tool) → `POST /internal/card-status` | ✅ |
| determinism watchdog (`pi.sendUserMessage` follow-up) | hook **`post_llm_call`** → `POST /internal/turn-ended`; backend injects the nudge **via PTY** (see note below) | ⚠️ wired differently |

### Note on the watchdog (the only real "gotcha")

Hermes docs are explicit: hooks **cannot** inject follow-up messages or send new messages to the agent (only block tools, inject context, rewrite output). So the "ask again: handoff or done?" **does not** happen from a Hermes hook. **But it is not needed**, because we already own the PTY:

1. the `post_llm_call` hook (end of turn) does `POST /internal/turn-ended { session, response, handoffCalledThisTurn }`
2. the backend sees "non-final node that finished without calling `orchestra_handoff`" → **pastes the nudge into the PTY** (same mechanism we already use to inject tasks), up to `MAX_STEER_RETRIES`

The "steer" is done by the orchestrator via PTY, not a Hermes internal API. Parity maintained.

### Plugin isolation

Hermes plugins/hooks are **global** (`~/.hermes/plugins/`), not per-session. The `orchestra` plugin must therefore **auto-disable when `PINODES_ORCHESTRA_NODE` is not in the env**: it loads for all Hermes sessions on the machine but acts **only** on processes launched by Orchestra, without disturbing the user's normal Hermes usage. Gate also declarable in `plugin.yaml` (`requires_env`).

---

## To confirm in the spike (Phase -1, half day with Hermes installed)

Only two live verifications before coding Hermes (architecture is already decided):

1. **Does `HERMES_EPHEMERAL_SYSTEM_PROMPT` persist across all turns** of the session, or only the first? If first-only, the role is injected every turn via `pre_llm_call` (the plugin does this anyway). Per-node isolation is guaranteed in both cases (it is the process env).
2. **Bracketed-paste in `hermes --tui`**: is injecting tasks/nudges via PTY as reliable as with pi? (Docs say the TUI accepts queued input even before ready → promising, but needs verification.)

> Phases 0-1-2 **do not depend on these answers**: they are healthy refactoring regardless of Hermes (they also enable Cursor/OpenClaw). They can start in parallel with the spike.

---

## Separation of Responsibilities (refactor target)

| Responsibility | Owner | Notes |
|----------------|--------------|------|
| Scrollback `buffer` + broadcast `pty_output` | **PtyHub** | Generic: every runtime emits `onOutput(data)`, PtyHub accumulates (`MAX_BUFFER`) and broadcasts |
| Decide *when* to inject (ready-gate, queue, fallback) | **PtyHub** | `scheduleInject` + `markReady` + `READY_FALLBACK_MS` guard stay here |
| Decide *how* to inject (paste, submit, settle) | **Runtime** | `PiRuntime`/`HermesRuntime`: both bracketed paste + settle + `\r` (they are PTY) |
| Current `cols/rows` dimensions | **Runtime** (source of truth) | PtyHub mirrors the last known value for `pty_size` |
| Lifecycle (`spawn`/`kill`/`restart`) | **Runtime** (mechanism) + **PtyHub** (orchestration) | PtyHub maps `boardId:nodeId → INodeRuntime` |
| Exit signal for `waitForExit` | **PtyHub** | runtime's `onExit` emits `exit:${boardId}:${nodeId}` on the `EventEmitter` |
| Handoff resolution, handles, appendix, graph | **PtyHub** | Completely runtime-agnostic |


Since *both* runtimes are PTY-based, the difference between `PiRuntime` and `HermesRuntime` is minimal: **command + args + env + (for Hermes) ensure the `orchestra` plugin is installed**. Consider a parametric `PtyRuntime` base from which both derive.

---

## Phase -1 — Validation Spike (half day) 🔬

**Objective:** confirm the 2 points above with Hermes installed. **No production code.**
**Risk:** 🟢 None · **Time:** 0.5 days · **Dependencies:** None

- Launch `hermes --tui` in a terminal with `HERMES_EPHEMERAL_SYSTEM_PROMPT="You are a test"` and verify the role holds across multiple turns.
- Write a minimal `orchestra` plugin in `~/.hermes/plugins/` that: on `on_session_start` logs, on `pre_llm_call` injects fixed context, exposes a tool `orchestra_handoff` that POSTs to a dummy local server. Verify the agent calls it and the POST fires.
- Try programmatic bracketed-paste in the TUI's PTY.
- **Output:** brief outcome note in `docs/archive/HERMES_TUI_SPIKE_RESULT.md`. **Gate:** if the 2 points hold, Phases 3+ proceed as written; otherwise apply the fallback (role via `pre_llm_call`).

---

## Phase 0 — Extend the Data Model (zero behavior change)

**Objective:** Add the `runtime` field to types and graph without changing behavior.
**Risk:** 🟢 Low · **Time:** 2-3 days · **Dependencies:** None (useful regardless)

### 0.1 — Test: graph serialization with runtime field
**File:** `backend/src/db/index.test.ts` — graph with `runtime: "pi"`, with `runtime: "hermes"`, without runtime (backward compat), mixed: all save/read correctly.

### 0.2 — Test: validation with runtime field
**File:** `backend/src/orchestra/BoardManager.test.ts` — `addNode`/`updateNode` with `runtime: "hermes"` persist the field; without runtime works as today; `validateGraph` unchanged.

### 0.3 — Test: REST API with runtime field
**File:** tests for `routes/orchestra.ts` — POST/PATCH nodes accept `runtime`/`runtimeConfig`; GET/PUT graph preserve them.

### 0.4 — Implementation: types.ts (backend + frontend)
```typescript
// ADD (do not modify anything existing):
export type NodeRuntime = "pi" | "hermes";
// EXTEND WorkflowNode — optional fields:
// runtime?: NodeRuntime;                    // default "pi" if absent
// runtimeConfig?: Record<string, unknown>;  // ONLY non-secret data (see 0.7)
```
Same mirror changes in `frontend/src/types.ts`.

### 0.5 — Implementation: propagation in CRUD
`BoardManager.addNode()/updateNode()` propagate `runtime`/`runtimeConfig`. Body schemas in `routes/orchestra.ts` accept optional fields. No other changes.

### 0.6 — Validation
```bash
npm test --workspaces --if-present
npx tsc --noEmit -p backend
npx tsc --noEmit -p frontend
```
**Gate:** All tests pass. The `runtime` field is serialized but ignored by logic.

### 0.7 — ⚠️ Security constraint on `runtimeConfig`
`runtimeConfig` is persisted in `boards.graph_data` (SQLite) **and sent to the browser via WS**. Therefore:
- ✅ Allowed: model name, toolset, non-sensitive flags.
- ❌ Forbidden: any secret/token. Hermes credentials live in `~/.hermes/` or in process env, **never in the graph**.
Document the constraint in `docs/guides/SECURITY.md`.

---

## Phase 1 — Protection Tests for PtyHub (no changes to PtyHub)

**Objective:** granular safety net before Phase 2 refactor.
**Risk:** 🟢 Low · **Time:** 2-3 days · **Dependencies:** Phase 0 (recommended)

### 1.1 — Additional tests for PtyHub (`backend/src/pty/PtyHub.test.ts`)

**Spawn:** `pty.spawn` with correct args (`--tools`, `--session-id`, `--name`, `--system-prompt`, `--extension`); correct env (`PINODES_ORCHESTRA_URL/_BOARD/_NODE/_FALLBACK_APPENDIX`); with/without token; broadcast `node_status: running` + `pty_size`.
**Lifecycle:** `kill` removes session + broadcast `pty_exit`/`node_status: idle`; `restart` = fresh PTY; after `kill` → `isNodeRunning`/`isReady` false; `onExit` emits `exit:${boardId}:${nodeId}` (used by `waitForExit`).
**I/O:** `input` writes to PTY; on non-running node is no-op; `resize` updates dims + broadcast; resize on non-running no-op.
**Ready + Inject:** inject before `markReady` → queued; `markReady` flush after `READY_SETTLE_MS`; inject after ready → immediate; `restart` resets ready → next inject queued; fallback after `READY_FALLBACK_MS`; `scheduleInject` with deferred session saves in `pending` and injects at `setGraph`.
**Buffer:** accumulates up to `MAX_BUFFER`, truncates oldest; attach replay = current buffer.
**Handoff:** `deliverCall` resolves by handle / UUID / unique label; unresolvable target → error + nudge sender; valid target → `scheduleInject` + broadcast `handoff`.

### 1.2 — PTY output lifecycle
`term.onData` accumulates+broadcasts; `term.onExit` does full cleanup; "only if still the active session" guard protects restart.

### 1.3 — Validation
```bash
cd backend && npx vitest run src/pty/PtyHub.test.ts
```
**Gate:** New tests pass. PtyHub untouched.

---

## Phase 2 — Extract INodeRuntime + PiRuntime (internal refactoring)

**Objective:** extract runtime-specific operations from PtyHub into `INodeRuntime`/`PiRuntime`, zero behavior change. Valid regardless of Hermes.
**Risk:** 🟡 Medium (most delicate step) · **Time:** 1 week · **Dependencies:** Phase 1

### 2.1 — `backend/src/pty/runtime/INodeRuntime.ts`
```typescript
export interface INodeRuntime {
  spawn(config: RuntimeSpawnConfig): void; // calls onOutput/onExit
  write(data: string): void;
  inject(message: string): void;           // the "how": paste + settle + \r
  resize(cols: number, rows: number): void;
  kill(): void;
  isRunning(): boolean;
  isReady(): boolean;
  size(): { cols: number; rows: number } | undefined; // runtime = source of truth
}

export interface RuntimeSpawnConfig {
  boardId: string; nodeId: string; label: string;
  cwd: string; cols: number; rows: number;
  systemPrompt: string; appendix: string;
  orchestraUrl: string;
  runtimeConfig?: Record<string, unknown>; // non-secrets
  onOutput: (data: string) => void;
  onExit: (code: number | null) => void;
}
```

### 2.2 — `backend/src/pty/runtime/PiRuntime.ts`
Move pi-specific logic from PtyHub: `resolvePiCommand()`/`PI_BIN_NAMES`/`findInPath()`, `EXTENSION_PATH`/`hasExtension`, the `pty.spawn(...)` block with args+env, bracketed paste + `\r` submit, `READY_SETTLE_MS` settle before first paste. **Move code, do not rewrite it.**

> Suggestion: extract a `PtyRuntime` base (spawn a command in PTY, buffer-less, callbacks) and derive `PiRuntime` (pi command + args) — so `HermesRuntime` (Phase 3) is another minimal subclass.

### 2.2bis — Resolve READY_* inconsistency
- `READY_SETTLE_MS` (TUI mount before paste) → **runtime** (`PiRuntime.inject`). For Hermes it will be tuned the same (it is also a TUI).
- `READY_FALLBACK_MS` (guard "never lose the task") → **PtyHub.scheduleInject** (generic).
- `markReady` no longer applies settle itself: it calls `runtime.inject(msg)`, the runtime applies its own settle.

### 2.3 — PtyHub refactoring
- PtyHub creates `PiRuntime` for each session (default).
- **Delegate** to runtime: `spawn`, `input`, `inject`, `resize`, `kill`, `restart`, `size`, part of `isReady`.
- **Stay in PtyHub** (runtime-agnostic): `setGraph`, `orchestraContext`, `outgoingTargets`, `hasEdge`, `handles`, `canBeFinal`, `connectionsAppendix`, `kanbanAppendix`, `resolveOutgoingTarget`, `deliverCall`, `injectTask`, `scheduleInject`, `markReady`, `setBroadcast`, `notify`, `setKanbanTracked`, `isEnforced`, `setEnforcement`, `enforcementOverrides`, `killBoard`, `isNodeRunning`, `getNodeStatuses`, `getEdges`, `waitForExit`, `ensure`.
- `Session` → `{ runtime: INodeRuntime; buffer: string; cols: number; rows: number; startedAt: number }`.
- Buffer/broadcast stay in PtyHub (`onOutput` → accumulate + `pty_output`). Size: runtime source of truth, PtyHub mirror for `pty_size`. Exit: `onExit` → `events.emit("exit:"+...)` so `waitForExit` keeps working.

### 2.4 — Test: identical behavior
All existing tests + Phase 1 tests pass **without modification**. The `node-pty` mock stays at the `node-pty` boundary.

### 2.5 — `backend/src/pty/runtime/PiRuntime.test.ts`
`spawn` invokes `pty.spawn` with correct args; `write` writes; `inject` = paste+settle+`\r`; `kill` terminates; `resize` resizes and is the source of `size()`; ready signal is NOT automatic (arrives from `markReady`, triggered by `POST /internal/ready`); `onExit` invoked on exit.

### 2.6 — Validation
```bash
npm test --workspaces --if-present && npx tsc --noEmit -p backend && npx tsc --noEmit -p frontend
```
**Gate:** All tests pass. No observable change. PtyHub smaller, identical in behavior.

---

## Phase 3 — HermesRuntime + `orchestra` plugin (behind feature flag)

**Objective:** a node with `runtime: "hermes"` launches `hermes --tui` in PTY, with feature parity via env + plugin.
**Risk:** 🟡 Medium · **Time:** ~1 week · **Dependencies:** Phase -1 (spike OK) + Phase 2

### 3.1 — `backend/src/pty/runtime/HermesRuntime.ts`
Subclass of `PtyRuntime` (or direct `INodeRuntime`). Differences from `PiRuntime`:
- **Command:** resolves `hermes` on PATH (with per-OS fallbacks, like `resolvePiCommand`).
- **Args:** `--tui`, `--toolsets "<list>"`. (No `--system-prompt`/`--extension`: use env + plugin.)
- **Additional env:** `HERMES_EPHEMERAL_SYSTEM_PROMPT=<systemPrompt>` (the role, per-process → isolated per node, **like pi's `--system-prompt`**); plus the existing `PINODES_ORCHESTRA_*`.
- **inject/resize/kill/write:** identical to PiRuntime (it is a PTY). Bracketed paste + settle + `\r`.
- **Ready:** see 3.4 (arrives from plugin via `/internal/ready`).

### 3.2 — Hermes plugin `~/.hermes/plugins/orchestra/`
Equivalent of `call-agent.ts`. Files: `plugin.yaml`, `__init__.py`, `schemas.py`, `tools.py`. **Auto-disabled if `PINODES_ORCHESTRA_NODE` absent from env.** Reads `PINODES_ORCHESTRA_URL/_BOARD/_NODE/_TOKEN`.

| Component | Hook/Tool | Action |
|---|---|---|
| Ready | `on_session_start` | `POST /internal/ready` |
| Per-turn context | `pre_llm_call` | `GET /internal/orchestra-context` → returns `{"context": "<appendix>"}` |
| Handoff | tool **`orchestra_handoff`** (args: `recipient`, `message`) | `POST /internal/call-agent` |
| Kanban | tool **`orchestra_card`** (args: `column`) | `POST /internal/card-status` |
| Watchdog (signal) | `post_llm_call` | `POST /internal/turn-ended { handoffCalledThisTurn }` |

**Where the plugin lives:** bundled inside `backend/hermes-plugins/orchestra/`, installed/symlinked to `~/.hermes/plugins/` by `HermesRuntime.spawn` (or by a setup step) the first time. Document the side-effect (writes to `~/.hermes/`), unlike pi which passes `--extension <path>` per-spawn.

### 3.3 — Backend endpoint `POST /internal/turn-ended`
New runtime-agnostic endpoint. For a non-final node that finished the turn without `orchestra_handoff`: backend **injects a nudge via PTY** (reuses `scheduleInject`/`inject`), up to `MAX_STEER_RETRIES`; cap exceeded → `node_status: error` (as today via `/internal/handoff-failed`). For pi this endpoint is not used (pi has in-process watchdog); it is additive, does not change the pi flow.

### 3.4 — PtyHub integration (behind flag)
```typescript
// In spawn():
const runtime =
  node?.runtime === "hermes" && process.env.PINODES_ORCHESTRA_HERMES === "true"
    ? new HermesRuntime()
    : new PiRuntime(); // default
```
Flag `PINODES_ORCHESTRA_HERMES` off by default → production unchanged even if `runtime: "hermes"` is in the graph (degrades or signals clearly).

### 3.5 — Ready protocol
Plugin's `on_session_start` → `POST /internal/ready` → `PtyHub.markReady()`. The `READY_FALLBACK_MS` guard covers the case where the plugin is not installed/does not respond.

### 3.6 — Tests
- **`HermesRuntime.test.ts`:** `spawn` invokes `pty.spawn` with `hermes --tui` + `HERMES_EPHEMERAL_SYSTEM_PROMPT` in env; inject/kill/resize like PiRuntime; output→`onOutput`; exit→`onExit`.
- **Plugin (isolated Python test, optional):** `orchestra_handoff` makes expected POST; `pre_llm_call` returns context; all no-op without `PINODES_ORCHESTRA_NODE`.
- **`PtyHub.test.ts`:** node `runtime: "hermes"` (flag on) uses HermesRuntime; `pi`/absent uses PiRuntime; mixed pi↔hermes graphs (delivery via `/internal/call-agent` unchanged); `POST /internal/turn-ended` injects nudge and after cap marks error.

### 3.7 — Validation
```bash
npm test --workspaces --if-present && npx tsc --noEmit -p backend && npx tsc --noEmit -p frontend
```
**Gate:** All tests pass. Hermes behind flag. Production unchanged.

---

## Phase 4 — Frontend: Runtime Selector and Badge (low risk, xterm unchanged)

**Objective:** UI to select/display runtime. **xterm renders Hermes like pi → no rendering work.**
**Risk:** 🟢 Low · **Time:** 3-5 days · **Dependencies:** Phase 0

- **4.1** `runtimeStore.test.ts`: runtime tracked in node status and snapshots.
- **4.2** `NodeInspector.tsx`: `runtime` dropdown ("pi"/"hermes", default "pi"); **non-secret** `runtimeConfig` fields (e.g. model/toolset).
- **4.3** `AgentNode.tsx`: runtime badge/icon; "Restart pi…" → "Restart {runtime}…".
- **4.4** `TerminalPanel.tsx`: header "pi" → "{runtime}"; "pi session ended" → "{runtime} session ended".
- **4.5** `NodeTerminal.tsx`: "starting pi…" → "starting {runtime}…" from `data.runtime`.
- **4.6** Validation: `npm test --workspaces --if-present && npx tsc --noEmit -p frontend`.

---

## Phase 5 — End-to-End Tests and Integration

**Objective:** working system with mixed graphs. **Risk:** 🟡 Medium · **Time:** 3-5 days · **Dependencies:** Phases 2,3,4

- **5.1 Mixed pi+hermes graph:** Architect (pi) → Developer (hermes). Start task on Architect; handoff to Developer; Developer (hermes) receives and works; closes with `orchestra_handoff`/done.
- **5.2 Hermes watchdog:** non-final Hermes node that finishes without handoff → nudge via PTY → after cap → `error`.
- **5.3 Graceful fallback:** `hermes` not installed / plugin absent → node in `error` with clear message; other nodes continue.
- **5.4 Restart/kill:** Hermes running → restart → new session; → stop → cleanup; board stop → all stopped.
- **5.5 pi-only regression:** board of pi-only nodes, full flow with handoff → everything as before.
- **5.6 Final validation:** `npm test --workspaces --if-present && npx tsc --noEmit -p backend && npx tsc --noEmit -p frontend && npm run build`.

---

## Phase 6 — Enablement and Documentation

**Risk:** 🟢 Low · **Time:** 2-3 days · **Dependencies:** Phase 5

- **6.1** Feature flag: `PINODES_ORCHESTRA_HERMES` documented in README (later optional UI toggle).
- **6.2** Docs: README (section "Hermes runtime nodes" + `hermes` install requirement + plugin setup); ARCHITECTURE.md (Runtime types: Hermes 🔜→✅, methods table); fix xterm/ANSI contradiction in `HERMES_DESKTOP.md` and `HERMES_TUI_IMPACT_ANALYSIS.md`; PROGRAMMATIC_API.md (`runtime`/`runtimeConfig`); SECURITY.md (§0.7); EXTENSIONS_ROADMAP.md.
- **6.3** Validation: `npm test --workspaces --if-present && npm run build`.

---

## Timeline Summary

| Phase | Description | Time | Risk |
|------|------------|-------|---------|
| **-1** | Validation spike (2 live verifications) | 0.5 days | 🟢 None |
| **0** | Data model (types, DB, API, token constraint) | 2-3 days | 🟢 Low |
| **1** | Protection tests for PtyHub | 2-3 days | 🟢 Low |
| **2** | INodeRuntime + PiRuntime extraction | 1 week | 🟡 Medium |
| **3** | HermesRuntime + orchestra plugin + watchdog | 1 week | 🟡 Medium |
| **4** | Frontend: selector, badge, labels | 3-5 days | 🟢 Low |
| **5** | E2E tests and regression | 3-5 days | 🟡 Medium |
| **6** | Enablement and docs | 2-3 days | 🟢 Low |
| **Total** | | **~3-4 weeks** | **🟡 Medium** |

> Phases 0-1-2 (~2 weeks) are valuable **regardless** of Hermes: extracting `PiRuntime` is healthy refactoring that also enables Cursor/OpenClaw.

---

## Security Checklist (for every phase)

- [ ] All existing tests pass (`npm test --workspaces --if-present`)
- [ ] Backend and frontend typecheck pass
- [ ] Build produces artifact (`npm run build`)
- [ ] No observable change (phases 0-2)
- [ ] Feature flag off = behavior identical to today (phases 3-5)
- [ ] No secrets in `runtimeConfig`/graph (§0.7)
- [ ] Small, revertible commit
- [ ] Each sub-phase has its own tests BEFORE implementation

---

## Risks and Mitigations

| Risk | Probability | Impact | Mitigation |
|---------|-------------|---------|-------------|
| `HERMES_EPHEMERAL_SYSTEM_PROMPT` first turn only | Medium | Low | Fallback: role via `pre_llm_call` (runs every turn). Verified in spike |
| Bracketed-paste unreliable in TUI | Low | Medium | Verified in spike; fallback: TUI alternative input API |
| PtyHub refactoring breaks pi | Medium | High | Phase 1 (protection tests) before refactor; Phase 2 moves code, does not rewrite |
| Global plugin disturbs user's Hermes | Medium | Medium | Auto-disable without `PINODES_ORCHESTRA_NODE`; `requires_env` gate |
| Watchdog not implementable via hook | Certain | Low | Already resolved: nudge via PTY on `post_llm_call` signal |
| `hermes` not installed → nodes stuck | Medium | Low | Graceful fallback with clear message; flag off by default |
| Secret (token) persisted in graph | Medium | High | §0.7: credentials in `~/.hermes/`/env, never in `runtimeConfig` |

---

## What NOT To Do

1. **Do not reintroduce the gateway/JSON-RPC path** — discarded; Hermes runs in PTY like pi
2. **Do not rewrite PtyHub from scratch** — move code, do not rewrite it
3. **Do not remove call-agent.ts** — stays for pi nodes; Hermes uses the plugin
4. **Do not change the @@HANDOFF protocol / `/internal/*` endpoints** — they are universal; `/internal/turn-ended` is additive
5. **Do not change the existing WebSocket protocol** — current messages unchanged
6. **Do not put secrets in the graph** — credentials in `~/.hermes/`/env (§0.7)
7. **Do not let the plugin act on non-Orchestra Hermes sessions** — gate on `PINODES_ORCHESTRA_NODE`
8. **Do not enable Hermes by default** — feature flag off until mature
9. **Do not implement everything at once** — incremental phases, each revertible

---

## Revision Changelog

**v3 (2026-06-29) — after web research:**
1. **Architecture decided: PATH A** (`hermes --tui` in PTY). Gateway/JSON-RPC path **discarded** (confirmed TUI is self-contained and renders ANSI → xterm for free).
2. **Complete pi→Hermes mapping** via Hermes plugin: `HERMES_EPHEMERAL_SYSTEM_PROMPT` (per-node system prompt, like `--system-prompt`), `on_session_start` (ready), `pre_llm_call` (per-turn context), tools `orchestra_handoff`/`orchestra_card`, `post_llm_call` (watchdog).
3. **Per-node isolated system prompt confirmed:** per-process env var, like pi. Each `hermes --tui` instance has its own prompt for its lifetime, without touching global `~/.hermes/SOUL.md`.
4. **Watchdog resolved:** Hermes hooks cannot inject follow-up → use PTY (nudge via `scheduleInject` on `post_llm_call` signal → `/internal/turn-ended`).
5. **Plugin isolation:** global in `~/.hermes/plugins/` but auto-disabled without `PINODES_ORCHESTRA_NODE`.
6. **Spike reduced to 0.5 days** (2 live verifications), no longer an architecture decision.
7. **Estimate revised to ~3-4 weeks** (path A), Frontend back to 🟢 low (xterm unchanged).

**v2 (2026-06-29):** first revision against code — added spike, fixed xterm/ANSI contradiction, resolved READY_* inconsistency, explicit feature-parity gaps, security constraint, runtime-agnostic methods list, re-estimates.

**v1 (2026-06-28):** initial plan (6 phases, implicit gateway assumption).
