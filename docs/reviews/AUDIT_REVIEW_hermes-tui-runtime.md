# Audit Review — `feat/multi-runtime` vs `main`

> **Original date:** 2026-06-29 (branch `feat/hermes-tui-runtime`)  
> **Updated:** 2026-07-01 (merged into `feat/multi-runtime`, commit `eb7d17d`)  
> **Updated again:** 2026-07-01 — 6/7 issues resolved (toolset override, HTTP timeout + logging, watchdog extracted to `PtyHub.handleTurnEnded` + real tests)  
> **Closed:** 2026-07-01 — 7/7. #6 documented in README.md ("Hermes runtime nodes")  
> **Extended test coverage:** 2026-07-01 — code-coverage review on this branch: +61 tests on remaining gaps (`system_prompts`/`workflows` persistence, `pi`/Windows shim resolution, frontend `kanban`/`board` stores, `useOrchestraWs` hook). Details in `docs/guides/TEST_COVERAGE.md`.  
> **Purpose:** Make PtyHub runtime-agnostic by adding `hermes --tui` as an alternative to `pi` for orchestra nodes.  
> **Pipeline verification:** Typecheck backend/frontend/extension ✅ · 286 tests (194 backend + 78 frontend + 14 extension) ✅ · Build ✅

---

## Summary table

| # | Issue | Severity | File | Status |
|---|-------|----------|------|--------|
| 1 | `runtimeConfig` never used by runtimes | 🟠 High | `HermesRuntime.ts`, `PiRuntime.ts` | **Resolved** — `runtimeConfig.toolset` read by both via `resolveToolset.ts` |
| 2 | Plugin not auto-installed | 🟠 High | `HermesRuntime.ts`, docs | **Mitigated** — `setup-hermes-plugin.sh` added |
| 3 | HTTP without timeout in plugin | 🟡 Medium | `__init__.py` | **Resolved** — `timeout=5` on both `urlopen` calls, `except: pass` → `log.warning` |
| 4 | `onReady` dead code | 🟡 Low | `INodeRuntime.ts` | **Resolved** — removed in `4e478d7` |
| 5 | Tautological watchdog tests | 🟡 Medium | `PtyHub.test.ts` | **Resolved** — logic extracted to `PtyHub.handleTurnEnded` (testable without Fastify), tests rewritten with real retry/nudge/cap asserts |
| 6 | `pre_llm_call` context → user msg vs system prompt | 🟡 Low | `__init__.py` | **Resolved (doc)** — explained in README.md § Hermes runtime nodes, verified against `agent/turn_context.py` in `HERMES_TUI_SPIKE_RESULT.md` |
| 7 | `ctx` shadowed | 🟢 Trivial | `__init__.py` | **Resolved** — `orchestra_ctx` in `eb7d17d` |

---

## Scoreboard

| Dimension | Score | Notes |
|-----------|-------|-------|
| **Architecture** | 9.5/10 | Clean refactor, excellent separation, correct Strategy pattern; watchdog now lives in PtyHub instead of a route handler |
| **Code Quality** | 9/10 | Solid code, dead code removed, configurable toolset, plugin resilient to slow/unreachable backend |
| **Testing** | 9/10 | Excellent coverage; watchdog path now has real asserts on retry count, nudge content, and error broadcast at cap |
| **Security** | 8/10 | Toolset validated by type before argv; HTTP with timeout |
| **Doc↔Code Coherence** | 9.5/10 | Docs updated (ARCHITECTURE, PROGRAMMATIC_API, README); no known remaining gaps |

**Overall: 9.5/10** — Structurally excellent refactor, **7/7 issues closed** (6 with code fixes, 1 with documentation — #6 was expected behavior difference, not a defect). No known open issues. Ready for merge and manual testing.

---

## Branch architecture

The branch introduces a structural refactor in 6 phases (Phase 0–6):

| Phase | Commit | Content |
|------|--------|-----------|
| 0 | `15abfc7` | Data model: `NodeRuntime` type + `runtime`/`runtimeConfig` on `WorkflowNode` |
| 1 | `45bb2f9` | PtyHub protection tests (409 new test lines **before** refactor) |
| 2 | `dbea545` | Extract: `INodeRuntime` interface + `PiRuntime` from PtyHub |
| 3 | `053e260` | `HermesRuntime` + `PtyRuntime` base class + feature flag |
| 4 | `2e4790b` | Hermes `orchestra` plugin + `/internal/turn-ended` endpoint + runtime UI |
| 5–6 | `00eda72` | E2E tests + docs update |
| cleanup | `4e478d7` | Drop dead `onReady` hook, unused imports, align docs |
| prep | `eb7d17d` | Smoke test, setup script, checklist, review fix (ctx shadowing) |

### Architectural flow

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

### Introduced file structure

```
backend/src/pty/runtime/
├── INodeRuntime.ts       # Interface: spawn, write, inject, resize, kill, markReady, isRunning, isReady, size
├── PtyRuntime.ts         # Abstract base with shared PTY logic
├── PiRuntime.ts          # Concrete: spawn pi CLI with --tools, --system-prompt, --extension
├── HermesRuntime.ts      # Concrete: spawn hermes --tui with --toolsets, HERMES_EPHEMERAL_SYSTEM_PROMPT
├── findInPath.ts         # Utility: find executable on PATH (extracted from PtyHub)
├── PiRuntime.test.ts     # 335 lines, 14 tests
└── HermesRuntime.test.ts # 265 lines, 12 tests

backend/hermes-plugins/orchestra/
├── __init__.py           # Hermes plugin: lifecycle hooks + handoff/card tool
└── plugin.yaml           # Manifest with requires_env

scripts/
├── smoke.mjs             # REST API sanity check (one command)
└── setup-hermes-plugin.sh # Idempotent symlink plugin → ~/.hermes/plugins/

docs/
└── checklists/PRE_MERGE_TEST_CHECKLIST.md  # Manual checklist with expected results
```

---

## Strengths (with evidence)

### 1. Strategy-pattern refactor with TDD methodology

Protection tests (Phase 1) were written **before** the refactor (Phase 2), following classic characterization tests. The `PtyHub.ts` diff shows a clean removal of ~200 lines of pi-specific logic moved to `PiRuntime`/`PtyRuntime`.

### 2. Perfect backward compatibility

`runtime` is optional on `WorkflowNode`, absent = `"pi"`. No DB migration required — the field is optional in serialized JSON.

### 3. Feature flag evaluated at spawn time

`PINODES_ORCHESTRA_HERMES === "true"` is read in `PtyHub.spawn()`, not at module load. Tests toggle it in `beforeEach`/`afterEach` and work correctly.

### 4. O(1) ring-buffer scrollback

The buffer uses `chunks: string[]` with `shift()` and partial `slice()` — O(1) per chunk instead of O(n) for legacy concat+slice. Oracle test verifies identical results to the naive version under heavy load (500+ chunks).

---

## Resolved issues

### ✅ 1. `runtimeConfig` was accepted, passed to `spawn()`, but never used

**Fix:** new shared helper `backend/src/pty/runtime/resolveToolset.ts`, imported by both runtimes. Reads `runtimeConfig.toolset` — a non-empty string replaces the hardcoded default `"read,bash,edit,write,grep"`; any other type (or absent/blank value) is silently ignored so arbitrary JSON never reaches argv without validation. Covered by 4 new tests (2 per runtime: override + fallback). Documented in `docs/guides/PROGRAMMATIC_API.md`.

### ✅ 2. Python plugin: HTTP without timeout, silent errors

**Fix:** `timeout=5` added to both `urllib.request.urlopen` calls (`_post`/`_get`) — a stuck backend can no longer block a Hermes agent turn indefinitely. The three `except Exception: pass` blocks in hooks (`on_session_start`, `pre_llm_call`, `post_llm_call`) now log with `log.warning(...)` instead of failing silently — still fail-open (no re-raise), but no longer mute.

### ✅ 3. Watchdog tests did not actually test the watchdog

The original review suggestion (`app.inject(...)` on Fastify) is impractical without restructuring `index.ts`, which is a top-level script (`await app.register(...)` at module level, unconditional `app.listen()`) — importing it in a test would start a real listener.

**Applied fix, different and lower risk:** watchdog logic (retry counter, nudge threshold, error report at cap) was **extracted from the route** into a new public method `PtyHub.handleTurnEnded(boardId, nodeId, handoffCalledThisTurn)` — consistent with existing `PtyHub` style (same pattern as `notify()`/`injectTask()`, private state in a `Map` like `ready`/`pending`/`enforceOverride`). The `/internal/turn-ended` route in `index.ts` is now a one-line delegator. The two weak tests were rewritten to call `hub.handleTurnEnded(...)` directly and assert: retry count increments, exact nudge text injected into PTY ("Attempt N/3", target handle), `node_status: error` broadcast at cap, **and** counter reset on successful handoff — none verified before.

### ✅ 4. `pre_llm_call` appends context to user message, not system prompt

Not a defect — correct verified Hermes hook behavior (`agent/turn_context.py`, see `HERMES_TUI_SPIKE_RESULT.md § 3`): `pre_llm_call` has no equivalent of pi's `before_agent_start` that rewrites the system prompt, so per-turn context (recipients, finality, kanban) is appended to the turn's user message instead of the system prompt. Functionally equivalent for the model (context is still present every turn, never persisted in history), but the difference in *where* it lands could confuse anyone inspecting raw Hermes session messages expecting pi's mechanism.

**Fix:** documented explicitly in README.md § Hermes runtime nodes, with reference to verified hook contract in `HERMES_TUI_SPIKE_RESULT.md`.

---

## Verdict

The architectural refactor is high quality — methodological TDD, perfect backward compat, clean Strategy pattern, O(1) ring buffer. All 7 audit issues are closed: 6 with code fixes (runtimeConfig now read and validated, HTTP timeout in plugin, watchdog extracted to `PtyHub` and properly tested, dead code, shadowing) and 1 (#6) with documentation, because it was verified expected Hermes behavior, not a bug. No known open issues. Green pipeline (286 tests, tsc ×3, build) — **ready for merge and manual testing**.
