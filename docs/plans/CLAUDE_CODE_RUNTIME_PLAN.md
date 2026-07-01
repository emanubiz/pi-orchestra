# Claude Code runtime — pre-implementation plan

> **Status: planned.** This document is the design/analysis pass *before* writing
> code. It describes how to add **Claude Code** as a third node runtime alongside
> `pi` and `hermes`, reusing the existing `INodeRuntime` abstraction and the
> existing `/internal/*` contract — no new backend endpoints.
>
> **Revision 2026-07-02 — handoff protocol superseded.** Since `a46eab1` all
> runtimes share **one text-sentinel protocol** (`@@HANDOFF:<handle> … @@END`,
> `@@CARD`, `@@DONE`) instead of per-runtime native tools — the Hermes plugin no
> longer registers `orchestra_handoff`/`orchestra_card`; it parses the sentinels
> in its `transform_llm_output` hook. **§2.2 (MCP tool server for handoff/card)
> is therefore superseded:** the Claude runtime shim should parse the same
> sentinels from the turn's final output (e.g. in the `Stop` hook, reading the
> transcript) and POST `/internal/call-agent` / `/internal/card-status`, exactly
> like the Hermes plugin. The lifecycle-hook mapping (§2.3) remains valid, with
> one addition: the shim must also POST the (since-added) `/internal/turn-started`
> once per turn for the closed-loop submit confirmation (see
> [`ARCHITECTURE.md`](../../ARCHITECTURE.md) § Closed-loop submit confirmation).
> §3 is resolved by the text protocol: the `Stop` hook knows whether the turn's
> output contained a `@@HANDOFF` block.
>
> Companion docs: [`ARCHITECTURE.md`](../../ARCHITECTURE.md) (runtime model),
> [`HERMES_TUI_IMPLEMENTATION_PLAN.md`](../archive/HERMES_TUI_IMPLEMENTATION_PLAN.md) (✅ completed)
> (the pattern this mirrors), [`MULTI_INSTANCE.md`](../guides/MULTI_INSTANCE.md)
> (per-window isolation, unaffected by this work).

---

## 1. Why Claude Code is the natural next runtime

The Hermes integration already proved the design: a node is a PTY, and
agent↔orchestra coordination happens through the **shared `@@HANDOFF` text
protocol** plus **lifecycle hooks**, all bridging to the same `/internal/*`
endpoints `pi` uses. Claude Code maps onto that pattern almost one-to-one:

| Orchestra need | Hermes (implemented) | Claude Code (this plan) |
|---|---|---|
| Visual node = live terminal | `hermes --tui` in PTY | `claude` (interactive) in PTY |
| Handoff / card expression | `@@HANDOFF`/`@@CARD` sentinels parsed in `transform_llm_output` | **Same sentinels**, parsed from the turn's output (`Stop` hook / output transform) |
| Per-turn context refresh | `pre_llm_call` hook → `GET /internal/orchestra-context` | **`UserPromptSubmit` hook** → same endpoint (emits `additionalContext`) |
| Ready signal | `on_session_start` → `POST /internal/ready` | **`SessionStart` hook** → same endpoint |
| Turn-end watchdog | `post_llm_call` → `POST /internal/turn-ended` | **`Stop` hook** → same endpoint |
| Per-node system prompt | `HERMES_EPHEMERAL_SYSTEM_PROMPT` env | `--append-system-prompt` (or `--system-prompt`) |
| Callback URL / auth | `PINODES_ORCHESTRA_URL` + `…_TOKEN` env | **identical** env contract |

The decisive property: Claude Code has **both** a tool surface (MCP) *and* a
real lifecycle-hook system. Cursor has MCP but no per-turn hook; that gap is why
Claude Code, not Cursor, is the next runtime. See the comparison in
[`ARCHITECTURE.md`](../../ARCHITECTURE.md) once this lands.

**Reuse, not new surface.** This integration adds **zero** `/internal/*`
endpoints. `orchestra_handoff` → `POST /internal/call-agent`, `orchestra_card` →
`POST /internal/card-status`, plus the three lifecycle endpoints already used by
both `pi` and Hermes (`/internal/ready`, `/internal/orchestra-context`,
`/internal/turn-ended`). The multi-instance callback invariant
([`MULTI_INSTANCE.md`](../guides/MULTI_INSTANCE.md)) holds unchanged: `ClaudeRuntime`
passes `orchestraUrl: BASE_URL` (from `PtyHub.ts`) into the child, so callbacks
land in the right per-window backend.

---

## 2. Pieces to build

```
backend/
  src/pty/runtime/
    ClaudeRuntime.ts          (new)  — extends PtyRuntime, spawns `claude` in a PTY
    ClaudeRuntime.test.ts     (new)  — mirrors PiRuntime/HermesRuntime tests
  claude-mcp/orchestra/       (new)  — stdio MCP server: the two native tools
    server.ts                        — register_tool analog (handoff, card)
    package.json / tsconfig          — buildable to a single entry the CLI can spawn
  claude-settings/
    orchestra.settings.json   (new)  — hooks: SessionStart / UserPromptSubmit / Stop
```

Touched existing files:

```
backend/src/pty/PtyHub.ts     — runtime selection: add the "claude" branch + feature flag
backend/src/types.ts          — WorkflowNode.runtime union: add "claude"
ARCHITECTURE.md               — runtime table + handoff section
```

### 2.1 `ClaudeRuntime extends PtyRuntime`

Same shape as `HermesRuntime` — only `spawn()` differs. Sketch:

```ts
export class ClaudeRuntime extends PtyRuntime {
  private cmd = resolveClaudeCommand(); // findInPath("claude"), Windows .cmd-aware

  spawn(config: RuntimeSpawnConfig): void {
    const mcpConfig = resolveOrchestraMcpConfigPath();   // points at claude-mcp/orchestra
    const settings  = resolveOrchestraSettingsPath();    // hooks file

    const args = [
      "--append-system-prompt", config.systemPrompt,
      "--mcp-config", mcpConfig,
      "--settings", settings,
      // Pre-allow the orchestra tools + default toolset so the PTY never blocks
      // on a permission prompt (there is no human to approve mid-pipeline).
      "--allowedTools",
      "mcp__orchestra__orchestra_handoff,mcp__orchestra__orchestra_card," +
        "Read,Edit,Write,Bash,Grep",
      // permission mode chosen to match the `pi`/hermes "just run" behaviour:
      "--permission-mode", "acceptEdits",
    ];

    const term = pty.spawn(this.cmd.file, [...this.cmd.baseArgs, ...args], {
      name: "xterm-256color",
      cols: config.cols, rows: config.rows, cwd: config.cwd,
      env: {
        ...process.env,
        PINODES_ORCHESTRA_URL: config.orchestraUrl,    // → BASE_URL, multi-instance safe
        PINODES_ORCHESTRA_BOARD: config.boardId,
        PINODES_ORCHESTRA_NODE: config.nodeId,
        PINODES_ORCHESTRA_FALLBACK_APPENDIX: config.appendix,
        ...(process.env.PINODES_ORCHESTRA_TOKEN
          ? { PINODES_ORCHESTRA_TOKEN: process.env.PINODES_ORCHESTRA_TOKEN }
          : {}),
      } as Record<string, string>,
    });
    this.ptyInstance = term; this._cols = config.cols; this._rows = config.rows;
    this._ready = false;
    term.onData((d) => config.onOutput(d));
    term.onExit(({ exitCode }) => { this.ptyInstance = null; this._ready = false; config.onExit(exitCode ?? null); });
  }
}
```

`inject()`, `resize()`, `kill()`, `markReady()`, `isReady()`, `size()` are all
inherited from `PtyRuntime` — bracketed-paste inject already works for any PTY
TUI, so it should work for the Claude Code TUI unchanged (**verify in the spike**,
§5 P0).

### 2.2 The `orchestra` MCP server (the `register_tool` analog)

A small **stdio MCP server** that Claude Code spawns as a child (config in
`--mcp-config`). It is the direct translation of the two
`ctx.register_tool(...)` blocks in `backend/hermes-plugins/orchestra/__init__.py`.
It reads `PINODES_ORCHESTRA_URL` / `_BOARD` / `_NODE` / `_TOKEN` from the env it
inherits (passed by `ClaudeRuntime` → `claude` → MCP child) and exposes exactly
two tools, each a thin POST:

| MCP tool | Args | Bridges to |
|---|---|---|
| `orchestra_handoff` | `recipient`, `message` | `POST /internal/call-agent` `{boardId, fromNodeId, targetNodeId, message}` |
| `orchestra_card` | `column` (todo/in_progress/test/review/done) | `POST /internal/card-status` `{boardId, column}` |

Tool surface in Claude Code is namespaced: `mcp__orchestra__orchestra_handoff`,
`mcp__orchestra__orchestra_card` (that is the name to pre-allow in
`--allowedTools`). Same validation as Hermes: reject unknown columns; return the
backend's `message` on success, a readable error otherwise.

> The MCP server should **self-gate** like the Hermes plugin: if
> `PINODES_ORCHESTRA_NODE` is absent, expose no tools (so a stray `claude` on the
> same machine that happens to load the config is unaffected).

### 2.3 Hooks settings (lifecycle bridge)

A `--settings` JSON wiring three hooks to the existing endpoints. Each hook is a
tiny script (Node one-liner or a `backend/claude-hooks/*.mjs`) that POSTs/GETs:

| Hook event | Action | Endpoint |
|---|---|---|
| `SessionStart` | mark node booted → flush queued injects | `POST /internal/ready` `{boardId, nodeId}` |
| `UserPromptSubmit` | fetch live appendix, return it as `additionalContext` | `GET /internal/orchestra-context?boardId&nodeId` |
| `Stop` | signal end-of-turn for the determinism watchdog | `POST /internal/turn-ended` `{boardId, nodeId, handoffCalledThisTurn}` |

`boardId`/`nodeId` come from env (`PINODES_ORCHESTRA_BOARD/_NODE`), same as the
Hermes plugin. The hook scripts must **fail open** (swallow errors) exactly like
the Hermes plugin's `try/except: pass` — the backend already has a fallback
timeout for `ready`, and the watchdog tolerates a missed `turn-ended`.

---

## 3. The one non-trivial decision: `handoffCalledThisTurn`

Hermes tracks this with a per-session Python global set inside `orchestra_handoff`
and read in `post_llm_call`. Claude Code's hook scripts are **separate processes**
from the MCP server, so they can't share an in-memory flag. Two options:

- **Option A — reuse the contract verbatim.** A `PostToolUse` hook matching
  `mcp__orchestra__orchestra_handoff` writes a marker (e.g. touch a temp file
  keyed by session id); the `Stop` hook reads + clears it and sends
  `handoffCalledThisTurn` accordingly. Keeps `/internal/turn-ended` unchanged.
- **Option B — let the backend infer it (recommended, cleaner).** The backend
  already receives the handoff via `POST /internal/call-agent`; it can record
  "node X called handoff since its last turn-ended" and ignore the body flag.
  `/internal/turn-ended` then needs no `handoffCalledThisTurn` from the client,
  which *also* simplifies the Hermes plugin later. Small backend change, shared
  benefit.

**Recommendation: B**, gated so it doesn't regress Hermes (treat a present
`handoffCalledThisTurn` as an override when sent). Decide before P3.

---

## 4. Runtime selection & types

```ts
// types.ts
interface WorkflowNode {
  runtime?: "pi" | "hermes" | "claude";   // absent = "pi"
  runtimeConfig?: Record<string, unknown>;
}
```

```ts
// PtyHub.ts — extend the existing ternary, keep flags evaluated at spawn time
const claudeEnabled = process.env.PINODES_ORCHESTRA_CLAUDE === "true";
const runtime: INodeRuntime =
  node?.runtime === "hermes" && hermesEnabled ? new HermesRuntime()
  : node?.runtime === "claude" && claudeEnabled ? new ClaudeRuntime()
  : new PiRuntime();
```

Feature flag `PINODES_ORCHESTRA_CLAUDE` (default `false`), mirroring
`PINODES_ORCHESTRA_HERMES`. Document both in `ARCHITECTURE.md → Feature flags`.

---

## 5. Phases

| Phase | Deliverable | Gate |
|---|---|---|
| **P0 spike** | Manually run `claude` in a PTY with `--mcp-config` + `--settings`; confirm: TUI renders, bracketed-paste inject submits, an MCP tool call reaches a stub backend, hooks fire. | This is the make-or-break; do it before writing `ClaudeRuntime`. |
| **P1** | `ClaudeRuntime.ts` (+ `resolveClaudeCommand`, Windows-aware via `findInPath`). | Unit test mirrors `PiRuntime.test.ts`. |
| **P2** | `claude-mcp/orchestra` stdio server (two tools, self-gating). | Unit test: tool → correct POST shape. |
| **P3** | Hooks settings + scripts; resolve §3 (Option B). | `ready`/`context`/`turn-ended` round-trip against the running backend. |
| **P4** | `PtyHub` selection branch + `WorkflowNode.runtime` "claude" + flag. | `detect_changes()` shows only expected symbols. |
| **P5** | `ClaudeRuntime.test.ts` + MCP server test green. | Full verify suite (below). |
| **P6** | Docs: flip this file to *implemented*, update `ARCHITECTURE.md` runtime table + handoff section. | — |

---

## 6. Risks & open questions

1. **Permission prompts block the pipeline.** An interactive `claude` may prompt
   before running tools. There is no human at a pipeline node, so the orchestra
   MCP tools (and the default toolset) **must** be pre-allowed
   (`--allowedTools` + `--permission-mode`). Confirm the exact, current flag
   semantics against the installed `claude --version` — CLI surface evolves and
   this plan should not assume a frozen flag set.
2. **`UserPromptSubmit` granularity.** It fires per submitted prompt, not per
   internal LLM step of an agentic loop. That's the same effective behaviour we
   want (appendix refreshed when a task arrives / a graph edit is picked up on
   the next task) — but it is **not** identical to Hermes' `pre_llm_call` which
   fires every model call. Validate that graph-edit pickup latency is acceptable;
   if not, fall back to exposing context as an MCP tool the model can pull.
3. **Auth/credentials.** Claude Code needs its own auth (API key or logged-in
   session). Orchestra must **not** manage that — it inherits the host env. Keep
   it out of `runtimeConfig` (which is documented as secret-free).
4. **`Stop` can fire on every turn / re-fire.** Ensure the watchdog logic in
   `/internal/turn-ended` is idempotent enough (it already keys retries by
   `boardId:nodeId` and clears on handoff).
5. **MCP child lifecycle.** The MCP server is a child of `claude`, which is a
   child of the PTY; killing the PTY (`kill()`) must reap the whole tree. Verify
   no orphaned MCP processes after `abort_node` / `stop_board`.

---

## 7. Verify (pre-commit, from `AGENTS.md`)

```bash
npm test --workspaces --if-present
npx tsc --noEmit -p backend
npm run build
```

Plus the project's GitNexus guardrails: run `impact({target: "ensure"...})`-style
analysis before touching `PtyHub` spawn, and `detect_changes()` before commit —
the only code symbols that should move are the new `ClaudeRuntime`, the
`PtyHub` selection branch, and `WorkflowNode.runtime`.

---

## 8. Definition of done

- A node with `runtime: "claude"` (and `PINODES_ORCHESTRA_CLAUDE=true`) boots a
  live Claude Code terminal in its card, hands off via `orchestra_handoff`
  (native MCP tool, no text parsing), moves Kanban cards, refreshes its appendix
  per task, reports ready, and is nudged by the determinism watchdog when a
  non-final node ends without a handoff — all through the **unchanged**
  `/internal/*` contract.
- No new backend endpoints. No secrets in `runtimeConfig`. Multi-instance
  isolation untouched.
