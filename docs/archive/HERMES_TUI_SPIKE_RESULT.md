# Hermes TUI Runtime — Spike Result (Phase -1)

> **Date:** 2026-06-29  
> **Hermes:** v0.17.0 (2026.6.19), Python 3.11.15, project `~/.hermes/hermes-agent`  
> **Outcome:** ✅ **GATE PASSED** — both checks hold. Phases 3+ proceed as written in the plan. No fallback needed.

The spike had to confirm 2 points live (architecture was already decided).  
**Result:** both confirmed, and the full plugin/hook system was validated from Hermes source and an existing production plugin (`orca-status`) — effectively the working analogue of the `orchestra` plugin.

---

## 1. Does `HERMES_EPHEMERAL_SYSTEM_PROMPT` persist across all turns? → ✅ YES

**Verified from source (stronger than a black-box test):**

- The env var exists and is first-class: `hermes_cli/config.py:4072` describes it as *"Ephemeral system prompt injected at **API-call time** (never persisted to sessions)"*.
- Read **per process** at startup (`cli.py:3659`, `gateway/run.py:4303` → `self._ephemeral_system_prompt`), then **injected on every LLM call** (`gateway/run.py:16143-16403`, per-turn path → `ephemeral_system_prompt=combined_ephemeral`).

**Consequence for Orchestra:**

- **Isolated per node** (env of the `hermes --tui` process, like pi's `--system-prompt`). ✅
- **Holds across all turns** (injected on every API call, never persisted in history). ✅
- ⇒ **Plan risk #1 is eliminated.** The fallback "role via `pre_llm_call` every turn" is **not needed** for the system prompt. (`pre_llm_call` remains for the context appendix.)

---

## 2. Is bracketed-paste reliable in `hermes --tui`? → ✅ YES

**Verified live** with a `node-pty` harness (same mechanism as PtyHub): spawn `hermes --tui`, settle ~1.5s for Ink TUI mount, then `\x1b[200~<msg>\x1b[201~` followed (after 250ms) by `\r`.

- Model: `deepseek-v4-flash-free` (free tier — no paid quota consumed).
- Outcome: the agent **received the pasted message and replied** (`PONG`), process exited with code 0. `pasted=true sawPong=true`.
- ⇒ Task/nudge injection via PTY works like pi. Same pattern (paste + settle + submit `\r`) → reusable in `HermesRuntime.inject`.

---

## 3. Plugin/hook system — validated (source + production plugin)

**Plugin structure** (`hermes_cli/plugins.py` docstring):

- Directory in `~/.hermes/plugins/<name>/` with `plugin.yaml` + `__init__.py` exposing `register(ctx)`.
- Hooks: `ctx.register_hook(hook_name, callback)`.
- Custom tools: `ctx.register_tool(name, toolset, schema, handler, check_fn=, requires_env=, is_async=, description=, emoji=, override=)` → registered globally alongside built-in tools.

**`VALID_HOOKS`** (`hermes_cli/plugins.py:128`) includes all we need: `on_session_start`, `pre_llm_call`, `post_llm_call` (plus `pre/post_tool_call`, `on_session_end`, `subagent_start/stop`, etc.).

**Hook contracts (exact signatures from source):**

| Hook | Invoked in | kwargs received | Return |
|---|---|---|---|
| `on_session_start` | `run_agent.py` | `session_id`, `model`, `platform`, … | — (side-effect: POST `/internal/ready`) |
| `pre_llm_call` | `agent/turn_context.py:415` | `session_id`, `task_id`, `turn_id`, `user_message`, `conversation_history`, `is_first_turn`, `model`, `platform`, `sender_id` | **`{"context": "<text>"}` or `str`** → **appended to that turn's user message** (not system prompt) |
| `post_llm_call` | `agent/turn_finalizer.py:350` | `session_id`, `task_id`, `turn_id`, `user_message`, `assistant_response`, `conversation_history`, `model`, `platform` | — (side-effect: POST `/internal/turn-ended`) |

⇒ The pi→Hermes mapping in the plan is **letter-accurate**, including the `{"context": ...}` return from `pre_llm_call`.

**Isolation/gating — proven by `orca-status`** (user plugin already installed at `~/.hermes/plugins/orca-status/`): working analogue of the `orchestra` plugin. Registers `on_session_start`/`pre_llm_call`/`post_llm_call` and **POSTs to a local HTTP server** (`http://127.0.0.1:{port}/hook/hermes`) reading env vars. Gating via **early-return no-op when required env vars are missing** (`port`/`token`/`paneKey`). ⇒ The `orchestra` plugin will do the same: **no-op when `PINODES_ORCHESTRA_NODE` is absent**, without disturbing normal Hermes use (`requires_env` in manifest is an additional gate).

---

## 4. Bonus findings (useful for Phase 3)

- **`ctx.inject_message(content, role)`** exists (`plugins.py:411`): could push watchdog nudge **directly from the plugin**, without PTY. **But** explicit caveat: *"no CLI reference (not available in gateway mode)"*. Since `hermes --tui` starts an in-process gateway, verify whether `_cli_ref` is set in TUI. → **PTY nudge (plan) remains the robust path**; consider `inject_message` as a Phase 3 optimization.
- **`handoffCalledThisTurn`** can be computed plugin-side: track with a module-level flag (keyed by `task_id`/`session_id`, like `disk-cleanup` does) whether `orchestra_handoff` fired in the current turn; `post_llm_call` receives `conversation_history` + `assistant_response` for fallback.
- **Configured model:** `deepseek-v4-flash-free` (free) + Nous Portal logged in → usable for Phase 5 E2E tests at no cost.

---

## Gate

✅ **Both points hold.** No fallback activated. Phases 0–1–2 (runtime-agnostic refactor) and Phase 3 (HermesRuntime + `orchestra` plugin) proceed as planned.  
Only plan update: the fallback "system prompt via `pre_llm_call`" is **unnecessary** (env var holds across turns) — `pre_llm_call` is only for the context appendix.

### Source references (Hermes v0.17.0)

- `hermes_cli/config.py:4072` · `cli.py:3659` · `gateway/run.py:4303,16143,16403` — ephemeral system prompt
- `hermes_cli/plugins.py:128` (`VALID_HOOKS`), `:315` (`PluginContext`), `:367` (`register_tool`), `:411` (`inject_message`), `:1044` (`register_hook`)
- `agent/turn_context.py:415` (`pre_llm_call`) · `agent/turn_finalizer.py:350` (`post_llm_call`) · `run_agent.py:591` (`on_session_start`)
- Any existing enabled Hermes plugin under `~/.hermes/plugins/` can serve as a reference for the lifecycle-hook → HTTP POST + env-gating pattern.
