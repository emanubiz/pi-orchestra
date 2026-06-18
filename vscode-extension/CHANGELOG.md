# Changelog

All notable changes to the **PiNodes Orchestra** extension are documented here.

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
