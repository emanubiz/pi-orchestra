# Hermes Desktop — integration analysis

Reference for embedding **pinodes-orchestra** alongside Hermes Agent surfaces.

Sources: [Hermes Desktop docs](https://hermes-agent.nousresearch.com/docs/user-guide/desktop), [Web Dashboard](https://hermes-agent.nousresearch.com/docs/user-guide/features/web-dashboard), [Programmatic Integration](https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration).

## What Hermes Desktop is

Hermes Desktop is a **native Electron app** (macOS, Windows, Linux) that wraps the same Hermes Agent core used by CLI, TUI, and `hermes dashboard`. It is **not** a separate product — config, sessions, skills, and memory are shared across surfaces.

```
┌─────────────────────────────────────────────────┐
│  Hermes Desktop (Electron shell)                 │
│  React renderer                                  │
│       │                                          │
│       ▼                                          │
│  hermes dashboard backend (local or remote)      │
│       │                                          │
│       ▼                                          │
│  Hermes Agent core (AIAgent, tools, sessions)    │
└─────────────────────────────────────────────────┘
```

On first launch, Desktop installs the Hermes runtime into `~/.hermes` (same layout as CLI).

## Surfaces inside Desktop

| Pane | Purpose |
|------|---------|
| **Chat** | Streaming agent, tool cards, file preview rail |
| **File browser** | Explore cwd while agent works |
| **Settings** | Providers, models, MCP, gateway |
| **Management** | Skills, Cron, Profiles, Messaging |
| **Agents / Command Center** | Multi-agent orchestration (Hermes-native) |

Desktop also supports **remote backend**: Settings → Gateway → Remote gateway → URL of a running `hermes dashboard` on another machine.

## Protocols relevant to pinodes-orchestra

| Protocol | Transport | Fit for Orchestra |
|----------|-----------|---------------------|
| **ACP** (`hermes acp`) | JSON-RPC stdio | ❌ Single chat session — IDE-style, not multi-node canvas |
| **TUI gateway** | JSON-RPC stdio / WebSocket | ✅ Per-node sessions: `prompt.submit`, `session.steer`, `session.interrupt`, streaming events |
| **API server** | HTTP OpenAI-compat | ⚠️ Less control — no fine-grained steer/approval |
| **Dashboard `/api/ws`** | WebSocket JSON-RPC | ✅ Same as TUI gateway; powers Chat tab |

**Key insight:** Hermes Chat tab is literally the Ink TUI rendered via xterm.js through a PTY bridge to `tui_gateway`. pinodes-orchestra uses the same pattern (xterm.js + PTY) but orchestrates **many** sessions in a graph.

## Remote backend requirements

If Orchestra runs against a remote `hermes dashboard`:

1. Dashboard must be running (`hermes dashboard --host 0.0.0.0 --port 9119 --tui`)
2. `--tui` is **mandatory** — without it, `/api/ws` returns close code **4403**
3. Pin `HERMES_DASHBOARD_SESSION_TOKEN` in `.env` — token regenerates on restart otherwise
4. Remote URL Host header must match bind address
5. Protect with VPN (Tailscale) or OAuth — never expose `--insecure` to public internet

Desktop readiness probe (`GET /api/status`) is weaker than live chat (`/api/ws`) — a 200 on status does not guarantee chat works.

## Integration options for pinodes-orchestra

### Option A — External web app (recommended first)

Run pinodes-orchestra standalone (`npm run dev`) alongside Hermes Desktop. User alt-tabs between:

- Hermes Desktop → single-agent chat, settings, skills
- pinodes-orchestra → multi-agent visual graph

**Pros:** zero Hermes code changes, full Orchestra UX preserved  
**Cons:** two windows, no shared tab chrome

### Option B — Orchestra tab in Hermes Desktop (target)

Hermes Desktop is Electron + React. A new sidebar item **Orchestra** could:

1. Load pinodes-orchestra UI in an `<iframe>` or `BrowserView` pointing to `http://localhost:3847`
2. Or bundle the Orchestra React app and talk to a local pinodes-orchestra backend subprocess

```
Hermes Desktop sidebar
  ├─ Chat
  ├─ Files
  ├─ Orchestra  ← NEW: webview → pinodes-orchestra backend
  └─ Settings
```

**Requires:** PR or plugin to Hermes Desktop (not a public extension API today). pinodes-orchestra side only needs stable HTTP + WS (already have).

### Option C — Hermes nodes instead of pi nodes

Replace `PtyHub` pi spawn with `HermesRuntime`:

- Each graph node = Hermes session via TUI gateway JSON-RPC
- Handoff via `delegate_task` or custom output block
- Terminals show gateway stream events instead of ANSI

**Pros:** native Hermes tools/skills/memory per node  
**Cons:** significant adapter work; different handoff semantics

### Option D — Hermes plugin

`hermes plugins` can register tools. Orchestra could expose:

- `orchestra_run_flow`
- `orchestra_get_board_state`

Useful as **satellite** so Hermes Chat can trigger flows, not as the visual canvas itself.

## Hermes Desktop vs pinodes-orchestra positioning

| Dimension | Hermes Desktop Chat | pinodes-orchestra |
|-----------|---------------------|--------------|
| UX | Linear chat + tool cards | Graph + embedded terminals |
| Agents | One (or Command Center lists) | Many parallel, topology explicit |
| Intervention | Composer messages, approvals | Direct terminal typing |
| Handoff | `delegate_task`, @session | `@@HANDOFF` + edge validation |
| Best for | General coding agent | Visual multi-agent pipelines |

They are **complementary**, not competing. Orchestra is the "mission control" view; Hermes Chat is the "single agent cockpit."

## Cursor inside the picture

- **pi + Cursor SDK** (current setup): pi nodes can bridge to Cursor tools — Orchestra stays pi-centric
- **Cursor agent nodes** (planned): node type `runtime: cursor` spawning Cursor agent sessions — see EXTENSIONS_ROADMAP
- **Hermes + Cursor**: Hermes supports multiple providers; Cursor integration would be at Hermes provider level, not Orchestra-specific

## Recommended path

1. **Now:** standalone pinodes-orchestra (reference impl) + IDE extension via Open VSX (Cursor, Windsurf, VS Code)
2. **Next:** Hermes Desktop Orchestra tab via iframe to localhost backend (Option B)
3. **Later:** `HermesRuntime` adapter for native Hermes nodes (Option C)

## References

- Desktop: https://hermes-agent.nousresearch.com/docs/user-guide/desktop
- Dashboard: https://hermes-agent.nousresearch.com/docs/user-guide/features/web-dashboard
- Programmatic: https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration
- Remote backend guide: https://hermes-agent.ai/blog/connect-hermes-desktop-remote-backend
