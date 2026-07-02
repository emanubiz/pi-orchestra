# Changelog - v0.3.0

> **Note:** The authoritative changelog lives in [`vscode-extension/CHANGELOG.md`](vscode-extension/CHANGELOG.md) (the published artifact for the marketplace). This file mirrors the release notes for the monorepo as a whole — code, docs, and CI — and is updated when a release is cut.

## [0.3.0] - 2026-07-02

### Added
- **Codex structured runtime (fourth node runtime).** `CodexRuntime` runs headless via `codex exec --json` (one turn per inject) with thread resume, synthesized terminal output, and the same `@@HANDOFF` / `@@CARD` / `@@DONE` sentinel protocol as the PTY runtimes. Auto-detected from the `codex` CLI on the backend PATH; **no fallback to pi** when unavailable. New modules: `CodexRuntime.ts`, `codexEventFormat.ts`, `codexAvailability.ts`, shared `orchestra/sentinels.ts`.
- **MCP control plane (`mcp-server/` workspace).** New stdio MCP server (`pinodes-orchestra-mcp`) exposes Orchestra REST operations to Hermes and other MCP hosts: health/info, board CRUD, graph read/write, run/stop/inject/status, and safe UI deep links. Local safety layer: `PINODES_ORCHESTRA_ALLOWED_ROOTS`, `PINODES_ORCHESTRA_MCP_MODE=safe`, JSONL audit logging for mutative tools.
- **Workflow templates.** Built-in multi-agent graph templates (docs cleanup, feature dev, research, content) selectable from the empty-state gallery and `WorkflowPicker`.
- **Smoke tooling for Codex.** `scripts/codex`, `scripts/codex-smoke.mjs`, `scripts/mock-codex.mjs` for local verification.
- **Documentation:** `docs/guides/CODEX_RUNTIME.md`, `docs/guides/HERMES_CONTROL_PLANE.md`, active plan `docs/plans/HERMES_CONTROL_PLANE_PLAN.md`.
- **Tests:** `CodexRuntime.test.ts`, `codexEventFormat.test.ts`, `codexAvailability.test.ts`, `sentinels.test.ts`, MCP server test suite (`mcp-server/test/*`).

### Changed
- **`INodeRuntime` generalized** with `kind: "pty" | "structured"`; PTY family (`pi`, `hermes`, `claude`) vs structured (`codex`) documented in `ARCHITECTURE.md`.
- **Frontend runtime selector** extended to four runtimes (`RuntimeSelector`, `RuntimeBadge`, `AddAgentModal`, `runtimeStore`, `runtimeKind` helpers). Codex nodes disable keyboard input; side panel shows structured-runtime hint.
- **Type model** extended to `"codex"` across backend types/routes/WS and frontend types. `/api/health` and `/api/info` report `runtimes.codex`.
- **Documentation refreshed to four-runtime reality:** `ARCHITECTURE.md`, `README.md`, `docs/README.md`, `PROGRAMMATIC_API.md`, runtime guides, roadmap (`EXTENSIONS_ROADMAP.md` — MCP first, Desktop tab second). Shipped/deferred plans moved to `docs/archive/`.
- **`HERMES_DESKTOP.md`** shortened to operator/positioning guide pointing at the control-plane plan.
- **`PRE_MERGE_TEST_CHECKLIST.md`** unbranded; Hermes auto-detect is default.
- **Backend version** at `/api/health` and `/api/info` reads from `backend/package.json` at boot.
- **Monorepo version** aligned to `0.3.0` across root, backend, frontend, extension, and `mcp-server`.

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
