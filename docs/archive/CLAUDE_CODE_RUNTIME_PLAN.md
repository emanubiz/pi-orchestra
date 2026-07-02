# Claude Code runtime — implementation plan (test-first)

> **Date:** 2026-07-02 (v2 — full rewrite; supersedes the 2026-07-01 MCP-tool draft)
> **Status:** ✅ **shipped on `main`** (P0–P5 done; P6 manual QA optional — see
> [checklist §4-C](../checklists/PRE_MERGE_TEST_CHECKLIST.md)).
> Operational guide: [guides/CLAUDE_RUNTIME.md](../guides/CLAUDE_RUNTIME.md)
> **Guiding principle:** same as the Hermes plan — every phase starts with tests,
> never change existing behavior without tests that capture it, backward
> compatibility always guaranteed.
>
> Companion docs: [`ARCHITECTURE.md`](../../ARCHITECTURE.md) (runtime model,
> handoff protocol, closed-loop submit),
> [`HERMES_TUI_IMPLEMENTATION_PLAN.md`](../archive/HERMES_TUI_IMPLEMENTATION_PLAN.md)
> (✅ the completed pattern this mirrors),
> [`MULTI_INSTANCE.md`](../guides/MULTI_INSTANCE.md) (per-window isolation,
> unaffected).

---

## 0. Architectural decision — text sentinels in a PTY, no MCP tools

A `runtime: "claude"` node is **one interactive `claude` process in a PTY**,
exactly like pi and Hermes. Coordination uses the **shared text-sentinel
protocol** (`@@HANDOFF:<handle> … @@END`, `@@CARD:<col>`, `@@DONE`) — the same
single orchestration standard adopted across runtimes in `a46eab1` — parsed by
a **`Stop` hook** that reads the turn's final output from the transcript.

**Why not MCP tools** (the v1 draft): the Hermes experience proved native tools
are the fragile path — `orchestra_handoff` silently broke on Hermes' tool-dispatch
convention, which is exactly the class of failure a text protocol cannot have.
One protocol also means one appendix text, one parser contract, one thing to
debug. MCP remains a *possible future add-on* (e.g. a `orchestra_status` query
tool), never the handoff channel.

**What Claude Code provides that makes this clean** (verify exact names in the
P0 spike against the installed CLI — the surface evolves):

| Orchestra need | pi (shipped) | Hermes (shipped) | Claude Code (this plan) |
|---|---|---|---|
| Live terminal per node | `pi` CLI in PTY | `hermes --tui` in PTY | `claude` (interactive) in PTY |
| Handoff / card / done | `@@HANDOFF` parsed by extension at `agent_end` | Same sentinels, parsed in `transform_llm_output` | Same sentinels, parsed by the **`Stop` hook** from the transcript |
| Ready signal | ext `session_start` → `POST /internal/ready` | `on_session_start` → same | **`SessionStart` hook** → same |
| Turn-started (closed-loop submit confirm) | `before_agent_start` → `POST /internal/turn-started` | `pre_llm_call` (gated once/turn) → same | **`UserPromptSubmit` hook** → same |
| Per-turn context refresh | `before_agent_start` → `GET /internal/orchestra-context` → system prompt | `pre_llm_call` → user-message appendix | **`UserPromptSubmit` hook** → emit `additionalContext` |
| Turn-ended + watchdog | ext `agent_end` (client-side `enforceIntent`) | `post_llm_call` → server-side nudge | **`Stop` hook** → `POST /internal/turn-ended`; **server-side nudge** (like Hermes) |
| Per-node system prompt | `--system-prompt` | `HERMES_EPHEMERAL_SYSTEM_PROMPT` env | `--append-system-prompt` |
| Toolset | `--tools` (`runtimeConfig.toolset`) | `-t` (Hermes vocabulary) | `--allowedTools` (Claude vocabulary: `Read,Edit,Write,Bash,Grep,…`) |
| Callback URL / auth | `PINODES_ORCHESTRA_*` env | identical | **identical** — hooks are child processes and inherit the PTY env |

**Zero new backend endpoints.** The whole integration is client-side bridging to
the existing `/internal/*` contract (`ready`, `orchestra-context`,
`turn-started`, `turn-ended`, `call-agent`, `card-status`). The multi-instance
invariant holds unchanged: hooks read `PINODES_ORCHESTRA_URL` from env, so
callbacks land in the right per-window backend.

Sentinels stay visible in the Claude terminal (as they do for pi — only Hermes
can strip them, via its output-transform hook). Cosmetic, accepted.

---

## 1. Pieces to build

```
backend/
  src/pty/runtime/
    ClaudeRuntime.ts            (new)  extends PtyRuntime; only spawn() differs
    ClaudeRuntime.test.ts       (new)  mirrors HermesRuntime.test.ts
    claudeAvailability.ts       (new)  mirrors hermesAvailability.ts (PATH detect + override)
    claudeAvailability.test.ts  (new)
  claude-hooks/
    orchestra-hook.mjs          (new)  ONE Node script, dispatched by hook event name
    orchestra-hook.test.ts      (new)  parse/POST logic tested in isolation
  src/pty/runtime/resolveClaudeSettings.ts (new)
                                       writes the per-boot hooks settings JSON
                                       (absolute script paths baked at runtime)
```

Touched existing files (all small):

```
backend/src/types.ts               NodeRuntime union: + "claude"
frontend/src/types.ts              mirror
backend/src/routes/orchestra.ts    VALID_RUNTIMES: + "claude"
backend/src/pty/PtyHub.ts          spawn selection branch; watchdog gate (see §3)
backend/src/index.ts               /api/info + /api/health: runtimes.claude
backend/src/ws/handler.ts          `connected` message: runtimes.claude
frontend/src/components/RuntimeSelector.tsx / RuntimeBadge.tsx   third option, "cc" badge
ARCHITECTURE.md, docs/README.md, docs/guides/ (new CLAUDE_RUNTIME.md)
```

### 1.1 `ClaudeRuntime extends PtyRuntime`

Only `spawn()`; inject/resize/kill/markReady/size are inherited (bracketed-paste
+ `\r` submit is PTY-generic — P0 verifies it against the Claude TUI).

```ts
export class ClaudeRuntime extends PtyRuntime {
  spawn(config: RuntimeSpawnConfig): void {
    const cmd = resolveClaudeCommand();          // findInPath("claude"), Windows .cmd-aware
    const settings = resolveClaudeSettings();    // per-boot hooks JSON (see 1.3)
    const args = [
      "--append-system-prompt", config.systemPrompt,
      "--settings", settings,
      // No human sits at a pipeline node: pre-allow the toolset so the PTY
      // never blocks on a permission prompt. Vocabulary is Claude's own.
      "--allowedTools", resolveToolset(config.runtimeConfig, "Read,Edit,Write,Bash,Grep"),
      "--permission-mode", "acceptEdits",        // exact flag semantics: P0
    ];
    // env: PINODES_ORCHESTRA_URL/_BOARD/_NODE/_TOKEN/_FALLBACK_APPENDIX —
    // identical contract to PiRuntime/HermesRuntime (hooks inherit it).
  }
}
```

`resolveToolset` already exists and is runtime-agnostic — reuse with a
Claude-specific default.

### 1.2 The hook bridge — one script, four events

`--settings` wires **one** `orchestra-hook.mjs` to four events; the script
switches on the event name it receives on stdin. It must **fail open** (swallow
network errors, short timeout ~5s) exactly like the Hermes plugin — the backend
already tolerates a missed `ready` (fallback timeout), `turn-started` (submit
watch re-sends `\r`), and `turn-ended` (watchdog is best-effort).

| Hook event | Action |
|---|---|
| `SessionStart` | `POST /internal/ready {boardId, nodeId}` |
| `UserPromptSubmit` | `POST /internal/turn-started` (closed-loop submit confirm), then `GET /internal/orchestra-context` → print `{"hookSpecificOutput": {"additionalContext": <appendix>}}` |
| `Stop` | Read the transcript (`transcript_path` from the hook's stdin JSON), take the last assistant message, parse sentinels: each `@@HANDOFF:<handle>…@@END` → `POST /internal/call-agent`; `@@CARD:<col>` → `POST /internal/card-status`; then `POST /internal/turn-ended {handoffCalledThisTurn: <parsed ≥ 1>}` |
| `SessionEnd` *(if available)* | best-effort no-op today (PTY exit already covers cleanup) |

`boardId`/`nodeId`/URL/token come from the inherited `PINODES_ORCHESTRA_*` env —
**self-gating**: when `PINODES_ORCHESTRA_NODE` is absent the script exits 0
immediately, so a user's own `claude` sessions are never affected (same
isolation rule as the Hermes plugin).

The sentinel parser must be **the same contract** as pi/Hermes: multiple
HANDOFF blocks per turn allowed, recipient by handle, `@@DONE` recognized.
Port the regexes from `call-agent.ts` (they are the reference implementation)
and unit-test them against the same fixtures.

### 1.3 Settings resolution

Hook commands need absolute paths and the bundle location differs per install
(repo checkout vs VSIX `server/`). `resolveClaudeSettings()` writes (once per
backend boot, to the data dir) a settings JSON whose hook commands point at the
bundled `claude-hooks/orchestra-hook.mjs` via absolute path, resolved with the
same `PINODES_ORCHESTRA_ROOT`-aware logic used for prompts/extension today.
Idempotent, no global state touched — **no `~/.claude` writes**, everything is
passed per-spawn (`--settings`), which is *cleaner than Hermes* (no install step
at all).

---

## 2. Availability & selection

Mirror the Hermes pattern exactly:

- `claudeAvailability.ts`: `claude` on the backend PATH → available;
  `PINODES_ORCHESTRA_CLAUDE=false` forces off, `=true` forces on.
- `/api/info`, `/api/health`, WS `connected` expose `runtimes.claude` next to
  `runtimes.hermes`; the runtime selector shows the third option only when
  available, and a node whose runtime is unavailable **falls back to pi at
  spawn** (existing behavior, keep it).

```ts
// PtyHub spawn selection (evaluated at spawn time, like Hermes)
const runtime: INodeRuntime =
  node?.runtime === "hermes" && isHermesRuntimeAvailable() ? new HermesRuntime()
  : node?.runtime === "claude" && isClaudeRuntimeAvailable() ? new ClaudeRuntime()
  : new PiRuntime();
```

---

## 3. The one real backend change: the watchdog gate

`PtyHub.handleTurnEnded` currently gates the server-side handoff nudge to
`runtime === "hermes"` (pi enforces intent client-side). Claude has no
client-side enforcer, so it needs the server-side nudge too. Replace the
equality check with an explicit capability set:

```ts
/** Runtimes whose non-final-node handoff enforcement is server-side
 *  (pi enforces client-side in its extension). */
const SERVER_NUDGED_RUNTIMES: ReadonlySet<NodeRuntime> = new Set(["hermes", "claude"]);
```

This is the only PtyHub logic change; everything else is additive. It gets its
own characterization test **before** the change (hermes nudged / pi not), then
the claude case is added.

---

## 4. Phases (test-first)

| Phase | Deliverable | Gate |
|---|---|---|
| **P0 — spike (½–1 day)** | Manually: `claude` in a PTY via `node -e` + node-pty; verify ① TUI renders through xterm-size PTY, ② bracketed-paste + `\r` submits, ③ `--settings` hooks fire (log to file), ④ `UserPromptSubmit` `additionalContext` reaches the model, ⑤ `Stop` stdin JSON includes a readable `transcript_path`, ⑥ exact flag names/semantics on the installed CLI (`--append-system-prompt`, `--allowedTools`, `--permission-mode`), ⑦ killing the PTY reaps the process tree. | Any failure here stops the plan (this is the make-or-break). Write results to `docs/archive/CLAUDE_RUNTIME_SPIKE_RESULT.md`. |
| **P1 — types & availability (½ day)** | `NodeRuntime` + `"claude"`, `VALID_RUNTIMES`, `claudeAvailability.ts` + tests, `runtimes.claude` in info/health/WS. | `npm test` green; UI unchanged (selector still 2 options until P5). |
| **P2 — hook bridge (1–2 days)** | `orchestra-hook.mjs` + isolated tests: sentinel parsing (same fixtures as `call-agent.test.ts`), POST shapes, self-gating without env, fail-open on network error. | Tests green without any Claude installed (pure Node). |
| **P3 — ClaudeRuntime (1–2 days)** | `ClaudeRuntime.ts` + `resolveClaudeSettings.ts` + tests mirroring `HermesRuntime.test.ts` (spawn args, env, toolset override + fallback, exit handling). | Tests green; `PiRuntime`/`HermesRuntime` tests untouched. |
| **P4 — PtyHub wiring (1 day)** | Spawn selection branch; watchdog gate → `SERVER_NUDGED_RUNTIMES` (characterization test first). | `detect_changes()` shows only expected symbols; full suite green. |
| **P5 — frontend (½–1 day)** | RuntimeSelector third option (gated on `runtimes.claude`), `RuntimeBadge` "cc", labels "{runtime}". | Frontend tests green. |
| **P6 — e2e + docs (1 day)** | Mixed graph pi → claude → hermes on the pre-merge checklist (incl. the two closed-loop submit rows); `docs/guides/CLAUDE_RUNTIME.md`; ARCHITECTURE runtime table 🔜→✅; this plan → `docs/archive/`. | Checklist pass + `npm run build`. |

**Total: ~1 week** (vs ~3–4 for Hermes — the runtime abstraction, the text
protocol, the closed-loop submit and the availability pattern all exist now).

---

## 5. Risks & open questions

| # | Risk | Mitigation |
|---|------|------------|
| 1 | **Permission prompts block the pipeline** (tool approval UX in interactive mode) | `--allowedTools` + `--permission-mode`; P0 ⑥ verifies exact semantics on the installed version; fallback: `--dangerously-skip-permissions` is **not** acceptable — prefer documenting a narrower default toolset |
| 2 | **`UserPromptSubmit` fires per user prompt, not per agentic step** | That matches what we need (appendix refresh + turn-started when a task arrives). pi behaves the same way. Validate graph-edit pickup latency in P6. |
| 3 | **`Stop` may fire on subagent stops / re-fire** | `handleTurnEnded` retry state is keyed and clears on handoff (already idempotent); prefer the top-level Stop event only (`stop_hook_active` guard) — P0 ⑤ |
| 4 | **Transcript format drift** (Stop-hook parsing depends on the JSONL shape) | Parser lives in one function with fixtures; a drift breaks tests, not prod silently (fail-open → watchdog nudges) |
| 5 | **CLI surface evolves** | Pin the tested `claude --version` in the spike result doc; availability check can gate on a minimum version if needed |
| 6 | **Auth/credentials** | Claude Code inherits the host env / its own login — Orchestra never manages it; keep out of `runtimeConfig` (secret-free by contract) |
| 7 | **Orphaned processes on kill** | P0 ⑦; PtyRuntime.kill() SIGKILLs the PTY child — verify the `claude` process tree dies with it |

---

## 6. What NOT to do

1. **No MCP server for handoff/card** — one text protocol, one parser contract.
2. **No new `/internal/*` endpoints** — the six existing ones cover everything.
3. **No writes to `~/.claude`** — settings are passed per-spawn via `--settings`.
4. **No PtyHub rewrite** — one selection branch + the watchdog-gate set.
5. **No acting on non-Orchestra sessions** — hook script self-gates on `PINODES_ORCHESTRA_NODE`.
6. **No enabling when unavailable** — same auto-detect + fallback-to-pi as Hermes.

---

## 7. Definition of done

A node with `runtime: "claude"` (with `claude` on the backend PATH) boots a live
Claude Code terminal in its card, receives tasks with closed-loop submit
confirmation, refreshes its orchestration appendix per task, hands off /
moves Kanban cards / declares `@@DONE` via the shared sentinel protocol, is
nudged server-side when a non-final node ends without explicit intent, and
cleans up on kill — all through the unchanged `/internal/*` contract, with pi
and Hermes behavior byte-identical to today.
