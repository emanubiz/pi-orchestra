# Hermes TUI Runtime — Impact Analysis

> **Date:** 2026-06-28
> **Status:** Analysis only — no code changes
> **Goal:** Assess the feasibility and impact of adding Hermes TUI as an alternative runtime for nodes, in parallel with the pi CLI

---

## 1. Context and Key Question

**Question:** Can a node be both a pi terminal and a Hermes TUI terminal?

**Short answer:** A single node must be **one or the other** (exclusive runtime per node), but a **board** can contain mixed nodes — some pi, others Hermes — connected by edges. This is the primary and most useful use case.

**Reason:** Each node represents a single agent session with its own prompt, state, and context. Two runtimes on the same node would create unresolvable conflicts (who owns the PTY? who handles the handoff? which output is canonical?). The graph model already allows nodes with different runtimes connected by edges, which is the natural solution.

---

## 2. Current Architecture — Critical Coupling

### 2.1 The core: PtyHub.ts (~750 lines)

`PtyHub` is a monolithic class that manages **everything** in the node lifecycle, hardcoded to the pi CLI:

```
PtyHub
  ├── spawn()         → pty.spawn("pi", [...args])
  ├── ensure()        → spawn if missing
  ├── input()         → pty.write(data)
  ├── inject()        → bracketed paste + \r
  ├── resize()        → pty.resize(cols, rows)
  ├── kill()          → pty.kill()
  ├── restart()       → kill + spawn
  ├── markReady()     → flush inject queue
  ├── deliverCall()   → resolve target + scheduleInject
  └── orchestraContext() → appendix per turn
```

**Direct coupling with pi CLI:**

| Element | Where | Why it is pi-specific |
|---------|------|----------------------|
| `resolvePiCommand()` | PtyHub.ts:63-99 | Looks up the `pi` binary on PATH or in node_modules |
| `PI_BIN_NAMES` | PtyHub.ts:46 | `["pi"]` / `["pi.cmd", "pi.exe", ...]` on Windows |
| `EXTENSION_PATH` | PtyHub.ts:27 | Path to `call-agent.ts`, pi-specific extension |
| CLI args (`--tools`, `--session-id`, `--name`, `--system-prompt`, `--extension`) | PtyHub.ts:228-240 | pi CLI API, not generic |
| Bracketed paste (`\x1b[200~...\x1b[201~`) | PtyHub.ts:385 | pi TUI input mechanism |
| `READY_SETTLE_MS` / `READY_FALLBACK_MS` | PtyHub.ts:14-18 | Timing tied to pi boot |

### 2.2 The extension: call-agent.ts (~320 lines)

File `backend/pi-extensions/call-agent.ts` — an extension that runs **inside** the pi process:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function handoffExtension(pi: ExtensionAPI) {
  pi.on("session_start", async () => { /* POST /internal/ready */ });
  pi.on("before_agent_start", async (event) => { /* GET /internal/orchestra-context */ });
  pi.on("agent_end", async (event) => { /* parse @@HANDOFF, deliverCall */ });
}
```

**pi-specific hooks:**
- `session_start` → does not exist in Hermes
- `before_agent_start` → does not exist in Hermes
- `agent_end` → does not exist in Hermes
- `pi.sendUserMessage(msg, { deliverAs: "followUp" })` → pi-specific API

### 2.3 The handoff protocol

```
pi agent writes @@HANDOFF:developer-1 in its output
  → call-agent.ts intercepts on agent_end
  → POST /internal/call-agent { fromNodeId, targetNodeId, message }
  → backend resolves the target
  → scheduleInject on the target PTY
  → bracketed paste into the target pi terminal
```

This protocol is **text-based** (regex on output) — which is an advantage: it works with any agent that writes text. But the interception mechanisms (extension hooks) are pi-specific.

---

## 3. How Hermes TUI Works (from existing docs)

### 3.1 Hermes Desktop architecture

```
Hermes Desktop (Electron shell)
  └── hermes dashboard backend (local or remote)
       └── Hermes Agent core (AIAgent, tools, sessions)
```

### 3.2 Available protocols

| Protocol | Transport | Suitable for Orchestra? |
|----------|-----------|-------------------------|
| **ACP** (`hermes acp`) | JSON-RPC stdio | ❌ Single session — IDE-style |
| **TUI gateway** | JSON-RPC stdio / WebSocket | ✅ Per-node sessions: `prompt.submit`, `session.steer`, `session.interrupt`, streaming events |
| **API server** | HTTP OpenAI-compat | ⚠️ Less control — no fine-grained steer/approval |
| **Dashboard `/api/ws`** | WebSocket JSON-RPC | ✅ Same as TUI gateway; powers the Chat tab |

### 3.3 Critical insight

> **"Hermes Chat tab is literally the Ink TUI rendered via xterm.js through a PTY bridge to `tui_gateway`."**
> — docs/HERMES_DESKTOP.md

This means that:
1. Hermes produces ANSI/VT100 output renderable by xterm.js (like pi)
2. Frontend rendering is **already compatible** — no changes to NodeTerminal/TerminalPanel
3. The difference is in the **backend**: how to spawn a session, how to inject input, how to intercept events

### 3.4 Operational requirements

- `hermes dashboard --tui` must be running (`--tui` is required; without it `/api/ws` returns close code 4403)
- `HERMES_DASHBOARD_SESSION_TOKEN` in `.env` (regenerated on dashboard restart)
- Readiness probe: `GET /api/status` (weaker) vs `GET /api/ws` (real)
- Remote: VPN (Tailscale) or OAuth — never expose `--insecure` on the public internet

---

## 4. Impact Analysis — Component by Component

### 4.1 Backend — HIGH IMPACT

#### `backend/src/pty/PtyHub.ts` — THE CRITICAL COMPONENT

**Current state:** Monolithic, everything hardcoded to pi CLI.
**Impact:** Must be restructured to delegate runtime-specific operations to an adapter.

Methods that need abstraction:

| Method | Current operation (pi) | Hermes operation | Change required |
|--------|------------------------|------------------|-----------------|
| `spawn()` | `pty.spawn(pi, args, opts)` | Connection to tui_gateway WS/JSON-RPC | **Complete** — entirely different spawn logic |
| `input()` | `pty.write(data)` | `prompt.submit` via JSON-RPC | **Complete** — different protocol |
| `inject()` | Bracketed paste + `\r` | `prompt.submit` via JSON-RPC | **Complete** |
| `resize()` | `pty.resize(cols, rows)` | May not be needed (gateway handles it) | **Partial** |
| `kill()` | `pty.kill()` | `session.interrupt` + close connection | **Complete** |
| `restart()` | `kill + spawn` | `session.interrupt` + new session | **Complete** |
| `markReady()` | From `session_start` extension | From WS gateway event | **Partial** — queue flush mechanism is generic |
| `ensure()` | Check session + spawn | Same concept, different spawn | **Minimal** |
| `deliverCall()` | Resolve target + scheduleInject | **Identical** — runtime-agnostic | **None** |
| `orchestraContext()` | Read graph + edges | **Identical** | **None** |
| `handles()` | Generate handle from label | **Identical** | **None** |
| `connectionsAppendix()` | Text for prompt | **Identical** | **None** |

**Methods completely unchanged (runtime-agnostic):**
- `setGraph()`, `orchestraContext()`, `handles()`, `connectionsAppendix()`, `kanbanAppendix()`, `resolveOutgoingTarget()`, `deliverCall()`, `setBroadcast()`, `setKanbanTracked()`, `setEnforcement()`, `isEnforced()`, `enforcementOverrides()`, `getNodeStatuses()`, `getEdges()`, `waitForExit()`

**Partially unchanged methods:**
- `ensure()` — pending and session check logic is generic; only spawn differs
- `markReady()` — queue flush mechanism is generic; only the trigger differs
- `scheduleInject()` — queue/fallback logic is generic

**Estimate:** ~60% of PtyHub code is runtime-agnostic and does not need to change. ~40% (spawn, input, inject, kill, resize) must be extracted.

#### `backend/pi-extensions/call-agent.ts` — HIGH IMPACT

**Current state:** pi-specific extension, ~320 lines.
**Impact:** Hermes needs an equivalent mechanism.

**Options:**

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| **A. Hermes Skill** | A Hermes tool (`orchestra_handoff`) that calls `POST /internal/call-agent` | Native, clean | Requires Hermes to support custom skills/tools |
| **B. Stream parsing** | `HermesRuntime` intercepts stream events and regex-matches `@@HANDOFF` | No changes in Hermes | More fragile, duplicates logic |
| **C. Mix** | Hermes Skill + fallback stream parsing | Robust | More complex |

**Recommendation:** Option C — Hermes Skill as primary channel, stream parsing as fallback.

**Notes:**
- The `@@HANDOFF` text protocol is **universal** — works with any agent
- `POST /internal/call-agent`, `POST /internal/ready`, `GET /internal/orchestra-context` are **already runtime-agnostic** — work for any runtime
- Only interception is runtime-specific

#### `backend/src/types.ts` — MEDIUM IMPACT

Required additions to the data model:

```typescript
// New type
type NodeRuntime = "pi" | "hermes";

// WorkflowNode extension
interface WorkflowNode {
  // ... existing fields unchanged
  runtime?: NodeRuntime;        // default "pi" for backward compat
  runtimeConfig?: Record<string, unknown>;  // runtime-specific config
}
```

**Backward compatibility:** The `runtime` field is optional. Default `"pi"`. Existing graphs work without modifications.

#### `backend/src/ws/handler.ts` — MEDIUM IMPACT

The WebSocket handler routes messages to PtyHub. Required changes:

| WS message | Change |
|------------|--------|
| `load_graph` | None — passes graph to PtyHub as today |
| `attach_node` | PtyHub must spawn the correct runtime (handled by refactored PtyHub) |
| `pty_input` | PtyHub must use the correct mechanism (PTY write vs JSON-RPC) |
| `inject_task` | None — passes to PtyHub |
| `restart_node` | PtyHub must use the correct mechanism |
| `abort_node` | PtyHub must use the correct mechanism |
| `pty_resize` | May not be needed for Hermes (to be verified) |

**Verdict:** The handler is already a thin layer over PtyHub. If PtyHub handles dispatch, the handler barely changes.

#### `backend/src/orchestra/BoardManager.ts` — MEDIUM IMPACT

- `addNode()` / `updateNode()` must propagate `runtime` and `runtimeConfig`
- `validateGraph()` may have additional rules for Hermes nodes (e.g. validate config)
- `run()` → `injectTask()` is already generic (passes to PtyHub)

#### `backend/src/routes/orchestra.ts` — LOW IMPACT

- Node CRUD bodies must accept `runtime` and `runtimeConfig`
- `POST /flows` must support mixed graphs (automatic if the graph includes the field)
- No structural changes

#### `backend/src/db/index.ts` — LOW IMPACT

- `boards.graph_data` is serialized as JSON → the `runtime` field fits naturally
- No SQL schema change needed (the JSON blob contains it)
- Optional: index or dedicated column for runtime-filtered queries

### 4.2 Frontend — LOW IMPACT

#### Terminal rendering — NEAR-ZERO IMPACT

**This is the most favorable point of the entire analysis.**

Both pi and Hermes TUI produce ANSI/VT100 output. Rendering happens on xterm.js in both cases. The components:

- `NodeTerminal.tsx` (mini read-only terminal on the card)
- `TerminalPanel.tsx` (interactive terminal in the side panel)
- `ptyBus.ts` (pub/sub for PTY events)

...are **completely runtime-agnostic**. They contain no references to "pi" in rendering. They will work identically with Hermes.

**The only exception:** The "starting pi…" message in the `NodeTerminal.tsx` overlay — should become dynamic "starting {runtime}…".

#### `frontend/src/types.ts` — LOW IMPACT

```typescript
// New type
type NodeRuntime = "pi" | "hermes";

// WorkflowNodeData extension
interface WorkflowNodeData {
  // ... existing fields unchanged
  runtime?: NodeRuntime;
  runtimeConfig?: Record<string, unknown>;
}
```

#### `frontend/src/components/AgentNode.tsx` — LOW IMPACT

- Badge/icon to indicate the node runtime (e.g. "pi" / "H" / differentiated icon)
- Label "Restart pi…" → dynamic "Restart {runtime}…"
- Updated informative tooltips

#### `frontend/src/components/NodeInspector.tsx` — LOW IMPACT

- Dropdown to select runtime when creating/editing a node
- Runtime-specific configuration fields (e.g. Hermes gateway URL, session token)
- The rest of the inspector (prompt override, run, entry) is unchanged

#### `frontend/src/stores/runtimeStore.ts` — LOW IMPACT

- Small additions to track `runtime` in node status
- No structural changes to the store

#### `frontend/src/components/TerminalPanel.tsx` — LOW IMPACT

- Header: label "pi" → dynamic "{runtime}"
- Message "pi session ended" → "{runtime} session ended"
- The rest (xterm, fit, clipboard) is unchanged

### 4.3 Tests — MEDIUM IMPACT

Existing tests must be extended to cover the new runtime:

| Test file | Current coverage | Required extension |
|-----------|------------------|-------------------|
| `PtyHub.test.ts` | 9 tests on spawn, inject, ready, orchestraContext | Tests for Hermes spawn/inject/kill + mixed graphs |
| `BoardManager.test.ts` | 37 tests on graph CRUD, run, stop, validation | Tests for runtime field, Hermes validation |
| `handler.test.ts` | 2 tests on load_graph | Tests for WS messages with different runtime |
| `db/index.test.ts` | 5 tests on board CRUD | Tests for runtime serialization in JSON |
| `runtimeStore.test.ts` | 1 test on overlay | Tests for runtime tracking |

---

## 5. Cross-Runtime Handoff Protocol

### 5.1 Scenario: pi → Hermes

```
Node A (pi) writes: @@HANDOFF:hermes-dev
  → call-agent.ts intercepts (agent_end)
  → POST /internal/call-agent { fromNodeId: A, targetNodeId: B, message: "..." }
  → PtyHub.deliverCall() resolves B
  → PtyHub.scheduleInject() for B
  → HermesRuntime.inject() → prompt.submit via JSON-RPC
```

**Works without protocol changes.** The handoff is text-based and the backend handles it in a runtime-agnostic way.

### 5.2 Scenario: Hermes → pi

```
Node B (Hermes) writes: @@HANDOFF:architect
  → Hermes Skill orchestra_handoff (or stream parsing)
  → POST /internal/call-agent { fromNodeId: B, targetNodeId: A, message: "..." }
  → PtyHub.deliverCall() resolves A
  → PtyHub.scheduleInject() for A
  → PiRuntime.inject() → bracketed paste
```

**Works the same way.** The delivery channel (`POST /internal/call-agent`) is already universal.

### 5.3 Scenario: Hermes → Hermes

```
Node B (Hermes) → @@HANDOFF → Node C (Hermes)
  → Same flow, inject via JSON-RPC on both sides
```

### 5.4 Per-turn context refresh

Currently `call-agent.ts` calls `GET /internal/orchestra-context` every turn. For Hermes:

| Option | Description | Complexity |
|--------|-------------|------------|
| **A. Hermes Skill** | A tool that calls the same endpoint | Medium — requires custom skill |
| **B. Runtime adapter** | `HermesRuntime` injects context via `session.steer` | Medium |
| **C. Baked-in fallback** | The appendix is already in `PINODES_ORCHESTRA_FALLBACK_APPENDIX` | Already working — graceful degradation |

Option C is already implemented and working. Options A and B are follow-up improvements.

---

## 6. Dependencies and External Requirements

### 6.1 Requirements for pi runtime (current, unchanged)

- `@earendil-works/pi-coding-agent` installed (global or in node_modules)
- API keys in `~/.pi/agent/auth.json` or env vars
- No external service required — pi is self-contained

### 6.2 Requirements for Hermes runtime (new)

- `hermes dashboard --tui` running (required)
- `HERMES_DASHBOARD_SESSION_TOKEN` configured
- Gateway URL accessible (default: `http://localhost:9119`)
- **Critical difference:** Hermes is not self-contained — it requires an external service

### 6.3 Operational implication

This is a **significant operational risk**. If Hermes is not active, Hermes nodes must fail gracefully with a clear message. The user must understand that additional setup is required.

---

## 7. Impact Summary

| Component | Impact | Risk | Notes |
|-----------|--------|------|-------|
| `PtyHub.ts` | 🔴 High | 🔴 High | System core, critical refactoring |
| `call-agent.ts` | 🔴 High | 🟡 Medium | New mechanism for Hermes, existing for pi |
| `types.ts` (backend) | 🟡 Medium | 🟢 Low | Optional field, backward compatible |
| `ws/handler.ts` | 🟡 Medium | 🟢 Low | Thin layer, minimal change |
| `BoardManager.ts` | 🟡 Medium | 🟢 Low | Runtime field propagation |
| `routes/orchestra.ts` | 🟢 Low | 🟢 Low | Extended body, minimal change |
| `db/index.ts` | 🟢 Low | 🟢 Low | JSON blob, no schema change |
| Frontend terminals (xterm) | 🟢 None | 🟢 Low | Already runtime-agnostic |
| `types.ts` (frontend) | 🟢 Low | 🟢 Low | Optional field |
| `AgentNode.tsx` | 🟢 Low | 🟢 Low | Badge/icon |
| `NodeInspector.tsx` | 🟢 Low | 🟢 Low | Runtime dropdown |
| `TerminalPanel.tsx` | 🟢 Low | 🟢 Low | Dynamic label |

**Overall risk:** 🟡 **MEDIUM** — PtyHub refactoring is the single riskiest point, but most of the system is already runtime-agnostic.

---

## 8. Favorable Points (already in place)

1. **xterm.js rendering is universal** — both pi and Hermes produce ANSI/VT100
2. **Handoff is text-based** — `@@HANDOFF` works with any agent
3. **Backend API is already runtime-agnostic** — `/internal/call-agent`, `/internal/ready`, `/internal/orchestra-context` do not know which runtime a node uses
4. **The ready-gate mechanism is generic** — the adapter only needs to call `markReady()`
5. **The JSON graph is extensible** — the `runtime` field fits without schema changes
6. **Docs are already in place** — `HERMES_DESKTOP.md`, `EXTENSIONS_ROADMAP.md`, `PROGRAMMATIC_API.md` describe the target design
7. **`PROGRAMMATIC_API.md` already has the `runtime` field** in the planned `WorkflowNode` type

---

## 9. Conclusions

Implementation is **feasible and well supported by the existing architecture**. The main risk is concentrated in a single component (`PtyHub.ts`) that must be carefully restructured. The rest of the system is already designed to be extensible.

The key to success is an **incremental approach**: first internal refactoring (zero behavior change), then add the new runtime behind a feature flag, finally enable it in the UI.

See the implementation plan document (`HERMES_TUI_IMPLEMENTATION_PLAN.md`) for operational details.
