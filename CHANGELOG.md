# Changelog - v0.2.23

> **Note:** The authoritative changelog lives in [`vscode-extension/CHANGELOG.md`](vscode-extension/CHANGELOG.md) (the published artifact for the marketplace). This file mirrors the release notes for the monorepo as a whole — code, docs, and CI — and is updated when a release is cut.

## [0.2.23] - Unreleased

### Added
- **Hermes Control Plane plan** (`docs/plans/HERMES_CONTROL_PLANE_PLAN.md`): consolidated active plan for letting Hermes control pinodes-orchestra through MCP tools first, with the Hermes Desktop tab as a thin iframe/webview host later. Supersedes the separate Hermes Desktop H2 plan.

### Changed
- **Documentation refreshed to the three-runtime reality.** `ARCHITECTURE.md` ASCII diagram now shows ClaudeRuntime alongside PiRuntime and HermesRuntime. `PROGRAMMATIC_API.md` `/api/health` and `/api/info` examples include `runtimes: { hermes, claude }`; the `runtimeConfig.toolset` table lists all three runtimes; `WorkflowNode` interface shows `"claude"` in the union. `HERMES_RUNTIME.md` comparison table gained a Claude Code column with spawn args, hooks, and watchdog details.
- **`README.md` config table** now lists `PINODES_ORCHESTRA_CLAUDE` (auto-detect override, same pattern as `PINODES_ORCHESTRA_HERMES`).
- **Documentation decluttered:** shipped/deferred feasibility docs moved to `docs/archive/`; `docs/plans/` now contains only the active Hermes control-plane plan. Cursor native runtime and Zero runtime are retained as archived analyses, not active plans.
- **`docs/guides/HERMES_DESKTOP.md`** shortened into an operator/positioning guide that points to the consolidated control-plane plan instead of duplicating implementation detail.
- **`docs/roadmaps/EXTENSIONS_ROADMAP.md`** rewritten as a high-level sequencing roadmap: MCP control-plane first, Desktop tab second, OpenClaw/mobile/physical later; native Cursor/Zero runtimes deferred/rejected.
- **`PRE_MERGE_TEST_CHECKLIST.md`** unbranded from `feat/multi-runtime` (now `main` branch), removed the manual `export PINODES_ORCHESTRA_HERMES=true` instruction (auto-detect is the default).
- **Backend version** at `/api/health` and `/api/info` now reads from `backend/package.json` at boot instead of a hardcoded `"0.1.0"` string.

## [0.2.22] - 2026-07-02

### Changed
- **Kanban column constants centralized.** Column definitions, alias maps, and migration rules now live in a single source of truth (`frontend/src/constants/kanban.ts`): `KanbanColumnId`, `KANBAN_COLUMNS`, `COLUMN_ALIASES`, `COLUMN_MIGRATION_MAP`, and `isValidColumn()` are exported from one place. `kanbanStore.ts` imports and re-exports them; `normalizeColumn()` and the localStorage `migrate()` function now derive from the shared constants instead of maintaining separate inline maps. `PtyHub.kanbanAppendix()` has a sync comment so backend prompt strings stay aligned with the frontend definitions.
- **Dead `_edges` parameter removed from `useOrchestraWs`.** The unused `boardEdges` argument (and the corresponding `useMemo` in `App.tsx`) was dropped. The timeline now derives handoffs exclusively from the canonical backend `handoff` event.
- **Dead code cleanup.** Removed `backend/pty-repro.mjs` (standalone node-pty reproduction script, unused and not part of the build).

## [0.2.21] - 2026-07-02

### Added
- **Claude Code runtime (third node runtime).** `ClaudeRuntime` joins `pi` and `hermes` as a first-class backend runtime. It reuses the existing PTY bridge, parses output through the `@@HANDOFF` / `@@CARD` / `@@DONE` text sentinels, and bridges lifecycle events into `/internal/turn-started` / `/internal/turn-ended` via `backend/claude-hooks/orchestra-hook.mjs`. `runtimeConfig.toolset` is now read for all three runtimes and translated to Claude's own tool vocabulary.
- **Claude availability probe** (`backend/src/pty/runtime/claudeAvailability.ts`) — surfaces the runtime as `available` / `unavailable` based on a real probe of the `claude` CLI on `PATH`; the frontend disables it cleanly when missing.
- **Per-runtime Claude settings resolver** (`backend/src/pty/runtime/resolveClaudeSettings.ts`) — env, model and per-board overrides merged with a documented precedence.
- **Zero-runtime analysis** (`docs/archive/ZERO_RUNTIME_ANALYSIS.md`) — feasibility study now archived; the PTY runtime path is not viable today.
- **Documentation**: `docs/guides/CLAUDE_RUNTIME.md`, runtime table in `ARCHITECTURE.md` and `docs/README.md`, roadmap entry in `docs/roadmaps/EXTENSIONS_ROADMAP.md`.
- **Tests**: `backend/src/pty/runtime/ClaudeRuntime.test.ts` (222 lines), `claudeAvailability.test.ts` (47 lines), `backend/claude-hooks/orchestra-hook.test.mjs` (200 lines), extra `PtyHub.test.ts` cases for Claude spawn + availability fallback + server-side nudge, and `RuntimeSelector.test.tsx` updates.

### Changed
- **Frontend runtime selector** now renders all three runtimes inline on node cards (`RuntimeSelector.tsx`, `RuntimeBadge.tsx`, `AddAgentModal.tsx`, `useOrchestraWs.ts`, `stores/runtimeStore.ts`).
- **Type model extended to `"claude"`** across `backend/src/types.ts`, `backend/src/routes/orchestra.ts`, `backend/src/ws/handler.ts`, and `frontend/src/types.ts`. `claudeAvailability` is passed through WS and REST status payloads.
- **`docs/guides/PROGRAMMATIC_API.md`**, **`docs/archive/CLAUDE_CODE_RUNTIME_PLAN.md`** (now marked shipped), **`docs/guides/HERMES_RUNTIME.md`**, **README + `docs/README.md`** updated for the three-runtime reality.
- **CI: VSIX publish workflow is now idempotent and per-platform resilient** (`.github/workflows/publish-extension.yml`).
- **`vscode-extension/scripts/bundle.mjs`** — copies `backend/claude-hooks/` into the bundled extension output so Claude's `--settings` hook path resolves identically in dev, dist, and the published VSIX.
