# Multi-instance backend — per-window isolation

> **Status: implemented** (extension v0.2.16). Each VS Code window runs its own
> backend on its own port with an isolated database. This document explains the
> problem that existed, the model that replaced it, and where it lives in the code.
>
> Key files: `vscode-extension/src/backend.ts`, `vscode-extension/src/port.ts`,
> `vscode-extension/src/workspaceDataDir.ts`, `frontend/src/lib/api.ts`,
> `frontend/vite.config.ts`. Tests: `vscode-extension/src/port.test.ts`,
> `vscode-extension/src/workspaceDataDir.test.ts`, `frontend/src/lib/api.test.ts`.

---

## TL;DR

- **Before:** a single backend process (Fastify + PtyHub + SQLite) bound to
  `127.0.0.1:3847`. The first VS Code window launched it; a second window
  **adopted** that backend instead of spawning its own. It looked like it worked,
  but it broke.
- **The breakage was not** Node being single-threaded. It came from five concrete
  things: **a fixed port**, **a per-window auth token the adopted backend didn't
  recognize**, **a shared SQLite database**, **in-memory PtyHub state that can't be
  shared**, and **a frontend with the port hardcoded to `3847`**.
- **Now:** every window/workspace gets its **own** full backend — its own port,
  its own database directory, its own token. No adoption, no IPC, no PtyHub /
  BoardManager / db refactor.
- **Security is unchanged.** Each backend is still protected by its token, bound to
  loopback, with the same CORS and WebSocket checks. In fact adoption used to
  *break* the second window's auth; isolating the processes makes auth work again.

---

## The problem (what existed before)

The backend runs in **one process** (Fastify / Node / PtyHub / SQLite). The VS Code
extension health-checked port `3847`; if something answered, it **adopted** that
backend (`this.external = true`) instead of launching its own. A second window did
not get its own backend — it shared the first one. That broke on six distinct
points.

### 1. A different auth token per window — a real bug

`vscode-extension/src/sessionToken.ts` resolves the token like this:

```ts
export function resolveSessionToken(configured: string | undefined): string {
  const trimmed = configured?.trim();
  return trimmed || crypto.randomUUID(); // ephemeral, different on every activation
}
```

That token is injected both as `PINODES_ORCHESTRA_TOKEN` into the subprocess and as
`?token=` in the webview URL. When window **B** adopted window **A**'s backend, B's
webview sent `?token=<TOKEN_B>` while the backend validated `<TOKEN_A>`:

- `validateWebSocketHandshake` closed the WS with code **4002**.
- `checkAuth` rejected REST with **401**.
- The second window showed a broken panel.

Since the ephemeral auto-token (v0.2.14) is always present, two windows *always*
have different tokens, so adoption was *guaranteed* to fail unless the user pinned
the same `pinodesOrchestra.token` everywhere. A strong argument for dropping
adoption rather than trying to share a secret.

### 2. A fixed TCP port

`PORT` defaulted to `3847` (`backend/src/index.ts:31`). Only one process can bind
it; the second adopted the first and never noticed if the first died.

### 3. A shared SQLite database

`PINODES_ORCHESTRA_DATA_DIR` was only set for the bundled layout; otherwise the
default was `<root>/data` (`backend/src/db/index.ts:13-16`). `better-sqlite3` is
single-process. Worse, at boot `BoardManager` reloads **all** boards and replays
them into PtyHub (`orchestra/BoardManager.ts:24-30`) — two processes on the same DB
would spawn each other's pi sessions → **ghost runs**.

### 4. In-memory PtyHub state

`ptyHub` is a singleton with private maps (`graphs`, `sessions`, `pending`,
`ready`, …) and an internal `EventEmitter`. There is no IPC: each backend has its
own world, and the handoff channels (`/internal/call-agent`, `/internal/ready`,
`/internal/orchestra-context`) assume sender and recipient live in the **same**
ptyHub. This is exactly why a per-process model is natural: a workspace's boards
live in that workspace's process — there is nothing to share.

### 5. The parent-PID watchdog

`PINODES_ORCHESTRA_PARENT_PID` keeps the backend alive while its spawning extension
host lives (`backend/src/index.ts:38-47`). Under adoption, closing the **first**
window killed the shared backend for the second too. One backend per window makes
the watchdog correct: each host kills only its own backend.

### 6. The frontend hardcoded to `3847`

`frontend/src/lib/api.ts`, `resolveBase()`, matched the port exactly against
`"3847"` and otherwise fell back to `http://localhost:3847`. A second backend on
`3848` would have its iframe send fetches to the *wrong* backend. This had to be
fixed because the solution assigns dynamic ports.

---

## Why threads / cluster are not the answer

The obvious temptation, and wrong:

1. **`better-sqlite3` does not scale across threads.** Synchronous, single-process.
2. **`node-pty` is not the bottleneck.** `pty.spawn` launches an external OS process
   (the `pi` CLI); Node only pipes I/O. The slow part is the model, already parallel.
3. **Sharing PtyHub/BoardManager/kanban state** would need `SharedArrayBuffer` +
   `Atomics` or a broker (Redis/IPC) — large cost, added latency, a worse `cluster`.

The parallelism already exists at the OS-process level (the PTYs). The real question
is not "how do I parallelize inside Node" but "how do I give each workspace its own
isolated stack". That is what the implementation does.

---

## The solution: one backend per window

**Each window/workspace launches its own full backend, on its own port, with its own
database and token. No adoption, no registry, no IPC.**

```
┌─ VS Code window A (workspace /repo-a) ─┐    ┌─ VS Code window B (workspace /repo-b) ─┐
│  extension host                        │    │  extension host                        │
│   └─ spawn backend  PORT=3847          │    │   └─ spawn backend  PORT=3848          │
│        DATA_DIR=…/instances/<hash-a>   │    │        DATA_DIR=…/instances/<hash-b>   │
│        TOKEN=<uuid-a>                   │    │        TOKEN=<uuid-b>                   │
│        ├─ SQLite (own)                  │    │        ├─ SQLite (own)                  │
│        └─ PtyHub (own boards)           │    │        └─ PtyHub (own boards)           │
└────────────────────────────────────────┘    └────────────────────────────────────────┘
        ▲ webview iframe → :3847 ?token=uuid-a          ▲ webview iframe → :3848 ?token=uuid-b
```

Four axes of isolation, all passed as env vars to the subprocess
(`backend.ts` `spawnBackend()`):

| Axis | Env var | How it differs | Code |
|---|---|---|---|
| **TCP port** | `PORT` | `findFreePort(3847)` → first free: 3847, 3848, … (or a fixed value if `pinodesOrchestra.port` is set) | `port.ts` |
| **Database** | `PINODES_ORCHESTRA_DATA_DIR` | `globalStorage/instances/<sha256(workspacePath)[:16]>` | `workspaceDataDir.ts` |
| **Auth token** | `PINODES_ORCHESTRA_TOKEN` | an ephemeral UUID per session (or the user's `pinodesOrchestra.token`) | `sessionToken.ts` |
| **Lifecycle** | `PINODES_ORCHESTRA_PARENT_PID` | the PID of *that* window's extension host | `index.ts` |

The stable identity of an instance is the **database directory** (the hash of the
workspace path): the same workspace reopened gets the same hash → the same DB → the
same boards. The port is only "the first free one" and may change across restarts.
The backend itself is unchanged — it just reads `PORT`, `PINODES_ORCHESTRA_DATA_DIR`
and `PINODES_ORCHESTRA_TOKEN` from the environment.

---

## How it maps to the code

### `vscode-extension/src/port.ts` (new)

`isPortFree(port)` binds a `net.createServer` on `127.0.0.1` to test availability;
`findFreePort(start, attempts=64)` returns the first free port from `start`, or
throws if the range is exhausted. Cross-platform, no native deps.

### `vscode-extension/src/workspaceDataDir.ts` (new)

`workspaceInstanceDataDir(globalStoragePath, workspaceKey)` returns
`<globalStorage>/instances/<sha256(workspaceKey).slice(0,16)>`, creating it. The
key is the workspace folder path (or `"default"` when no folder is open).

### `vscode-extension/src/backend.ts`

- `port` is now a runtime field (`_port`), not a settings getter. It is assigned in
  `ensureStarted()`: a pinned `pinodesOrchestra.port` if set (default `0` = auto),
  otherwise `findFreePort(3847)`.
- **Adoption removed.** `ensureStarted()` no longer health-checks `3847` and adopts;
  it always spawns this window's own backend. The `"external"` `BackendStatus` was
  removed along with it (also from `controlView.ts`).
- When a pinned port is already serving *another* orchestra backend, it fails fast
  with a clear error rather than silently sharing it.
- `PINODES_ORCHESTRA_DATA_DIR` is now **always** set (not only for the bundled
  layout) to the per-workspace directory.
- `migrateLegacyDb()` copies a pre-existing flat `globalStorage/pinodes-orchestra.db`
  into the new per-workspace folder once, so boards from older versions survive.

### `frontend/src/lib/api.ts`

`resolveBase()` was refactored into a pure, testable `resolveBaseForLocation()`. The
hardcoded `3847` match is gone: for any non-empty http(s) port it returns `""`
(same-origin), so the iframe always talks to whichever backend served it.

### `frontend/vite.config.ts`

The dev proxy targets are parameterized via `PINODES_ORCHESTRA_PORT` (default
`3847`), so a dev backend on a custom port still proxies correctly. Dev-only.

### `vscode-extension/package.json`

`pinodesOrchestra.port` default changed `3847 → 0` (auto-allocate).

---

## What did NOT change (security stays intact)

Removing adoption does **not** remove authentication — "adoption" (process reuse) and
"token" (security) are different things with similar names.

| Security control | Before | After |
|---|---|---|
| Per-backend token (`PINODES_ORCHESTRA_TOKEN`) | yes (ephemeral) | yes (ephemeral, **one per backend**) |
| `checkAuth` on REST `/api/*`, `/internal/*` | yes | **unchanged** |
| `validateWebSocketHandshake` (origin + token) | yes | **unchanged** |
| Loopback bind (`127.0.0.1`) | yes | **unchanged** |
| CORS `buildAllowedOrigins(PORT)` | yes | **unchanged** (already port-parametric) |
| Parent-PID watchdog | yes | **unchanged** (now correct per window) |

No change touches `backend/src/utils/security.ts`. The net security effect is
positive: adoption used to make the second window fail auth; isolation makes each
webview talk to its own backend with its own token.

---

## Invariants that keep working

- **Agent-runtime callbacks.** Each node runtime inside a PTY — the `pi` extension
  (`call-agent.ts`), the Hermes plugin (`hermes-plugins/orchestra`), and any future
  runtime such as Claude Code — calls `PINODES_ORCHESTRA_URL`, which is built from
  this backend's port (`BASE_URL` in `PtyHub.ts`, `PINODES_ORCHESTRA_PORT ?? PORT`).
  So `orchestra-context` / `ready` / `turn-ended` / `call-agent` / `handoff-failed`
  / `card-status` always land in the **right** per-window backend, regardless of
  runtime. The same `PINODES_ORCHESTRA_TOKEN` is forwarded to every runtime, so
  authenticated `/internal/*` calls work identically across pi/hermes/claude.
- **Dynamic CORS.** `buildAllowedOrigins(PORT)` already includes
  `http://localhost:${port}` and `127.0.0.1:${port}`.
- **`panel.ts` / `asExternalUri`** already handles dynamic ports; `?token=` uses this
  backend's `sessionToken`.

---

## Tests

| Test | Where | Verifies |
|---|---|---|
| `findFreePort` returns start+1 when start is occupied; throws when the range is empty | `port.test.ts` | port allocation |
| `isPortFree` true/false on bound vs free ports | `port.test.ts` | bind probe |
| `workspaceInstanceDataDir` is stable per key, distinct across keys, under `instances/<hash>` | `workspaceDataDir.test.ts` | DB isolation |
| `resolveBaseForLocation` returns `""` for port `3848` and `3847`, falls back for empty port, `""` in dev | `api.test.ts` | the critical frontend fix |

---

## Edge cases & limits

- **Same workspace open in two windows** → same DB hash, different ports/processes.
  SQLite WAL tolerates concurrent reads; concurrent writes are last-writer-wins (rare
  and no worse than before).
- **Pinned port already in use by a non-orchestra process** → the spawn fails to bind
  and surfaces a generic "did not become healthy" error rather than the specific
  "port in use" message. Acceptable; the user still gets an error.
- **Cross-workspace discovery** (seeing another workspace's boards) is intentionally
  out of scope — each window is isolated. A global instance registry
  (`~/.pinodes-orchestra/instances.json` shown in the control view) is a possible
  follow-up.

---

## Appendix — rejected options (historical)

For the record. Do not re-propose without a new reason.

- **Global daemon singleton + multi-client auth.** One backend on `3847`, windows
  converge on it via `~/.pinodes-orchestra/singleton.json`. Rejected: single-thread +
  many heavy boards means one slow board stalls all (shared WS/PtyHub broadcast, pty
  I/O); the owning window dying drags everyone down; `attachWebSocket` would need
  multi-tenancy. More invasive, more fragile.
- **Worker threads / `node:cluster`.** See "Why threads / cluster are not the answer":
  SQLite single-process is the wall, node-pty doesn't need it, shared state would need
  a broker.
- **Hybrid (multi-process + discovery registry).** The chosen model **plus** an
  `instances.json` showing "workspace X is on port Y" in the control view. A natural
  follow-up, not part of this work.

## See also

- [`SECURITY.md`](./SECURITY.md) — token, CORS, allowed origins (unchanged by this work).
- [`PROGRAMMATIC_API.md`](./PROGRAMMATIC_API.md) — REST/WS surface, already multi-port compatible.
- [`EXTENSIONS_ROADMAP.md`](./EXTENSIONS_ROADMAP.md) — host integrations, extension MVP status.
