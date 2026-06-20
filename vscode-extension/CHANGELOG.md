# Changelog

All notable changes to the **PiNodes Orchestra** extension are documented here.

## 0.2.17

### Fixed

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

### Fixed

- **Frontend API resolution no longer hardcodes `3847`.** `resolveBase()` (split into
  the pure, unit-tested `resolveBaseForLocation()`) now returns same-origin for any
  http(s) port, so a backend on `3848+` is reached correctly inside the webview
  iframe instead of having its requests sent to `localhost:3847`.

### Changed

- **Vite dev proxy is port-configurable** via `PINODES_ORCHESTRA_PORT` (default
  `3847`) — dev-only convenience for a backend on a non-default port.

### Docs

- New [`docs/MULTI_INSTANCE.md`](../docs/MULTI_INSTANCE.md): the problem, the
  per-window model, the code map, and why security is unchanged.
- `README.md`, `ARCHITECTURE.md`, `vscode-extension/README.md`,
  `docs/EXTENSIONS_ROADMAP.md`, `docs/SECURITY.md` updated to drop the obsolete
  "single backend on `3847` / adopts an existing one" assumptions.

### Tests

- `vscode-extension/src/port.test.ts`, `vscode-extension/src/workspaceDataDir.test.ts`,
  `frontend/src/lib/api.test.ts`.

## 0.2.15

### Fixed

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
  at [`docs/SECURITY.md`](../docs/SECURITY.md) (threat model, current controls,
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

### Fixed

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

### Fixed

- **Linux / VS Code: copy/paste in pi terminals did nothing.** The UI runs in a
  cross-origin iframe inside the editor webview, where the browser Clipboard API
  is blocked. Clipboard reads/writes are now relayed through the extension host
  (`vscode.env.clipboard`). Also added Shift+Insert / Ctrl+Insert and
  middle-click paste for Linux terminal conventions.

## 0.2.12

### Fixed

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

### Fixed

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

### Fixed

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

### Fixed

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
