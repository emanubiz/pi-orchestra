# Changelog

All notable changes to the **PiNodes Orchestra** extension are documented here.

## 0.2.22

### Changed

- **Kanban column constants centralized.** Column definitions, alias maps, and migration rules are now in a single source of truth (`frontend/src/constants/kanban.ts`): `KanbanColumnId`, `KANBAN_COLUMNS`, `COLUMN_ALIASES`, `COLUMN_MIGRATION_MAP`, and `isValidColumn()` are exported from one place. `kanbanStore.ts` imports and re-exports them; `normalizeColumn()` and the localStorage `migrate()` function now derive from the shared constants instead of maintaining separate inline maps. `PtyHub.kanbanAppendix()` has a sync comment so backend prompt strings stay aligned with the frontend definitions.
- **Dead `_edges` parameter removed from `useOrchestraWs`.** The unused `boardEdges` argument (and the corresponding `useMemo` in `App.tsx`) was dropped. The timeline now derives handoffs exclusively from the canonical backend `handoff` event, not from edge inference.
- **Dead code cleanup.** Removed `backend/pty-repro.mjs` (standalone node-pty reproduction script, unused and not part of the build).



## 0.2.21

### Added

- **Claude Code runtime (third node runtime).** A new `ClaudeRuntime` runs as a first-class backend runtime alongside `pi` and `hermes`. It reuses the same PTY bridge, parses output through the existing `@@HANDOFF` / `@@CARD` / `@@DONE` text sentinels (no bespoke JSON-RPC), and bridges lifecycle events into the existing `/internal/turn-started` / `/internal/turn-ended` handoff protocol via `backend/claude-hooks/orchestra-hook.mjs`. `runtimeConfig.toolset` is now read for all three runtimes and translated to Claude's own tool vocabulary, so cards/steps can pin a toolset per node across the whole multi-runtime fleet.
- **Claude availability detection** (`backend/src/pty/runtime/claudeAvailability.ts`) — runtime is marked `available` / `unavailable` based on a real probe of the `claude` CLI on `PATH`, surfaced in `GET /api/v1/orchestra/status` and disabled cleanly in the `RuntimeSelector` when missing.
- **Per-runtime Claude settings resolver** (`backend/src/pty/runtime/resolveClaudeSettings.ts`) — env, model and per-board overrides are merged with a documented precedence.
- **Zero-runtime analysis** (`docs/archive/ZERO_RUNTIME_ANALYSIS.md`) — a feasibility study for a lightweight/local node runtime; archived because the current PTY pattern is not viable for Zero today.
- **Documentation**
  - `docs/guides/CLAUDE_RUNTIME.md` — operator + developer guide for the Claude runtime.
  - `docs/roadmaps/EXTENSIONS_ROADMAP.md` — Claude added as a Tier 1 supported runtime.
  - `ARCHITECTURE.md` and `docs/README.md` — runtime table and diagrams now show all three runtimes.
- **Tests**
  - `backend/src/pty/runtime/ClaudeRuntime.test.ts` (222 lines) — spawn args (system prompt, inline hook settings, permission mode), default + overridden toolset, env contract, PTY options, output/exit streaming, bracketed-paste inject with the slower Ink-TUI submit delay, kill/teardown and `markReady`/`isReady` round-trip.
  - `backend/src/pty/runtime/claudeAvailability.test.ts` (47 lines) — probe behaviour.
  - `backend/claude-hooks/orchestra-hook.test.mjs` (200 lines) — hook payload parsing and turn-started/turn-ended emission across `SessionStart` / `UserPromptSubmit` / `Stop`.
  - `backend/src/pty/PtyHub.test.ts` (extra 55 lines) — Claude spawn arg shape, fallback to pi when the runtime is unavailable, and `handleTurnEnded` server-side nudge contract (same as Hermes).
  - `frontend/src/components/RuntimeSelector.test.tsx` — covers the new Claude option + unavailable state.

### Changed

- **Frontend runtime selector** (`frontend/src/components/RuntimeSelector.tsx`, `RuntimeBadge.tsx`, `AddAgentModal.tsx`, `useOrchestraWs.ts`, `stores/runtimeStore.ts`) — the third runtime is rendered inline on node cards; selecting it pre-fills the right defaults and disables Claude cleanly when `available: false`.
- **Type model extended to `"claude"`.** `backend/src/types.ts`, `backend/src/routes/orchestra.ts`, `backend/src/ws/handler.ts`, `frontend/src/types.ts` — the `Runtime` union now includes `"claude"` and `claudeAvailability` is passed through WS and REST status payloads.
- **`docs/guides/PROGRAMMATIC_API.md`** — examples and the runtime enum updated to include `claude`.
- **`docs/archive/CLAUDE_CODE_RUNTIME_PLAN.md`** — moved from "planned" to "shipped" with a short post-mortem section.
- **`docs/guides/HERMES_RUNTIME.md`** — runtime enum extended to `"pi" | "hermes" | "claude"` and a one-line pointer added to the new `CLAUDE_RUNTIME.md` guide.
- **CI: VSIX publish workflow is now idempotent and per-platform resilient** (`.github/workflows/publish-extension.yml`) — re-runs after a partial failure no longer re-publish stale artifacts, and a single platform failure no longer blocks the others.
- **`vscode-extension/scripts/bundle.mjs`** — now copies `backend/claude-hooks/` into the bundled extension output so Claude's `--settings` hook path resolves identically in dev, dist, and the published VSIX.

## 0.2.20

### Added

- **Programmatic API completion.** `POST /api/v1/orchestra/boards/:boardId/nodes/:nodeId/restart`
  (REST parity with the WS `restart_node` — remote/mobile clients had stop and
  inject but no restart), `runtime` (`"pi" | "hermes"`) on every node in
  `GET …/status`, and CLI `node stop` / `node restart` subcommands.


- **`POST /flows` no longer leaks a board on failure.** When the run step
  failed (e.g. a graph without `entryNodeId` and none provided), the request
  returned 500 and the temporary board it had created persisted forever. It now
  returns 400 and deletes the board.

### Changed

- **API input hardening.** `runtime` is validated against the known set
  (unknown values were silently persisted), `runtimeConfig` must be a plain
  object, `PATCH …/nodes/:nodeId` type-checks `label` / `promptId` / `position`
  / `canBeFinal` like the POST always did, and `waitTimeoutMs` is clamped to
  `[1s, 1h]` so a typo can't make the wait fire instantly or pin the request.
- **README front page** refreshed: multi-runtime tagline, feature summary,
  Open VSX badge. Claude Code runtime plan rewritten (v2) around the shared
  `@@HANDOFF` text protocol.

## 0.2.19

### Added

- **Closed-loop submit confirmation.** After injecting a task (bracketed-paste +
  `\r`), the backend now *verifies* delivery instead of assuming it: both
  runtimes POST `/internal/turn-started` when the agent begins a turn (pi:
  `before_agent_start`; Hermes: `pre_llm_call`, once per turn), which disarms a
  submit watch armed when the `\r` was written. No confirmation within 1.5s →
  the watch re-sends just `\r` (the paste is already in the buffer, never
  duplicated), up to 3 retries, then surfaces a "delivery may be stuck" node
  error. Injects that land while the recipient is mid-turn park their watch
  until the turn ends. This deterministically fixes pipelines silently stalling
  on a paste/submit race. `/internal/turn-ended` is now posted by **both**
  runtimes (busy→idle transition); the server-side handoff nudge stays
  Hermes-only (pi keeps its client-side `enforceIntent`).
- **4 non-coding prompt packs (15 new roles, 29 built-ins total).** Research &
  Analysis (Researcher, Fact-Checker, Analyst, Research Editor), Content &
  Writing (Content Strategist, Writer, Copy Editor, Proofreader & SEO),
  Business & Strategy (Market Analyst, Business Strategist, Financial Modeler,
  Strategy Reviewer), Data & Insights (Data Analyst, Statistician, Report
  Writer). Seeded by UPSERT — existing databases pick them up on next start.

### Changed

- **One handoff standard across runtimes.** Hermes nodes now use the **same**
  `@@HANDOFF … @@END` / `@@CARD` / `@@DONE` text protocol as pi instead of a
  bespoke `orchestra_handoff`/`orchestra_card` tool. The Hermes orchestra plugin
  parses the sentinels out of each turn's output in a `transform_llm_output`
  hook (and strips them from what's shown), so there's a single orchestration
  model to reason about and handoffs no longer depend on the model's
  tool-calling behaving. The `orchestra` toolset is gone from the `hermes chat -t`
  line. This fixes Hermes handoffs silently failing (the tool was being invoked
  with Hermes' `(args_dict, **kwargs)` dispatch convention, which the named-param
  handler couldn't accept — `missing required argument: 'message'`).

### Added

- **Self-sufficient Hermes plugin install.** The orchestra plugin ships inside
  the extension and is copied into `~/.hermes/plugins/orchestra/` and enabled
  (`hermes plugins enable orchestra`) automatically on first Hermes spawn — no
  manual `setup-hermes-plugin.sh`. The app now depends only on the Hermes binary.


- **Hermes nodes no longer fail with "Session not found".** `HermesRuntime` was
  spawning `hermes chat --tui … --resume <boardId-nodeId>`, but `--resume` only
  resumes a session that already exists — on first launch the synthetic id was
  unknown, so Hermes errored out, never reached ready, and injected tasks piled
  up in the queue (the turn looked "stuck"/busy). It now starts a **fresh**
  session per spawn; node identity is carried by the `PINODES_ORCHESTRA_BOARD` /
  `PINODES_ORCHESTRA_NODE` env vars the plugin reads, so nothing is lost.
- **Hermes toolset defaults use Hermes' own vocabulary.** The default was pi's
  `read,bash,edit,write,grep`, which Hermes rejects ("Unknown toolsets"), leaving
  agents without tools. Hermes now defaults to `file,terminal` (`hermes tools
  list` names); pi keeps `read,bash,edit,write,grep`.
- **Hermes orchestration hooks now actually load.** `setup-hermes-plugin.sh` only
  symlinked the plugin, but Hermes ≥0.17 does not load `~/.hermes/plugins/*`
  unless it is in `config.yaml`'s opt-in `plugins.enabled` list — so the
  lifecycle hooks (ready / per-turn context / handoff watchdog) silently never
  fired. The setup script now also runs `hermes plugins enable orchestra`, and
  the plugin manifest declares `kind` + `provides_hooks`.

### Added

- Bundled backend includes **multi-runtime** support: Hermes TUI nodes (`runtime:
  "hermes"`), **auto-detected** when the `hermes` CLI is on the backend PATH
  (`PINODES_ORCHESTRA_HERMES=false`/`true` overrides the auto-detection).
- `/api/info`, `/api/health` and the WebSocket `connected` message expose
  `runtimes.hermes` so the UI can warn when Hermes is selected but not available
  on the backend PATH.
- **Add-agent flow:** **+ Add agent** (toolbar or empty canvas) opens a prompt picker
  (search, read-only preview, custom prompts). Runtime (**pi** / **hermes**) is chosen
  before spawn and locked afterward; read-only badge on node cards.

### Changed

- Documentation reorganized under `docs/` (guides, roadmaps, plans, archive, reviews).
  See [docs/README.md](../docs/README.md).

## 0.2.18

### Added

- **Timeline panel (right sidebar).** A new collapsible "Handoff log" tab in the side
  panel chronologically logs handoffs and errors for the active board. Handoffs come
  from a canonical `handoff` WebSocket event broadcast by `PtyHub.deliverCall` — the
  single source of truth that already knows the real `fromNodeId` / `toNodeId` of
  every agent-to-agent hand-off. One event per successful delivery, no temporal
  window, no edge inference, no false positives, no missed handoffs. (`done` /
  `inject` / `turn_end` entries are intentionally not produced — the backend emits no
  completion or inject signal yet; reserved event types exist client-side for them,
  see roadmap.)
  - `PtyHub.deliverCall`: broadcasts `{ type: "handoff", boardId, fromNodeId,
    toNodeId }` right after `scheduleInject` succeeds (and only on the success
    path — a failed recipient resolution emits nothing).
  - `timelineStore.ts`: Zustand store, FIFO-capped at 200 entries per board with a
    stable empty-array reference (avoids the `useSyncExternalStore` infinite-loop
    crash on empty/cleared boards).
  - `useTimelineCapture.ts`: React hook that consumes `handoff` events directly and
    lifts `node_status: error` verbatim. `node_status: running` produces no timeline
    entry.
  - `TimelinePanel.tsx`: React component with auto-scroll, scroll-to-bottom floating
    button, click-to-select-node, and tab integration in `App.tsx`.
  - Tests: `PtyHub.test.ts` covers the success broadcast and the no-broadcast on
    invalid recipient; `useTimelineCapture.test.ts` covers the canonical event,
    a regression for the old >8s miss, and the absence of running-based inference.
- **5 new built-in system prompts.** The prompt library grows from 9 to 14 roles:
  - **Backend Developer** — API design, DB, auth, middleware, server testing.
  - **Frontend Developer** — UI components, state, styling, a11y, performance.
  - **Architectural Reviewer** — Architecture review, ADRs, risk register, trade-offs.
  - **Design Reviewer** — Visual/UX audit, usability heuristics, accessibility checks.
  - **Security Reviewer** — Threat modelling (STRIDE), OWASP Top 10, dependency
    scanning, hardening.
- **Auditor prompt overhaul.** Completely rewritten from 56 to 158 lines with a
  structured 7-phase audit methodology: context → architecture → security → error
  handling → testing → performance → code quality. Output is graded by severity
  (🔴🟠🟡🟢) with executive summary, metrics dashboard, and actionable action plan.

### Changed

- **DB seed now loads 14 builtins** (was 9). UPSERT on first backend start — existing
  databases auto-add the 5 new roles without migration.
- **ARCHITECTURE.md** updated: tree now reflects `TimelinePanel`, `timelineStore`,
  `useTimelineCapture`; 14 prompts in seed; "handoff log / timeline panel" removed
  from future-scope list.
- **README.md** updated: usage steps mention 14 built-in roles and Timeline tab; new
  "Built-in Prompt Library" table documents all 14 roles with descriptions.
- **vscode-extension/README.md** updated: "How it works" section documents the
  Timeline panel feature.

## 0.2.17


- **Node deletion now shows an in-app confirmation dialog** instead of relying on
  `window.confirm()`, which is silently blocked in VS Code webviews (always
  returning `false`). Clicking the trash icon on a node card, or pressing
  `Backspace`/`Delete` with a node selected, now pops a small inline dialog with
  **Cancel** and **Delete** buttons. If the node is currently running, the dialog
  warns before deleting.
- **Backspace/Delete no longer bypassed the confirmation.** ReactFlow has a
  built-in keyboard handler that fired `onNodesChange({type:"remove"})` before
  the custom `keydown` listener, deleting nodes immediately without any
  confirmation. `deleteKeyCode={null}` is now set on the ReactFlow component to
  disable that built-in behaviour; the sole delete path is the guarded handler
  that shows the dialog.

### Added

- **Restart button on agent node cards.** Each node card header now has a
  `⟳` (refresh) icon that restarts the pi session for that specific node —
  previously only accessible from the full-screen terminal overlay and the side
  terminal panel. Includes a visual `animate-spin` / `animate-pulse` state while
  the restart is in progress, and a "restarting pi…" overlay on the embedded
  mini-terminal.
- **`overlayNodeId` in the runtime store.** The "which terminal is expanded
  full-screen" state moved from `App.tsx` local `useState` into `runtimeStore`,
  so `FlowCanvas` can read it directly to guard the keyboard delete shortcut
  (Backspace typed inside a full-screen terminal must not delete the node).
  Board switches now also clear `overlayNodeId`.

### Tests

- `FlowCanvas.test.tsx` rewritten: all four delete-confirmation scenarios covered
  (trash button → dialog → confirm; trash button → dialog → cancel;
  Delete key → dialog → confirm; Backspace blocked while overlay is open).
  No more `window.confirm` spy — tests interact with the React dialog buttons.

## 0.2.16

### Added

- **One backend per window (multi-instance).** Each VS Code window now spawns its
  **own** backend on a dedicated port with an isolated SQLite directory keyed by
  the workspace path, so multiple windows run in parallel without sharing state.
  Two windows opened on different folders now both work; previously the second
  window adopted the first window's backend and failed authentication.
  - **Free-port allocation.** `port.ts` (`findFreePort`/`isPortFree`) picks the
    first free port starting at `3847`. The `pinodesOrchestra.port` setting now
    defaults to `0` (auto-allocate); set a fixed value only when you need one.
  - **Per-workspace database.** `workspaceDataDir.ts` derives
    `globalStorage/instances/<sha256(workspacePath)[:16]>` and is always passed as
    `PINODES_ORCHESTRA_DATA_DIR` (previously set only for the bundled layout). A
    one-time `migrateLegacyDb()` copies an existing flat database into the new
    per-workspace folder so older boards survive.
  - **No more adoption.** `BackendManager.ensureStarted()` no longer health-checks
    `3847` and adopts an existing backend; it always launches this window's own.
    The `"external"` backend status was removed accordingly. A pinned port already
    served by another orchestra backend now fails fast with a clear error.


- **Frontend API resolution no longer hardcodes `3847`.** `resolveBase()` (split into
  the pure, unit-tested `resolveBaseForLocation()`) now returns same-origin for any
  http(s) port, so a backend on `3848+` is reached correctly inside the webview
  iframe instead of having its requests sent to `localhost:3847`.

### Changed

- **Vite dev proxy is port-configurable** via `PINODES_ORCHESTRA_PORT` (default
  `3847`) — dev-only convenience for a backend on a non-default port.

### Docs

- New [`docs/MULTI_INSTANCE.md`](../docs/guides/MULTI_INSTANCE.md): the problem, the
  per-window model, the code map, and why security is unchanged.
- `README.md`, `ARCHITECTURE.md`, `vscode-extension/README.md`,
  `docs/EXTENSIONS_ROADMAP.md`, `docs/SECURITY.md` updated to drop the obsolete
  "single backend on `3847` / adopts an existing one" assumptions.

### Tests

- `vscode-extension/src/port.test.ts`, `vscode-extension/src/workspaceDataDir.test.ts`,
  `frontend/src/lib/api.test.ts`.

## 0.2.15


- **Windows: nodes couldn't see each other (orchestration extension never
  loaded).** On Windows the `pi` launcher on PATH is the npm batch shim
  `pi.cmd`. Spawning it forced node-pty through `cmd.exe`, which treats the
  first CRLF inside our multiline `--system-prompt` as end-of-command:
  everything after it — including `--extension …call-agent.ts` — was dropped.
  pi booted as a plain session with **no** orchestration extension, so the
  per-turn hooks never ran, the connections appendix never reached the model,
  and agents reported they saw no connected nodes. (Errors were invisible
  because every callback in `call-agent.ts` swallows network failures.) Linux
  was unaffected because pi is executed directly, without a shell, so args pass
  verbatim. `PtyHub.resolvePiCommand()` now detects a `pi.cmd`/`pi.bat` shim,
  resolves the `cli.js` it wraps, and launches it with `node` directly — no
  `cmd.exe`, args verbatim, exactly like Linux.

### Other changes since 0.2.14

- Ephemeral per-session auto-token finalized in the extension host (see the
  0.2.14 *Security* notes); `sessionToken.ts` ships with unit tests.
- Docs consolidated: the security hardening plan is now reference documentation
  at [`docs/SECURITY.md`](../docs/guides/SECURITY.md) (threat model, current controls,
  known limitations) instead of a phased plan; the transient Windows
  pi-extension bug note was removed now that the fix has shipped.

### Note for maintainers

The published VSIX bundles `node-pty`/`better-sqlite3` native binaries for
**Node 24 (ABI 137)**. Build the bundle with Node 24 on PATH; a stale local
`node_modules` built under Node 22 (ABI 131) produces `ERR_DLOPEN_FAILED` at
backend start. `npm install` (or `npm rebuild better-sqlite3`) under Node 24
fixes a dev environment.

## 0.2.14

### Security

- **Backend binds to `127.0.0.1` by default** (was `0.0.0.0`). Eliminates
  exposure on LAN/WiFi interfaces. Set `PINODES_ORCHESTRA_HOST=0.0.0.0` to
  re-enable LAN/remote access explicitly.
- **WebSocket handshake checks `Origin`** — a web page from another origin
  can no longer open `ws://localhost:3847/ws` and write into pi terminals
  (Cross-Site WebSocket Hijacking → RCE via the `bash` tool). Disallowed
  origins are closed with code `4001`.
- **CORS restricted to loopback + Vite dev origins.** Extra origins via
  `PINODES_ORCHESTRA_ALLOWED_ORIGINS` (CSV).
- **`PINODES_ORCHESTRA_TOKEN`, when set, now protects every `/api/*` and
  `/internal/*` route (except `/api/health`) plus the WebSocket handshake
  via `?token=…`.** Previously only `/api/v1/orchestra/*` was gated — the
  WS and `/internal/*` paths were unauthenticated even with a token
  configured. The token is propagated to each pi PTY env so the
  `call-agent.ts` extension can still call back. Browser clients pass the
  token via `?token=…` in the URL or `localStorage.PINODES_ORCHESTRA_TOKEN`;
  the VS Code extension injects it from the `pinodesOrchestra.token`
  setting.
- **Ephemeral auto-token in the VS Code extension.** When
  `pinodesOrchestra.token` is not configured, the extension now
  auto-generates a random UUID (`crypto.randomUUID()`) per session and
  passes it as `PINODES_ORCHESTRA_TOKEN` to the backend subprocess and
  `?token=` in the webview iframe URL. This protects against other local
  processes or malicious browser extensions connecting to `:3847` while the
  panel is open — zero user config required. The token is ephemeral (changes
  on each extension activation, never persisted to disk). The extension host
  acts as a trusted intermediary that knows the secret; other processes
  cannot discover it. New pure function `resolveSessionToken()` in
  `sessionToken.ts` with dedicated unit tests (vitest).


- **`load_graph` with a stale `cwd` is now rejected** (WS `error` to the
  client) instead of silently falling back to `process.cwd()`, which
  spawned pi in the backend's directory. `PtyHub.setGraph` is the single
  validation choke point; `PtyHub.spawn` no longer re-falls-back. On
  backend restart, boards whose persisted `cwd` no longer exists are
  skipped with a log line instead of spawning pi in the wrong place.
- **`runFromHere` (frontend) now uses `inject_task` (ready-gated)** instead
  of raw `pty_input`, which could type a message into a pi terminal that
  hadn't booted yet and lose it.

### Docs

- `README.md`, `ARCHITECTURE.md`, `docs/PROGRAMMATIC_API.md` updated to
  reflect the new auth surface (global token, WS handshake, host/origin
  env vars). Security threat model and controls documented in
  `docs/SECURITY.md`.
- `AGENTS.md` updated with pre-commit verify commands (test, typecheck,
  build) for all workspaces including the extension.
- `vscode-extension/README.md` updated with `pinodesOrchestra.token`
  setting and ephemeral auto-token documentation.

## 0.2.13


- **Linux / VS Code: copy/paste in pi terminals did nothing.** The UI runs in a
  cross-origin iframe inside the editor webview, where the browser Clipboard API
  is blocked. Clipboard reads/writes are now relayed through the extension host
  (`vscode.env.clipboard`). Also added Shift+Insert / Ctrl+Insert and
  middle-click paste for Linux terminal conventions.

## 0.2.12


- **Intent watchdog crashed at end-of-turn on pi 0.79+.** When a pipeline node
  finished without `@@HANDOFF` or `@@DONE`, the extension injected
  `[orchestra:confirm]` at `agent_end` without `deliverAs`. Pi still considered
  the agent "processing" and threw *Agent is already processing. Specify
  streamingBehavior ('steer' or 'followUp')* — so the confirm never reached the
  model and nodes appeared to stop silently. The confirm is now queued with
  `{ deliverAs: "followUp" }`.
- **False `@@DONE` skipped the watchdog.** A regex matched `@@DONE` anywhere in
  the response, so an agent explaining the protocol (e.g. "you can close with
  `@@DONE`") was treated as having declared completion. Terminal intent now
  requires `@@DONE` alone on the last non-empty line of the answer.

## 0.2.11


- **Agent terminals were black after an extension update.** The backend was
  spawned with the extension's install dir as its cwd (`<extension>/server/
  backend`), which is wiped on every update. A persisted board carried that
  stale cwd and sent it back via `load_graph`; the backend rejected it
  (`Folder not found`) so the graph never synced, `pi` never spawned, and the
  terminal cards stayed black. The backend is now spawned with the user's
  home dir (or the open workspace folder) when no workspace is open, and
  `load_graph` falls back to the backend's own cwd instead of rejecting when
  the requested cwd no longer exists — so stale persisted boards self-heal.
- **Panel failed on first open, only worked after a retry.** The health-check
  timeout was 20s, but on Windows the first backend boot can take ~20–30s
  (Windows Defender scans the native modules `node-pty`/`better-sqlite3` on
  first load). The server would come up just after the timeout expired, so
  the panel reported "Backend did not become healthy within 20s" and only the
  second click worked (the backend was already running by then). The timeout
  is now 60s.
- **Health checks now target `127.0.0.1` instead of `localhost`.** On Windows
  `localhost` can resolve to `::1` (IPv6) first, while the backend binds
  `0.0.0.0` (IPv4-only); the first fetch hung on `::1` until timeout. A
  literal IPv4 loopback always reaches the listener.

## 0.2.10

### Docs

- **Corrected the Node.js requirement to 24.x** (it wrongly said 22+). The
  published VSIX ships `node-pty`/`better-sqlite3` native binaries built for
  Node 24 (ABI 137); Node 22 (ABI 127) cannot load them and the backend fails
  to start. Republished so the Open VSX / Marketplace listing shows the fix.

## 0.2.9


- **Windows/macOS: agent nodes stuck on "starting pi"** because the packaged
  backend shipped without `node-pty`'s native binaries. Recent `node-pty` keeps
  them under `prebuilds/<platform>/` (prebuildify layout), but the bundler only
  copied `build/Release` plus a hardcoded `linux-x64` prebuild — so `pty.node`/
  `conpty.node` were missing everywhere except Linux and spawning `pi` failed
  silently. The bundler now ships the prebuild for the target platform.
- **"starting pi…" overlay now behaves consistently across platforms.** It clears
  when pi has actually booted (its extension reports `session_start`) instead of
  on the first raw PTY byte — which on Windows is a ConPTY init escape emitted
  before pi is up, hiding the overlay too early. A fallback timer still reveals
  the terminal if a node never reports ready.

### Changed

- Graph validation now rejects self-loop edges and edges referencing unknown
  nodes on **every** graph-edit path (`PUT …/graph` and `/flows`, not just the
  granular edge endpoint), matching the documented programmatic-API behavior.

## 0.2.8


- **Windows: agent nodes failed to start** because the backend spawned the bare
  `pi` binary, which does not exist on Windows (the npm launcher is `pi.cmd`).
  PATH resolution now tries `pi.cmd`, `pi.exe`, `pi.bat`, then `pi` on Windows,
  so the `pi` CLI is found and spawned correctly. Other platforms are unchanged.

## 0.2.7

- Deterministic handoff via per-turn system prompt + intent watchdog.

## 0.2.6

- Granular node/edge CRUD, CLI wrapper, flow auto-cleanup.

## 0.2.5

- Auto-start node pi on load; mirror-terminal width fixes; self-contained
  per-platform bundle; pi prerequisite check; Open VSX publishing.
