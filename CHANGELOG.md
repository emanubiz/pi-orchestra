# Changelog - v0.2.22

> **Note:** The authoritative changelog lives in [`vscode-extension/CHANGELOG.md`](vscode-extension/CHANGELOG.md) (the published artifact for the marketplace). This file mirrors the release notes for the monorepo as a whole — code, docs, and CI — and is updated when a release is cut.

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
- **Zero-runtime analysis** (`docs/plans/ZERO_RUNTIME_ANALYSIS.md`) — design for a lightweight, local-only node that runs a pre-bundled prompt graph without a TUI, mapped against the existing `NodeRuntime` interface.
- **Documentation**: `docs/guides/CLAUDE_RUNTIME.md`, runtime table in `ARCHITECTURE.md` and `docs/README.md`, roadmap entry in `docs/roadmaps/EXTENSIONS_ROADMAP.md`.
- **Tests**: `backend/src/pty/runtime/ClaudeRuntime.test.ts` (222 lines), `claudeAvailability.test.ts` (47 lines), `backend/claude-hooks/orchestra-hook.test.mjs` (200 lines), extra `PtyHub.test.ts` cases for Claude spawn + availability fallback + server-side nudge, and `RuntimeSelector.test.tsx` updates.

### Changed
- **Frontend runtime selector** now renders all three runtimes inline on node cards (`RuntimeSelector.tsx`, `RuntimeBadge.tsx`, `AddAgentModal.tsx`, `useOrchestraWs.ts`, `stores/runtimeStore.ts`).
- **Type model extended to `"claude"`** across `backend/src/types.ts`, `backend/src/routes/orchestra.ts`, `backend/src/ws/handler.ts`, and `frontend/src/types.ts`. `claudeAvailability` is passed through WS and REST status payloads.
- **`docs/guides/PROGRAMMATIC_API.md`**, **`docs/plans/CLAUDE_CODE_RUNTIME_PLAN.md`** (now marked shipped), **`docs/guides/HERMES_RUNTIME.md`**, **README + `docs/README.md`** updated for the three-runtime reality.
- **CI: VSIX publish workflow is now idempotent and per-platform resilient** (`.github/workflows/publish-extension.yml`).
- **`vscode-extension/scripts/bundle.mjs`** — copies `backend/claude-hooks/` into the bundled extension output so Claude's `--settings` hook path resolves identically in dev, dist, and the published VSIX.
