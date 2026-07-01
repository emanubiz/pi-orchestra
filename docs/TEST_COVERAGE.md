# Test Coverage — gap review (2026-07-01)

Snapshot review of unit-test coverage across `backend`, `frontend` and
`vscode-extension`. No coverage tool is wired up (no `@vitest/coverage-v8` in
any workspace), so this is a manual source-vs-test audit, not a report from a
tool. Verified against `feat/multi-runtime`.

## What was added

| Area | File | Added | Why |
|------|------|-------|-----|
| DB persistence | `backend/src/db/index.test.ts` | CRUD + builtin-delete-guard for `system_prompts`; CRUD + upsert-by-id for `workflows`; re-seed idempotency | Only the `boards` table had tests; the other two tables (and the legacy-column migration path) had none |
| `pi` command resolution | `backend/src/pty/runtime/PiRuntime.test.ts` (`resolvePiCommand` describe) | Bundled `node_modules` cli.js found; PATH-fallback binary; Windows `.cmd`/`.bat` shim rewritten to its underlying `cli.js`; shim used as-is when the rewrite target is missing; "not found" error + fallback | This is the most platform-fragile code in the runtime layer (the Windows shim rewrite exists specifically to avoid silently dropping `--extension`) and had no branch coverage — the existing tests always resolved via the first candidate |
| PATH search | `backend/src/pty/runtime/findInPath.test.ts` (new) | Multi-dir search, multi-name-per-dir, first-match-wins, non-file skip, not-found, empty `PATH` | `findInPath` was only exercised through mocks in the runtime tests, never against its own loop logic |
| Kanban store | `frontend/src/stores/kanbanStore.test.ts` (new) | `normalizeColumn` alias table, card CRUD, `moveCardByBoard` candidate selection (most-recent non-done, done-only fallback, no-match no-op), persisted-state `migrate` (v1 legacy columns → v2) | Zero tests despite non-trivial free-text parsing and a persisted-state migration — the kind of code that silently corrupts a user's local data on upgrade if it regresses |
| Board store | `frontend/src/stores/boardStore.test.ts` (new) | `setDefaultCwd` placeholder upgrade (incl. preserving a user-renamed label), `bindWorkspace` reuse-by-cwd, `addBoard`/`removeBoard` (last-board guard, active-board reassignment), `updateActiveBoard`/`updateBoardSnapshot`, rehydration fallback | Same as above — zero tests on a store with real branching logic |
| WebSocket dispatch | `frontend/src/hooks/useOrchestraWs.test.ts` (new) | Connect/reconnect/unmount lifecycle, `node_status` validation + error chat line, stream buffer flush, `pty_output`/`pty_size`/`node_ready`/`pty_exit` → `ptyBus`, `card_status` → kanban store, `message_in` chat kind, board-scoping, `send()` gating on `OPEN` | This hook is the single dispatcher for every backend→frontend event (13-case switch) and had no tests at all |

Result: 172 → 194 backend tests, 39 → 78 frontend tests (extension unchanged
at 14). Full command output: `npm test --workspaces --if-present`.

## Known gaps not addressed here

Left out of this pass — larger effort per fix, lower risk, or better suited
to component/integration tests than unit tests:

- `frontend/src/App.tsx` (~500 loc) and most presentational components
  (`KanbanBoard`, `NodeInspector`, `PromptLibrary`, `SystemPromptModal`,
  `TerminalOverlay`, `TerminalPanel`, `BoardTabs`, `WorkflowPicker`) have no
  tests.
- `backend/src/cli.ts` (~440 loc, packaged CLI entry point) is untested.
- `vscode-extension/src/backend.ts` (`BackendManager`: subprocess spawn,
  health-check retry loop, port/`pi` resolution, legacy-DB migration) has no
  tests, unlike the small pure-function helpers (`port.ts`, `sessionToken.ts`,
  `workspaceDataDir.ts`) it depends on.
- No coverage tool is installed in any workspace, so gaps like these aren't
  visible in CI. Adding `@vitest/coverage-v8` (backend + frontend) and the
  vitest coverage equivalent for `vscode-extension` would surface this
  automatically going forward.
