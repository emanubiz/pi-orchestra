# PiNodes Orchestra — VS Code extension

Runs the [pinodes-orchestra](https://github.com/emanubiz/pinodes-orchestra#readme) visual multi-agent console inside VS Code,
Cursor, Windsurf, and other VS Code–compatible editors: graph canvas, live per-node
terminals, and visible `@@HANDOFF` delegation — the same UI as the standalone web
app, embedded in an editor webview.

> Implements **Phase 2** of the [extensions roadmap](https://github.com/emanubiz/pinodes-orchestra/blob/main/docs/roadmaps/EXTENSIONS_ROADMAP.md):
> a thin wrapper that spawns the bundled Fastify backend as a Node subprocess
> and frames the built frontend. No `node-pty` / `better-sqlite3` runs in the
> extension host.

## Install (recommended)

Published on **Open VSX** — this is the path for **Cursor**, **Windsurf**, and
most VS Code forks:

1. Open the Extensions view
2. Search **PiNodes Orchestra** (publisher: `emanubiz`)
3. Install → Activity Bar → **PiNodes Orchestra** → **Open PiNodes Orchestra**

Listing: <https://open-vsx.org/extension/emanubiz/pinodes-orchestra-vscode>

On **VS Code**, you can install the same extension from the Marketplace or Open VSX.
You can also sideload a platform `.vsix` manually if you prefer.

## How it works

```
VS Code
├─ Activity Bar ▸ PiNodes Orchestra (control view: status + Open/Restart/Stop/Logs)
├─ Command "Open PiNodes Orchestra" ▸ editor webview ▸ <iframe src=127.0.0.1:<port>>
└─ Extension host ▸ spawns `node backend/dist/index.js` (cwd = workspace folder)
```

- The backend serves the full React Flow + xterm UI on `/` and exposes `/api/health`.
- The webview iframes the backend through `vscode.env.asExternalUri`, so live PTY
  WebSockets run inside the iframe against the backend origin.
- The iframe URL carries `?embed=vscode&cwd=<workspaceFolder>`. In embedded mode the
  frontend **binds the single board to the workspace folder and hides the repo-tab
  switcher** (VS Code already owns the cwd), and **does not register the PWA service
  worker** (so the webview never serves a stale shell).
- **One backend per window.** Each VS Code window spawns its **own** backend on a
  dedicated port (the first free port from `3847`) with an isolated SQLite directory
  keyed by the workspace path, so two windows never share state. See
  [docs/guides/MULTI_INSTANCE.md](../docs/guides/MULTI_INSTANCE.md). (Earlier versions adopted an
  already-running backend on `3847`; that caused the second window to fail auth and
  is no longer done.)
- **Timeline panel.** The right-side tab bar now includes a **Timeline** ("Handoff
  log") view that chronologically logs handoffs and errors for the active board.
  Handoffs come from a canonical `handoff` WebSocket event broadcast by
  `PtyHub.deliverCall` (the single source of truth for every agent-to-agent
  hand-off); errors are lifted from `node_status` events.

## Requirements

- **Node.js 24.x** on your `PATH` (used to run the backend subprocess). The
  published VSIX ships native binaries (`node-pty`, `better-sqlite3`) built for
  Node 24 (ABI 137); older majors like Node 22 (ABI 127) fail to load them.
- A **built backend + frontend** in the repo: from the repo root run
  ```bash
  npm install && npm run build
  ```
- `@earendil-works/pi-coding-agent` available to the backend, and pi auth/keys
  (see the repo README) for agent nodes to actually run. On **Windows** the npm
  launcher is `pi.cmd`; the backend resolves it automatically (it tries
  `pi.cmd`/`pi.exe`/`pi.bat`/`pi` on `PATH`), so a global `npm i -g` install just
  works.

## Develop / run locally

```bash
cd vscode-extension
npm install
npm run compile      # or: npm run watch
```

Then press **F5** (“Run PiNodes Orchestra Extension”) to launch an Extension
Development Host. Open a folder, click the PiNodes Orchestra activity-bar icon, then
**Open PiNodes Orchestra**.

> On some setups (notably the **snap-packaged** VS Code on Linux) the F5
> `--extensionDevelopmentPath` flow may fail to scan the extension folder. If the
> PiNodes Orchestra icon never appears, install a packaged `.vsix` instead (below) —
> manually copying into `~/.vscode/extensions/` is **not** picked up, since VS Code
> only rescans through its install flow.

## Package & install (from source)

```bash
npm run package                              # produces a platform .vsix via @vscode/vsce
code --install-extension pinodes-orchestra-vscode-*.vsix
```

When sideloading (vs. Open VSX / Marketplace), pick the VSIX that matches your
OS/arch (`linux-x64`, `win32-x64`, `darwin-arm64`). Intel macOS (`darwin-x64`) is
not currently published (no free Intel macOS CI runner). The packaged extension is
self-contained — backend + frontend are bundled under `server/`.

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `pinodesOrchestra.port` | `0` | Backend port. **`0`** (default) picks the first free port starting at `3847`, so each window gets its own backend. Set a fixed value only when you need a stable port. |
| `pinodesOrchestra.nodeCommand` | `node` | Node runtime used to launch the backend. |
| `pinodesOrchestra.backendEntry` | _(auto)_ | Absolute path to `backend/dist/index.js`. Empty = resolve relative to the extension. |
| `pinodesOrchestra.autoStartBackend` | `true` | Start the backend when the panel opens if none is running. |
| `pinodesOrchestra.token` | _(auto)_ | Optional shared secret (`PINODES_ORCHESTRA_TOKEN`). Leave empty for normal local use — only needed for remote/LAN deployments. **When empty, the extension auto-generates an ephemeral token per session** so that the backend is always protected against other local processes or browser extensions connecting to its port. |

### Ephemeral auto-token

When `pinodesOrchestra.token` is not configured, the extension generates a random UUID (`crypto.randomUUID()`) at startup and uses it as the auth token for the session. This token is:

- Passed as `PINODES_ORCHESTRA_TOKEN` env var to the backend subprocess
- Passed as `?token=` in the webview iframe URL
- **Ephemeral** — changes on every extension activation (never persisted to disk)
- **Zero config** — the user doesn't need to set anything

This protects against other local processes (malicious npm scripts, browser extensions with `host_permissions`) connecting to the backend while the panel is open. The extension host acts as a trusted intermediary that knows the secret and passes it to both the backend and the webview, but other processes on the machine cannot discover it.

See [`docs/guides/SECURITY.md`](../docs/guides/SECURITY.md) for the full threat model and current controls.

## Documentation

All links are absolute so they resolve from the Open VSX / Marketplace listing too:

- [Project README](https://github.com/emanubiz/pinodes-orchestra#readme) — quick start, PWA, configuration
- [ARCHITECTURE.md](https://github.com/emanubiz/pinodes-orchestra/blob/main/ARCHITECTURE.md) — system design, WS protocol, `@@HANDOFF`
- [docs/guides/PROGRAMMATIC_API.md](https://github.com/emanubiz/pinodes-orchestra/blob/main/docs/guides/PROGRAMMATIC_API.md) — REST + CLI orchestration API
- [docs/guides/EXTENSION_PUBLISHING.md](https://github.com/emanubiz/pinodes-orchestra/blob/main/docs/guides/EXTENSION_PUBLISHING.md) — multi-platform VSIX build & dual-registry publishing
- [docs/roadmaps/EXTENSIONS_ROADMAP.md](https://github.com/emanubiz/pinodes-orchestra/blob/main/docs/roadmaps/EXTENSIONS_ROADMAP.md) — host integrations roadmap
- [docs/README.md](https://github.com/emanubiz/pinodes-orchestra/blob/main/docs/README.md) — full documentation index

## Known limitations (MVP)

- Multi-root workspace handling (currently binds to the first folder).
- Native `runtime: "cursor"` nodes (spawn Cursor agent directly) remain planned;
  pi nodes work today in Cursor/Windsurf via the same extension.
