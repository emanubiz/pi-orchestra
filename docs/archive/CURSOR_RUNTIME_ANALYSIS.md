# Cursor Agent runtime — integration analysis

> **Status: deferred (analysis only).** This document captures a feasibility study
> for adding **Cursor Agent** (`agent` CLI) as a native node runtime alongside
> `pi` and `hermes`. Native `runtime: "cursor"` is **technically possible** but
> carries meaningful gaps versus Hermes and Claude Code. The current roadmap
> prioritises Claude Code first; pi-as-proxy already covers the Cursor model
> today. Revisit this doc if Cursor ships stronger lifecycle hooks or in-process
> tool registration.
>
> Companion docs:
> [`ARCHITECTURE.md`](../../ARCHITECTURE.md) (runtime model),
> [`roadmaps/EXTENSIONS_ROADMAP.md`](../roadmaps/EXTENSIONS_ROADMAP.md) (sequencing),
> [`CLAUDE_CODE_RUNTIME_PLAN.md`](./CLAUDE_CODE_RUNTIME_PLAN.md) (preferred next runtime),
> [`guides/HERMES_RUNTIME.md`](../guides/HERMES_RUNTIME.md) (reference implementation).

**Date:** 2026-07-01  
**Verified against:** Cursor Agent CLI `agent` v2026.06.29 (local `agent --help`)

---

## 1. Executive summary

| Question | Answer |
|----------|--------|
| Can Orchestra integrate Cursor as a **host IDE**? | **Yes — already shipped.** The VS Code extension (`emanubiz.pinodes-orchestra-vscode`) runs in Cursor via Open VSX. |
| Can Orchestra integrate Cursor Agent as a **node runtime**? | **Yes, with caveats.** Requires MCP bridge + hooks + PTY spike; not parity with Hermes without further Cursor API surface. |
| Is it worth doing now? | **Probably not.** pi-as-proxy (`pi` with Cursor provider) works today. Claude Code is a cleaner next native runtime (MCP + documented per-turn hooks). |
| Never say never? | Cursor CLI evolves quickly (hooks, MCP, SDK, sessions). A focused spike could validate or disprove the gaps in a few days. |

---

## 2. Orchestra today — runtime landscape

Orchestra is a visual agent canvas where each node is a **real process** attached to
an xterm terminal. The backend (`PtyHub`) is **runtime-agnostic**: it selects an
adapter implementing `INodeRuntime`.

| Runtime | Status | Handoff mechanism |
|---------|--------|-------------------|
| **pi** (default) | ✅ Shipped | `@@HANDOFF` text block parsed by `call-agent.ts` |
| **hermes** | ✅ Shipped (auto-detected on PATH) | **Same** `@@HANDOFF` text block, parsed by the plugin's `transform_llm_output` hook |
| **claude** | ✅ Shipped | Same `@@HANDOFF` text protocol + lifecycle hooks — [guides/CLAUDE_RUNTIME.md](../guides/CLAUDE_RUNTIME.md) |
| **cursor** | 🔜 Deferred | Not implemented; this document |
| **openclaw** | 🔜 Planned | Gateway RPC |

**Product invariant:** live PTY per node, visible handoffs, human intervention.
Any Cursor integration must preserve these unless deliberately choosing a
non-PTY SDK path (see §5.3).

---

## 3. Two different CLIs — do not conflate them

| Command | Role | Useful for Orchestra runtime? |
|---------|------|-------------------------------|
| `cursor` | IDE launcher (open files, extensions, `--add-mcp`) | **Host only** — runs the Orchestra extension panel |
| `agent` | Agent runtime (interactive TUI + headless `--print`) | **This** is the candidate for `CursorRuntime` |

Orchestra does **not** spawn `cursor` for agent nodes. It would spawn `agent`
(the Cursor Agent CLI), analogous to how `HermesRuntime` spawns `hermes --tui`.

---

## 4. Cursor Agent CLI — capabilities relevant to Orchestra

Verified locally (`agent --help`, headless smoke test with `--print --trust
--output-format stream-json`).

### 4.1 Interactive mode (default)

- Full TUI when run without `--print` — candidate for `node-pty` + xterm.js
  (same path as pi / Hermes).
- `--workspace` / `--add-dir` — per-node working directory.
- `--resume [chatId]` / `create-chat` — isolated session per node.
- `--model`, `--mode plan|ask`, `--worktree` — per-node configuration.

### 4.2 Headless / pipeline mode

- `--print` — non-interactive; all tools available including shell/write.
- `--force` / `--yolo` — auto-approve commands unless explicitly denied.
- `--trust` — trust workspace without prompting (headless only).
- `--approve-mcps` — auto-approve MCP servers (needed for unattended pipelines).
- `--output-format text|json|stream-json` — structured events for automation.

### 4.3 Extension surfaces

| Surface | Purpose for Orchestra |
|---------|---------------------|
| **MCP** (`agent mcp`, `.cursor/mcp.json`, `--add-mcp`) | Expose `orchestra_handoff` / `orchestra_card` — same pattern as Claude Code plan |
| **Hooks** (`~/.cursor/hooks.json` or project-level) | Lifecycle signals: ready, turn-ended, tool audit |
| **`--plugin-dir`** | Load local plugins (format sparsely documented) |
| **`@cursor/sdk`** | `Agent.create()` + streaming — alternative to PTY |
| **`agent worker`** | Private cloud worker — different use case (remote nodes) |

### 4.4 What Cursor does **not** expose (today)

- No **`register_tool`** in the agent loop (unlike Hermes `ctx.register_tool`).
- No documented **per-turn context injection** hook equivalent to Hermes
  `pre_llm_call` → `GET /internal/orchestra-context`.
- No public **OpenAI-compatible chat API** for Cursor as a provider (only
  unofficial local proxies exist).

---

## 5. Integration approaches

### 5.1 A. pi-as-proxy — works **now**, zero Orchestra code

```
Orchestra node (runtime: pi) → pi with Cursor provider / --cursor / MCP bridge
```

- Handoff: existing `@@HANDOFF` text parsing in `call-agent.ts`.
- The text protocol exists partly because **Cursor Composer does not expose
  extension-registered tools to the model** — Orchestra cannot rely on IDE
  extension tools for handoff inside Cursor-hosted agents.
- **Pros:** zero development; already documented in [EXTENSIONS_ROADMAP.md](../roadmaps/EXTENSIONS_ROADMAP.md).
- **Cons:** not a native Cursor node; pi is the intermediary; user sees a pi
  badge, not a Cursor badge.

### 5.2 B. `agent` in PTY — `CursorRuntime extends PtyRuntime` (planned shape)

Same architecture as `HermesRuntime`:

```
PtyHub → CursorRuntime → pty.spawn("agent", [...]) → xterm.js
```

**Would require:**

1. `CursorRuntime.ts` — spawn `agent` with Orchestra env (`PINODES_ORCHESTRA_*`).
2. **stdio MCP server** `orchestra` — `orchestra_handoff`, `orchestra_card`
   → existing `/internal/*` endpoints (no new backend routes).
3. **Hooks** in project `.cursor/hooks.json` (or generated per spawn) mirroring
   the Hermes plugin contract:
   - `sessionStart` → `POST /internal/ready`
   - `stop` → `POST /internal/turn-ended`
   - `beforeSubmitPrompt` → `GET /internal/orchestra-context` *(uncertain — see §6)*
4. Headless pipeline flags: `--force`, `--approve-mcps`, `--trust`.
5. Per-node session: `create-chat` + `--resume <id>`.
6. **Mandatory spike:** TUI `agent` inside xterm (ANSI, resize, bracketed-paste inject).

**Pros:** preserves Orchestra's live-terminal invariant.  
**Cons:** appendix-per-turn gap; MCP/shell permission handling in unattended flows;
multi-node hook isolation on shared cwd untested.

### 5.3 C. SDK structured path — `Agent.create()` via `@cursor/sdk`

- Stream JSON to a custom panel instead of raw xterm.
- Hooks respected by the SDK runtime.
- **Breaks** the "real terminal for human intervention" invariant unless building
  a hybrid UI (structured stream + input injection).
- Better fit for CI/automation than the interactive canvas.

### 5.4 D. Extension API inside Cursor (host-only)

- Orchestra panel already exists in the VS Code/Cursor extension host.
- Nodes could call Cursor agent APIs from the extension process.
- **Only works** when Orchestra runs inside Cursor — not standalone PWA or
  Hermes Desktop without duplicating the integration.

---

## 6. Hooks — native support and Orchestra mapping

Cursor Agent has a real hook system (`hooks.json`). Example events on a
developer machine:

| Cursor hook event | Orchestra equivalent | Confidence |
|-------------------|---------------------|------------|
| `sessionStart` | `POST /internal/ready` | ✅ High |
| `stop` | `POST /internal/turn-ended` | ✅ High |
| `beforeSubmitPrompt` | `GET /internal/orchestra-context` (per-turn appendix) | ⚠️ **Uncertain** — `additional_context` output is documented for `postToolUse`, not clearly for `beforeSubmitPrompt` |
| `preToolUse` / `postToolUse` | Tool gate / audit; detect `orchestra_handoff` via MCP | ✅ Useful |
| `beforeMCPExecution` | Pre-approve MCP in headless mode | ✅ Useful |
| `beforeShellExecution` | Shell safety gate | ✅ Useful |
| `subagentStart` / `subagentStop` | Cursor internal subagents | ℹ️ Not Orchestra handoff |

### Hermes reference (what Cursor must approximate)

```python
# backend/hermes-plugins/orchestra/__init__.py (abbreviated)
# on_session_start     → POST /internal/ready
# pre_llm_call         → POST /internal/turn-started + GET /internal/orchestra-context
# transform_llm_output → parse @@HANDOFF/@@CARD → POST /internal/call-agent
# post_llm_call        → POST /internal/turn-ended
```

Hermes provides three pieces Cursor does not replicate 1:1:

1. **An output-transform hook** (`transform_llm_output`) that parses the
   `@@HANDOFF` sentinels *and strips them from the shown output* — Cursor has no
   equivalent, so sentinels would stay visible or need MCP tools instead.
2. **Guaranteed per-turn appendix injection** (`pre_llm_call`) — Cursor gap (§6).
3. **In-process turn state** (e.g. `_handoff_called_this_turn`) — Cursor needs
   hook `postToolUse` + file marker or backend inference (as planned for Claude).

---

## 7. Runtime parity matrix

| Orchestra requirement | pi | Hermes | Claude (plan) | Cursor Agent |
|----------------------|-----|--------|---------------|--------------|
| PTY + xterm | ✅ | ✅ | ✅ | ⚠️ Spike required |
| Structured handoff | `@@HANDOFF` text | same `@@HANDOFF` text | same `@@HANDOFF` text (plan) | `@@HANDOFF` text or MCP tool |
| Per-turn appendix | pi extension | `pre_llm_call` | `UserPromptSubmit` hook | ⚠️ `beforeSubmitPrompt` — undocumented for injection |
| Ready signal | session_start | `on_session_start` | `SessionStart` | `sessionStart` |
| Turn-end watchdog | extension | `post_llm_call` | `Stop` | `stop` |
| Parallel multi-node | ✅ | ✅ | ✅ | ✅ (separate sessions) |
| Unattended pipeline | ✅ | ✅ | `--allowedTools` | `--force` + `--approve-mcps` |

**Verdict:** Cursor is integratable at ~80% functional parity **if** the PTY
spike and appendix injection spike succeed. Without per-turn appendix, nodes
lose orchestration context on every turn unless baked into the system prompt once
(stale edges, missed recipient updates).

---

## 8. Known problems and risks

### 8.1 Critical gaps

| # | Problem | Impact | Possible mitigation |
|---|---------|--------|---------------------|
| P1 | **No per-turn `orchestra-context` injection** | Agents miss updated graph state, edge permissions, recipient handles | Spike `beforeSubmitPrompt` → `additional_context`; fallback: re-inject via system prompt each spawn only (stale) |
| P2 | **No in-process `register_tool`** | Handoff only via MCP; extra process, approval UX | Stdio MCP server (same as Claude plan); `--approve-mcps` for pipelines |
| P3 | **PTY + TUI compatibility unproven** | xterm resize, ANSI, inject may break | Dedicated spike before any production code |
| P4 | **Hook isolation across N nodes on same cwd** | Shared `.cursor/hooks.json` may cross-contaminate sessions | Per-node generated hooks dir or env-gated scripts reading `PINODES_ORCHESTRA_NODE` |

### 8.2 Operational risks

| # | Problem | Impact | Mitigation |
|---|---------|--------|------------|
| O1 | **MCP approval prompts** in interactive TUI | Blocks unattended handoff | `--approve-mcps` + documented trust model |
| O2 | **Cursor CLI versioning** | Breaking flag/hook behaviour between releases | Pin tested version in docs; CI smoke on `agent --version` |
| O3 | **Auth** (`agent login`, API keys) | Headless nodes need credentials on backend host | Document `CURSOR_API_KEY` / login per machine |
| O4 | **Duplicate effort vs Claude Code** | Two similar MCP+hook integrations to maintain | Implement Claude first; factor shared `orchestra` MCP package |

### 8.3 Strategic / product risks

| # | Problem | Notes |
|---|---------|-------|
| S1 | **pi-as-proxy already works** | Native Cursor runtime adds maintenance for marginal UX (badge, spawn args) |
| S2 | **Cursor as host ≠ Cursor as runtime** | Users may expect IDE integration when they mean agent CLI |
| S3 | **SDK path tempts non-PTY UI** | Scope creep away from Orchestra differentiator (live terminals) |

---

## 9. Recommended sequencing

| Priority | Action | Rationale |
|----------|--------|-----------|
| **Now** | Use **pi nodes** with Cursor provider (`pi --cursor` / MCP) | Zero code; `@@HANDOFF` works |
| **Next native runtime** | **Claude Code** per [CLAUDE_CODE_RUNTIME_PLAN.md](./CLAUDE_CODE_RUNTIME_PLAN.md) | MCP + documented lifecycle hooks |
| **If revisiting Cursor** | Run **3-day spike** (§10) before `CursorRuntime.ts` | Validate or kill P1–P3 cheaply |
| **Defer** | `runtime: "cursor"` production implementation | Cost/benefit unfavourable today |

---

## 10. Spike checklist (if revived)

Execute in order; any failure is a stop signal unless a documented fallback exists.

1. **PTY smoke** — spawn `agent` (no `--print`) in `node-pty`, attach xterm,
   verify resize + user inject + ANSI rendering.
2. **Headless handoff** — MCP `orchestra_handoff` → `POST /internal/call-agent`
   with `--print --trust --force --approve-mcps`.
3. **Appendix injection** — hook on `beforeSubmitPrompt` (or alternative) returns
   content from `GET /internal/orchestra-context`; confirm it appears in the
   model's context on turn 2+.
4. **Multi-node isolation** — two `agent` sessions same cwd, distinct
   `PINODES_ORCHESTRA_NODE` values; no cross-talk in hooks/MCP.
5. **Watchdog** — `stop` hook → `POST /internal/turn-ended`; backend nudge when
   no handoff emitted.

**Estimated effort if spike passes:** 1–2 weeks for `CursorRuntime` + shared MCP
package (reused from Claude), tests mirroring `HermesRuntime.test.ts`.

---

## 11. Files that would be touched (future implementation)

```
backend/src/pty/runtime/
  CursorRuntime.ts          (new)
  CursorRuntime.test.ts     (new)
cursor-mcp/orchestra/       (new — likely shared with claude-mcp/)
  server.ts
cursor-hooks/
  orchestra.hooks.json      (new — or generated at spawn)
backend/src/pty/PtyHub.ts   — runtime branch + feature flag
backend/src/types.ts        — WorkflowNode.runtime: add "cursor"
ARCHITECTURE.md             — runtime table
docs/README.md              — status row
```

Feature flag sketch: `PINODES_ORCHESTRA_CURSOR=true` (mirror Hermes pattern).

---

## 12. Conclusion

- **Orchestra + Cursor as IDE host:** shipped and sufficient for daily use.
- **Orchestra + Cursor Agent as node runtime:** feasible via approach B
  (PTY + MCP + hooks), not trivial.
- **Cursor CLI (`agent`):** has hooks, MCP, sessions, headless mode — enough
  surface to integrate **similar to** pi/Hermes, but **without** Hermes-grade
  in-process tools or confirmed per-turn context injection.
- **Practical recommendation:** stay on pi-as-proxy for Cursor models; ship
  Claude Code as the next native runtime; keep this analysis for a future spike
  if Cursor closes the appendix gap or Orchestra needs Cursor-branded nodes for
  product reasons.

---

## References

- [EXTENSIONS_ROADMAP.md](../roadmaps/EXTENSIONS_ROADMAP.md) — Cursor agent section
- [CLAUDE_CODE_RUNTIME_PLAN.md](./CLAUDE_CODE_RUNTIME_PLAN.md) — preferred next runtime
- [HERMES_RUNTIME.md](../guides/HERMES_RUNTIME.md) — shipped reference
- [ARCHITECTURE.md](../../ARCHITECTURE.md) — handoff contract
- Cursor Agent CLI: `agent --help`, `agent mcp --help`
- Cursor hooks: `~/.cursor/hooks.json`, Cursor docs (Agent hooks)
