# Zero (Gitlawb/zero) runtime — integration analysis

> **Status: deferred (analysis only).** This document captures a feasibility study
> for adding **Zero** (the `zero` CLI, https://github.com/Gitlawb/zero) as a
> native node runtime alongside `pi` and `hermes`. Native `runtime: "zero"` is
> **not viable via the shipped TUI-in-PTY pattern today** — the interactive mode
> lacks a per-node system prompt and a turn-end hook, both load-bearing for the
> shared text-sentinel handoff protocol. A **headless (`zero exec`, stream-json)
> runtime is technically feasible** but requires a new, non-PTY `INodeRuntime`
> shape. The current roadmap prioritises Claude Code first. Revisit this doc if
> upstream Zero adds a per-turn system-prompt flag and a turn-end hook to
> interactive mode.
>
> Companion docs:
> [`ARCHITECTURE.md`](../../ARCHITECTURE.md) (runtime model),
> [`roadmaps/EXTENSIONS_ROADMAP.md`](../roadmaps/EXTENSIONS_ROADMAP.md) (sequencing),
> [`plans/CLAUDE_CODE_RUNTIME_PLAN.md`](./CLAUDE_CODE_RUNTIME_PLAN.md) (preferred next runtime),
> [`plans/CURSOR_RUNTIME_ANALYSIS.md`](./CURSOR_RUNTIME_ANALYSIS.md) (same kind of analysis, different runtime),
> [`guides/HERMES_RUNTIME.md`](../guides/HERMES_RUNTIME.md) (reference implementation).

**Date:** 2026-07-02
**Verified against:** Gitlawb/zero `main` branch, v0.1.0 (released July 2026, ~401 commits,
~14 GitHub stars), via GitHub API / raw source (README, `docs/STREAM_JSON_PROTOCOL.md`,
`internal/cli/app.go`, `internal/hooks/hooks.go`, `internal/agent/system_prompt.go`).
No local install — analysis is source/doc-based, not a hands-on spike.

---

## 1. Executive summary

| Question | Answer |
|----------|--------|
| What is Zero? | An open-source (MIT), Go-based terminal coding agent supporting 25+ LLM providers (OpenAI, Anthropic, Gemini, Ollama, LM Studio, OpenRouter, …), with a TUI, a headless `zero exec` mode, MCP, plugins, hooks, and specialist subagents. |
| Can Orchestra integrate Zero as a **native PTY node runtime** (the pi/Hermes/Claude pattern)? | **No, not today.** Interactive mode has no per-node system-prompt flag and no turn-end hook — both required by the shared `@@HANDOFF`/`@@CARD`/`@@DONE` sentinel protocol. |
| Can Orchestra integrate Zero at all? | **Yes, via headless `zero exec --output-format stream-json`.** This covers system-prompt-per-node, turn boundaries, and tool gating, but requires a new **non-PTY** runtime shape — a different architecture from every runtime shipped so far. |
| Is it worth doing now? | **No.** Claude Code is a cleaner, already-planned next runtime with zero architectural novelty. Zero's headless path is a bigger lift (new runtime *kind*, not just a new adapter) for a project at v0.1.0 with 14 stars — maturity risk on top of the design gap. |
| Never say never? | Zero is early and evolving fast; the two missing interactive-mode primitives (system prompt flag, turn-end hook) are small, plausible additions upstream. Re-check after a version bump. |

---

## 2. Orchestra today — runtime landscape

Orchestra is a visual agent canvas where each node is a **real process** attached to
an xterm terminal. The backend (`PtyHub`) is **runtime-agnostic**: it selects an
adapter implementing `INodeRuntime` (`backend/src/pty/runtime/INodeRuntime.ts`).

| Runtime | Status | Handoff mechanism |
|---------|--------|-------------------|
| **pi** (default) | ✅ Shipped | `@@HANDOFF` text block parsed by `call-agent.ts` |
| **hermes** | ✅ Shipped (auto-detected on PATH) | **Same** `@@HANDOFF` text block, parsed by the plugin's `transform_llm_output` hook |
| **claude** | ✅ Shipped | Same `@@HANDOFF` text protocol + lifecycle hooks — [guides/CLAUDE_RUNTIME.md](../guides/CLAUDE_RUNTIME.md) |
| **cursor** | 🔜 Deferred | Not implemented — see [CURSOR_RUNTIME_ANALYSIS.md](./CURSOR_RUNTIME_ANALYSIS.md) |
| **zero** | 🔜 Deferred | Not implemented; this document |
| **openclaw** | 🔜 Planned | Gateway RPC |

**Product invariant:** live PTY per node, visible handoffs, human intervention.
Every shipped and planned runtime so far is "one interactive CLI process in a PTY."
A Zero integration that preserves this invariant runs into the gaps in §4; one that
doesn't (headless) requires a new runtime shape (§6).

---

## 3. Zero CLI — capabilities relevant to Orchestra

### 3.1 Interactive TUI mode

- `zero` with no subcommand launches a setup wizard, then the interactive TUI.
  `Enter` submits a prompt; `/` triggers slash-command suggestions.
- Flags available in interactive mode (from `internal/cli/app.go`):
  `--add-dir <path>` (extra writable directory), `--skip-permissions-unsafe`
  (enables the `!` shell escape, disables prompt gating), `--theme <name>`.
- **No system-prompt flag, no session-id/name flag, no settings/hooks-config
  flag, and no tool-allowlist flag exist for interactive mode.** All of those
  exist only under `zero exec` (see 3.2).

### 3.2 Headless / pipeline mode (`zero exec`)

- `--prompt <text>` / `-f, --file <path>` / `--image <path>` — prompt input.
- `--init-session-id <id>`, `--session-title <text>`, `--resume [id]`,
  `--fork <id>` — session lifecycle, sessions are stored on disk and resumable.
- `--auto <low|medium|high>` — autonomy/permission tier (`high` enables unsafe
  tools); `--skip-permissions-unsafe` — allow prompt-gated tools without
  approval; `--enabled-tools <tools>` / `--disabled-tools <tools>` — explicit
  toolset gating.
- `--output-format text|json|stream-json`, `--input-format` — structured,
  line-delimited I/O documented in `docs/STREAM_JSON_PROTOCOL.md`.
- `--model`, `--mode <smart|deep|fast|large|precise>`, `--worktree`,
  `--add-dir` — per-run configuration.

### 3.3 Stream-JSON protocol (`docs/STREAM_JSON_PROTOCOL.md`)

- Output events: `run_start` (includes `runId`/`sessionId`), `text` (assistant
  message deltas), `tool_call`, `permission_request` / `permission_decision`,
  `tool_result`, `usage`, `final` (complete response), `run_end`.
- Input events (line-delimited JSON via stdin or file): `message` (user
  content) and `prompt` (system instructions) — Zero concatenates accepted
  input event content in order, separated by blank lines.
- **Single-turn per invocation.** The doc states headless `exec` has no
  interactive permission responder — permission requests are auto-denied
  unless pre-approved via `--auto`/`--enabled-tools`/`--skip-permissions-unsafe`.
  Multi-turn continuity is achieved by re-invoking `zero exec --resume <id>`,
  not by holding one process open across turns.

### 3.4 Extension surfaces

| Surface | Purpose for Orchestra |
|---------|---------------------|
| **Hooks** (`~/.config/zero/hooks.json` or `./.zero/hooks.json`) | Lifecycle signals — see §4 for the gap |
| **MCP** (`zero mcp`) | Could expose `orchestra_handoff` / `orchestra_card`, same pattern as the Claude Code plan |
| **Plugins** (`zero plugins`) | Sparsely documented; not evaluated here |
| **Specialists** (`zero specialist`) | Subagent delegation; separate concept from Orchestra node handoff |
| **System prompt sources** (`internal/agent/system_prompt.go`) | See §4.2 |

### 3.5 System prompt construction (`internal/agent/system_prompt.go`)

Verified sources of custom system-prompt content, in order:

1. `options.SystemPrompt` — a direct override, but **only reachable via
   whatever exposes `Options` to the caller**; not exposed as an interactive
   CLI flag (only implied for `exec`-style invocations).
2. Project guideline files — `AGENTS.md`, `ZERO.md`, `.zero/AGENTS.md`, walked
   from git root to cwd, first match per directory level wins, 8 KiB/file,
   32 KiB total.
3. `options.ResponseStyle` (`concise`/`explanatory`/`review`) — style
   directives, not per-node identity.
4. Model-specific addendum, keyed off the model name.
5. Specialist delegation context, if specialists are configured.

**No environment variable feeds the system prompt.** This matters for Orchestra:
`PiRuntime`/`HermesRuntime`/the planned `ClaudeRuntime` all pass
`PINODES_ORCHESTRA_*` env vars and inject the per-node role/appendix via a CLI
flag or hook. Zero has neither for interactive mode — the only shared,
filesystem-scoped input (`AGENTS.md`) cannot carry a *different* role per node
when multiple Zero nodes share a cwd, which is the normal Orchestra topology.

---

## 4. Hooks — native support and Orchestra mapping

### 4.1 Defined hook events (`internal/hooks/hooks.go`)

Six event constants exist: `beforeTool`, `afterTool`, `sessionStart`,
`sessionEnd`, `specialistStart`, `specialistStop`.

Configuration is file-based only — no CLI flag for a per-spawn hooks file (unlike
Claude Code's `--settings`): `~/.config/zero/hooks.json` (user-level, XDG-aware)
or `./.zero/hooks.json` (project-level).

### 4.2 Mapping against the Orchestra contract

| Orchestra need | Hermes (shipped) | Claude Code (planned) | Zero |
|---|---|---|---|
| Ready signal | `on_session_start` | `SessionStart` hook | `sessionStart` ✅ |
| Turn-started (closed-loop submit confirm) | `pre_llm_call` | `UserPromptSubmit` hook | ❌ no equivalent event |
| Per-turn context refresh (`additionalContext`) | `pre_llm_call` appendix | `UserPromptSubmit` → `additionalContext` | ❌ no equivalent event |
| Turn-ended + sentinel parsing (`@@HANDOFF`/`@@CARD`/`@@DONE`) | `post_llm_call` (server nudge) / `transform_llm_output` (client parse) | `Stop` hook reads transcript | ❌ **no turn-end hook** — `sessionEnd` is end-of-*session*, not end-of-*turn*; `afterTool` fires per tool call, not per assistant turn |
| Per-node system prompt / identity | `HERMES_EPHEMERAL_SYSTEM_PROMPT` env | `--append-system-prompt` | ❌ no flag or env in interactive mode (§3.5) |

This is the structural blocker: the shared text-sentinel protocol works because
every shipped/planned runtime has **(a)** a way to inject a distinct role per
node and **(b)** a hook that fires once per completed turn, with access to that
turn's final output, from which sentinels are parsed and posted to
`/internal/call-agent` / `/internal/card-status` / `/internal/turn-ended`. Zero's
interactive mode has neither. Two Zero nodes on the same board would be
identical processes with no way to tell them apart, and there is no client-side
place to detect "this turn ended, here is what it said."

---

## 5. Why the PTY approach (pattern used by pi/Hermes/Claude) doesn't transfer

`ClaudeRuntime` (planned) and `HermesRuntime`/`PiRuntime` (shipped) all reduce to
the same shape: spawn one long-lived interactive CLI in a PTY, pass identity via
env + a system-prompt flag, and use a hook that fires on turn completion to
extract sentinels from that turn's output. Applying the same shape to Zero hits
two independent gaps at once (§4.2): no way to differentiate node role, and no
turn-boundary hook to read from. Neither gap has a workaround that stays
within "interactive TUI in a PTY":

- Faking a per-node role via a per-node `.zero/AGENTS.md` would require a
  separate working directory per node (breaking the "nodes share a repo
  checkout" default) or rewriting the shared file before every spawn (races
  across concurrent nodes).
- Faking turn-end detection from `afterTool` (fires per tool call, not per
  turn) or output-scraping the PTY stream (fragile, no structured turn
  boundary marker) does not meet the "no MCP tools, no ad-hoc heuristics"
  bar the Claude Code plan explicitly sets for the sentinel protocol
  (`CLAUDE_CODE_RUNTIME_PLAN.md`, §0: "one protocol, one parser contract").

Conclusion: a Zero `INodeRuntime` implementing the existing pattern is not a
small adapter — it would need upstream changes to Zero itself (a system-prompt
flag/env for interactive mode, a real turn-end hook), which puts it out of
Orchestra's control.

---

## 6. Alternative — a headless (non-PTY) `ZeroRuntime`

`zero exec --output-format stream-json` has every primitive the PTY approach
lacks, because it operates per-invocation rather than per-session:

| Orchestra need | `zero exec` equivalent |
|---|---|
| Per-node identity/system prompt | `prompt`-type input event, or `--prompt`/`-f` per invocation |
| Turn-started | `run_start` event (has `runId`/`sessionId`) |
| Turn-ended + sentinel parsing | `final` event — parse `@@HANDOFF`/`@@CARD`/`@@DONE` from its text, same regexes as `call-agent.ts` |
| Session continuity across turns | `--init-session-id <id>` once, then `--resume <id>` per subsequent turn |
| Toolset / permission gating (safe for unattended pipelines) | `--enabled-tools`/`--disabled-tools` + `--auto <low|medium|high>` |
| Ready signal | Backend-side: emit on successful first `run_start` |

The cost is architectural, not incremental: `INodeRuntime.spawn()` currently
assumes one long-lived process whose stdout streams continuously into an xterm
buffer (`onOutput`), and `inject()` assumes writing into a live PTY. A headless
Zero node would instead **re-invoke the process once per turn** (`zero exec
--resume <id> < turn.jsonl`), parse structured stdout, and synthesize terminal-
like rendering for the card UI from the stream-json events (`text` deltas,
`tool_call`, `tool_result`) rather than relaying raw ANSI. `inject()` becomes
"start a new `zero exec` invocation with this message," not "write bytes into
an existing pty". This is a genuinely different `INodeRuntime` implementation
shape than anything shipped — closer to approach 5.3 in the Cursor analysis
("SDK structured path") than to `HermesRuntime`.

This also means Zero nodes would not get a literal terminal a human can type
into mid-turn the way pi/Hermes/Claude nodes do — breaking the "live PTY per
node" product invariant (§2) unless a hybrid UI (structured stream + injected
follow-up prompt) is built specifically for this runtime kind.

---

## 7. Runtime parity matrix

| Orchestra requirement | pi | Hermes | Claude (plan) | Zero (interactive/PTY) | Zero (headless/exec) |
|---|---|---|---|---|---|
| PTY + xterm, human can type mid-turn | ✅ | ✅ | ✅ | ✅ (TUI exists) | ❌ (no live process to type into) |
| Per-node system prompt / identity | ✅ flag | ✅ env | ✅ flag (plan) | ❌ none | ✅ input event |
| Structured handoff (`@@HANDOFF`) | text | text | text (plan) | ⚠️ no hook to parse from | ✅ parse `final` event |
| Turn-started signal | ext hook | `pre_llm_call` | `UserPromptSubmit` (plan) | ❌ none | ✅ `run_start` |
| Turn-end watchdog | ext hook | `post_llm_call` | `Stop` hook (plan) | ❌ no turn-end hook, only `sessionEnd` | ✅ `final`/`run_end` |
| Ready signal | ext `session_start` | `on_session_start` | `SessionStart` hook | ✅ `sessionStart` hook | ✅ (backend-inferred) |
| Unattended pipeline / no permission prompts | ✅ | ✅ | `--allowedTools` (plan) | ⚠️ only `--skip-permissions-unsafe` (all-or-nothing) | ✅ `--enabled-tools` + `--auto` |
| Multi-provider (non-Anthropic models) | provider-dependent | provider-dependent | Anthropic only | ✅ 25+ providers | ✅ 25+ providers |

**Verdict:** Zero's interactive/PTY mode fails parity on the two requirements
that matter most (identity, turn boundary). Zero's headless mode passes every
functional row but fails the PTY/live-terminal row by construction — it is a
different kind of runtime, not a gap to close.

---

## 8. Known problems and risks

### 8.1 Critical gaps (interactive/PTY path)

| # | Problem | Impact | Possible mitigation |
|---|---------|--------|---------------------|
| P1 | **No per-node system prompt in interactive mode** | Cannot differentiate node roles; `AGENTS.md` is shared per cwd | Request upstream flag/env; until then, not fixable client-side without per-node working directories |
| P2 | **No turn-end hook** (`sessionEnd` ≠ end of turn) | No client-side point to parse `@@HANDOFF`/`@@CARD`/`@@DONE` or confirm turn completion | Request upstream hook event; no safe workaround (see §5) |
| P3 | **No per-spawn hooks config** (file-based only, no `--settings`-equivalent) | Multi-node hook isolation on shared cwd is fragile (same class of issue as Cursor's O-risk) | Env-gate hook scripts on `PINODES_ORCHESTRA_NODE`, same pattern as Hermes/Claude plan |

### 8.2 Architectural cost (headless path)

| # | Problem | Impact | Mitigation |
|---|---------|--------|------------|
| A1 | **New `INodeRuntime` shape required** | Not a small adapter like `HermesRuntime`; touches the spawn/inject/output contract itself | Scope as its own design doc if pursued, not a "just add ZeroRuntime.ts" task |
| A2 | **Loses live-PTY human intervention** | Breaks the stated product invariant (§2) unless a hybrid UI is built | Explicit product decision needed before implementation |
| A3 | **Per-turn process respawn** (`--resume` on every turn) | Latency/cold-start cost per turn vs. one long-lived process | Acceptable for pipeline-style nodes; measure before committing |

### 8.3 Maturity / strategic risks

| # | Problem | Notes |
|---|---------|-------|
| S1 | **v0.1.0, ~14 stars, July 2026 release** | Early project; CLI surface (flags, hook events) likely to change before Orchestra could ship against it |
| S2 | **Duplicate effort vs. Claude Code** | Claude Code plan already covers hooks + sentinel parsing + per-node identity with zero new architecture; ship that first |
| S3 | **Value proposition is provider breadth, not UX** | Zero's main draw for Orchestra is 25+ providers / local models (Ollama, LM Studio) — a real want, but doesn't offset the two structural gaps above |

---

## 9. Recommended sequencing

| Priority | Action | Rationale |
|----------|--------|-----------|
| **Now** | No Zero integration | Structural gaps (§4.2, §5) block the shipped PTY pattern |
| **Next native runtime** | **Claude Code** per [CLAUDE_CODE_RUNTIME_PLAN.md](./CLAUDE_CODE_RUNTIME_PLAN.md) | Satisfies every requirement natively, no new runtime shape |
| **If revisiting Zero** | 1) File upstream feature requests for a per-node system-prompt flag/env and a turn-end hook in interactive mode; 2) re-check after those land | Would unblock the same PTY pattern used everywhere else, avoiding the headless architectural cost |
| **If provider breadth is urgent sooner** | Evaluate the headless `zero exec` runtime (§6) as an explicit, separate "non-PTY node" product decision | Only worth it if losing live-terminal intervention for these nodes is acceptable |
| **Defer** | `runtime: "zero"` production implementation | Cost/benefit unfavourable today on both paths |

---

## 10. Files that would be touched (future implementation, headless path)

```
backend/src/pty/runtime/
  ZeroRuntime.ts              (new — does NOT extend PtyRuntime; new base shape)
  ZeroRuntime.test.ts         (new)
  zeroAvailability.ts         (new — mirrors hermesAvailability.ts)
backend/src/pty/runtime/INodeRuntime.ts
                               — evaluate whether a new interface (non-PTY) is
                                 needed alongside INodeRuntime, or whether
                                 spawn/inject can be reinterpreted per-turn
backend/src/types.ts           — NodeRuntime union: + "zero"
frontend/src/types.ts          — mirror
frontend/src/components/       — new rendering path for stream-json → card
                                 output (not a raw xterm feed)
backend/src/pty/PtyHub.ts       — spawn selection branch; turn-based re-invoke
                                  loop instead of write()/inject() into a PTY
ARCHITECTURE.md, docs/README.md — runtime table + explicit note on the
                                   non-PTY nature of this runtime
```

Feature flag sketch: `PINODES_ORCHESTRA_ZERO=true` (mirror Hermes/Claude pattern).

---

## 11. Conclusion

- **Zero as a native PTY runtime (the pi/Hermes/Claude pattern):** not viable
  today. Interactive mode has no per-node system prompt and no turn-end hook —
  both load-bearing for the shared `@@HANDOFF` sentinel protocol, and neither
  has a safe client-side workaround.
- **Zero via headless `zero exec` + stream-json:** technically feasible and
  functionally complete (identity, turn boundaries, tool gating, sessions all
  present), but requires a genuinely new, non-PTY `INodeRuntime` shape and
  gives up the live-terminal human-intervention invariant for these nodes.
- **Practical recommendation:** ship Claude Code as the next native runtime
  (no architectural novelty, plan already written); keep this analysis on file
  and re-open it either after Zero adds the two missing interactive-mode
  primitives, or as a deliberate product decision to add a non-PTY runtime kind
  for provider breadth (local models via Ollama/LM Studio, 25+ providers).

---

## References

- [CLAUDE_CODE_RUNTIME_PLAN.md](./CLAUDE_CODE_RUNTIME_PLAN.md) — preferred next runtime
- [CURSOR_RUNTIME_ANALYSIS.md](./CURSOR_RUNTIME_ANALYSIS.md) — same kind of analysis, different runtime, same conclusion shape
- [HERMES_RUNTIME.md](../guides/HERMES_RUNTIME.md) — shipped reference
- [ARCHITECTURE.md](../../ARCHITECTURE.md) — handoff contract
- Zero repository: https://github.com/Gitlawb/zero (README, `docs/STREAM_JSON_PROTOCOL.md`, `docs/SPECIALISTS.md`)
- Zero source verified: `internal/cli/app.go`, `internal/hooks/hooks.go`, `internal/agent/system_prompt.go`
