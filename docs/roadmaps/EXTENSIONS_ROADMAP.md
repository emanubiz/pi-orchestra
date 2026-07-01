# Extensions roadmap

How **pinodes-orchestra** integrates as a tab/panel in VSCode, Cursor, Hermes Desktop, and OpenClaw — without replacing its core identity as a **visual orchestration console**.

> **Scope of this document:** design and sequencing. The **VS Code extension is implemented** (MVP, `vscode-extension/`); the remaining hosts are future work. Standalone (browser/PWA) is the reference implementation.

## Product invariant

Whatever the host, these must survive:

| Invariant | Why |
|-----------|-----|
| Graph canvas (React Flow) | Topology is the product |
| Live terminals per node | Human intervention is the differentiator |
| Visible handoffs | User sees agents delegating |
| Edge-gated delegation | Permissions are explicit |
| Multi-board per repo cwd | Real projects, real folders |

What changes per host: **transport** (WS vs postMessage vs Gateway RPC) and **node runtime** (pi, Cursor, Hermes, OpenClaw).

---

## Architecture target

```
┌─────────────────────────────────────────────────────────────┐
│  packages/ui          React Flow + xterm + Kanban (shared)   │
├─────────────────────────────────────────────────────────────┤
│  packages/core        Graph, handoff, workflow DB, protocol  │
├─────────────────────────────────────────────────────────────┤
│  packages/runtime-*   PiRuntime | CursorRuntime | Hermes…    │
├─────────────────────────────────────────────────────────────┤
│  packages/host-*      standalone | vscode | hermes | openclaw│
└─────────────────────────────────────────────────────────────┘
```

---

## Node runtimes

### pi (✅ current)

- Spawn: `pi` CLI via `node-pty`
- Handoff: `@@HANDOFF` parsed by `backend/pi-extensions/call-agent.ts`
- Intervention: direct terminal input
- Cursor inside pi: pi can use Cursor SDK bridge (`pi --cursor` / MCP) — Orchestra stays host-agnostic

### Cursor agent (🔜 planned)

Dedicated node type `runtime: "cursor"`:

| Approach | Description |
|----------|-------------|
| **A. pi-as-proxy** | Keep pi nodes; user runs pi with Cursor SDK enabled. Zero Orchestra changes. |
| **B. Cursor CLI subprocess** | Spawn `cursor agent` (or SDK `Agent.create`) per node; stream events to xterm or structured panel |
| **C. VS Code/Cursor extension API** | In extension host, register Orchestra panel; nodes call Cursor agent APIs directly |

**Recommendation:** A now (already works), B for native Cursor nodes later, C inside VSCode/Cursor extension.

Full feasibility analysis (gaps, risks, spike checklist):
[plans/CURSOR_RUNTIME_ANALYSIS.md](../plans/CURSOR_RUNTIME_ANALYSIS.md) — **deferred**; Claude Code is the preferred next native runtime.

Handoff: same `@@HANDOFF` block or structured `call_agent` if Cursor exposes it.

### Hermes (✅ PTY runtime — `hermes --tui`)

- Spawn: `hermes --tui` via `HermesRuntime` (same PTY/xterm path as pi)
- Handoff: native `orchestra_handoff` tool (Hermes plugin)
- Feature flag: `PINODES_ORCHESTRA_HERMES=true`
- UI: **+ Add agent** modal — prompt picker, optional preview, runtime step before spawn; read-only **pi** / **hm** badge on the card
- Guide: [guides/HERMES_RUNTIME.md](../guides/HERMES_RUNTIME.md)

**Still open (host integration, not runtime):**

- Hermes Desktop **Orchestra tab** (iframe to localhost) — see [guides/HERMES_DESKTOP.md](../guides/HERMES_DESKTOP.md)
- Optional: JSON-RPC gateway session per node (alternative to PTY) — not planned; PTY path is shipped

### OpenClaw (🔜 planned)

- Spawn: Gateway WebSocket `agent` RPC per node
- Handoff: new `agent` call on target session
- Intervention: Gateway steer if available; else inject message
- See OpenClaw "Gateway integrations for external apps"

---

## Host integrations

### 1. Standalone (✅ reference)

| Piece | Implementation |
|-------|----------------|
| UI | Vite + React PWA |
| Backend | Fastify :3847 |
| Transport | WebSocket + REST |
| Run | `npm run dev` |

**Status:** solid. Use for daily work and as the contract other hosts embed.

---

### 2. VS Code–compatible IDE extension — ✅ published (MVP)

Lives in [`vscode-extension/`](../vscode-extension/README.md). **One extension**
serves VS Code, **Cursor**, **Windsurf**, and other forks via
[Open VSX](https://open-vsx.org/extension/emanubiz/pinodes-orchestra-vscode)
(and the VS Code Marketplace).

**Placement:** Activity Bar → **PiNodes Orchestra** → control view (status + launcher) + a full editor-area webview panel (not the Agent Chat window).

```
VSCode Workbench
  Activity Bar [PiNodes Orchestra icon]
    └─ Webview Panel
         ├─ FlowCanvas
         ├─ TerminalPanel (xterm)
         └─ Kanban
  Extension Host
    └─ pinodes-orchestra backend subprocess (or in-process PtyHub)
```

| Component | Strategy | Status |
|-----------|----------|--------|
| UI | `createWebviewPanel` framing the backend-served UI in an iframe via `vscode.env.asExternalUri` | ✅ |
| Transport | localhost HTTP/WS — frontend talks to the backend origin directly inside the iframe | ✅ |
| Backend | spawned as a Node subprocess from bundled `server/`; **one per window** on its own free port + isolated SQLite dir (see [MULTI_INSTANCE.md](../guides/MULTI_INSTANCE.md)) | ✅ |
| cwd | `workspaceFolders[0]` passed as `?embed=vscode&cwd=…`; frontend binds the single board and hides the repo-tab switcher | ✅ |
| Service worker | not registered in embedded mode (avoids stale-shell caching in the webview) | ✅ |
| Native addons | no in-process `node-pty`/`better-sqlite3` — all in the subprocess | ✅ |
| Terminals | xterm in webview (same as standalone) | ✅ |

The embedded-mode contract lives in `frontend/src/lib/embed.ts` (reads `embed`/`cwd` from the iframe URL).

**Still open:**

- Multi-root workspace handling (currently binds to the first folder).
- Cross-workspace discovery (a window seeing another workspace's boards) — by
  design each window is isolated; a global instance registry is a possible follow-up.

**Publish:** ✅ [Open VSX](https://open-vsx.org/extension/emanubiz/pinodes-orchestra-vscode)
(Cursor, Windsurf, …) + VS Code Marketplace (same extension ID).

**Agent Window integration (optional, secondary):**

- Register `LanguageModelTool`: `orchestra_run_flow`, `orchestra_status`
- MCP server exposing board state
- Do **not** put canvas inside Chat — it's the wrong UX

---

### 3. Cursor / Windsurf — ✅ same extension (Open VSX)

Cursor and Windsurf are VS Code forks — **no separate extension**. Install
**PiNodes Orchestra** from Open VSX (publisher `emanubiz`) and use the Activity
Bar panel exactly as in VS Code.

| Aspect | VSCode | Cursor / Windsurf |
|--------|--------|-------------------|
| Webview API | ✅ | ✅ |
| Extension host | ✅ | ✅ |
| Install channel | Marketplace or Open VSX | Open VSX (default in Cursor/Windsurf) |
| Agent mode / Composer | Copilot | Cursor Agent / Windsurf agent |

**Still planned (not required for daily use):**

- Dedicated **Cursor agent nodes** (`runtime: "cursor"`) spawning Cursor agent sessions
- Cursor SDK bridge documentation for pi nodes (`pi --cursor` / MCP)
- Optional Orchestra tool in Cursor Agent calling the programmatic API

**Effort for native Cursor nodes:** ~1–2 weeks (runtime adapter only — extension shell is done).

---

### 4. Hermes Desktop — Orchestra tab

**Goal:** Sidebar item **Orchestra** next to Chat, Files, Settings.

```
Hermes Desktop
  ├─ Chat
  ├─ Files
  ├─ Orchestra     ← iframe / BrowserView → http://localhost:3847
  ├─ Skills
  └─ Settings
```

#### Phase H1 — Side-by-side (no Hermes changes)

- User runs `npm run dev` for pinodes-orchestra
- Uses Orchestra in browser while Hermes Desktop open
- Document in [HERMES_DESKTOP.md](../guides/HERMES_DESKTOP.md)

#### Phase H2 — Embedded tab (Hermes Desktop PR)

Hermes Desktop is Electron. Add:

1. Sidebar nav entry "Orchestra"
2. `BrowserView` or sandboxed iframe to Orchestra URL
3. Settings: `orchestra.url` (default `http://127.0.0.1:3847`)
4. On tab open: ensure backend running (spawn `pinodes-orchestra` subprocess or check health)

**pinodes-orchestra deliverables for H2:**

- Stable `/api/health` + `/api/info` ✅
- Programmatic API (see [PROGRAMMATIC_API.md](../guides/PROGRAMMATIC_API.md))
- Optional: `pinodes-orchestra serve --port 3847` single binary

#### Phase H3 — Hermes-native nodes

- ✅ **`HermesRuntime`** — `hermes --tui` + orchestra plugin (feat/multi-runtime)
- Orchestra tab unchanged; backends swap per node type via `runtime` field

**Who implements H2:** Hermes Desktop team or fork; pinodes-orchestra provides embed contract.

**Effort:** H1 = 0, H2 = ~1–2 weeks (Hermes side) + API P0 endpoints, H3 runtime = ✅ shipped.

---

### 5. OpenClaw — Orchestra tab

**Goal:** Tab in OpenClaw Control UI or Gateway-served page.

OpenClaw documents two integration paths:

| Path | When |
|------|------|
| **Gateway external app** | Dashboard, IDE, CI — **Orchestra UI** |
| **Plugin SDK** | Code inside OpenClaw process |

#### Phase O1 — External Gateway client

```
pinodes-orchestra UI  ──WS──►  OpenClaw Gateway :18789
                              └─ agent RPC per node (runtime: openclaw)
```

Orchestra connects as Gateway operator client; nodes spawn OpenClaw agents instead of pi.

#### Phase O2 — Plugin serves Orchestra UI

```typescript
// openclaw plugin (future)
api.registerHttpRoute({
  path: "/orchestra",
  handler: serveStatic(frontendDist),
});
api.registerGatewayMethod("orchestra.run", handler);
```

User opens `http://127.0.0.1:18789/orchestra` — built-in tab.

#### Phase O3 — Control UI tab

Add "Orchestra" to OpenClaw Control UI nav (upstream PR), iframe to `/orchestra`.

**Programmatic creation (for OpenClaw cron / CLI):**

```bash
# future
openclaw orchestra run --graph flow.json --message "Migrate API"
# or REST
POST /api/v1/orchestra/flows
```

**Effort:** O1 = ~2 weeks, O2 = ~1 week (after standalone API), O3 = upstream.

---

## Shared embed contract (all hosts)

Any host embedding Orchestra must provide:

| Requirement | Detail |
|-------------|--------|
| HTTP access | Orchestra backend reachable from webview |
| WebSocket | For live PTY streams |
| Filesystem | Valid `cwd` for agent nodes |
| Optional token | For non-localhost embed |

Orchestra provides:

| Endpoint | Purpose |
|----------|---------|
| `GET /api/health` | Host readiness check |
| `GET /api/info` | Default cwd, port |
| `PUT /api/v1/orchestra/boards/:id/graph` | Load graph ✅ |
| `POST /api/v1/orchestra/boards/:id/run` | Start flow ✅ |
| `POST /api/v1/orchestra/flows` | High-level create+run ✅ |
| `ws://…/ws` | Live control ✅ |

Full spec: [PROGRAMMATIC_API.md](../guides/PROGRAMMATIC_API.md).

---

## Implementation sequence

```
Phase 0  ✅ Standalone solid (PTY + WS + docs)
Phase 1  ✅ Programmatic API P0 (boards + graph + run + status + auth)
Phase 2  ✅ VS Code–compatible extension (webview + bundled subprocess + Open VSX)
Phase 3  🔜 Native Cursor agent nodes (`runtime: "cursor"`) — extension shell already works in Cursor/Windsurf
Phase 4  🔜 Hermes H2 embed contract + optional Desktop PR
Phase 5  🔜 OpenClaw O2 plugin (HTTP route + gateway method)
Phase 6  ✅ Multi-runtime adapters — pi + Hermes TUI shipped; OpenClaw/Cursor nodes remain
Phase M1 🔜 Mobile Companion MVP (Pulse + Intervene) — see EXPANSION_MOBILE_AND_PHYSICAL.md
Phase P1 🔜 PhysicalRuntime + edge device agent spec — same doc
```

---

## Future expansions (mobile & physical)

Detailed vision (why / what / how, phases, API extensions, safety model):

→ **[EXPANSION_MOBILE_AND_PHYSICAL.md](./EXPANSION_MOBILE_AND_PHYSICAL.md)**

Summary:

- **Mobile Companion** — remote client (Expo/PWA): Pulse, Intervene, Kanban, push; backend stays on dev machine/VPS; reuses programmatic API + WS.
- **Physical Runtime** — `runtime: "physical"` nodes, edge agents on real machines, `physicalClass` + approval gates; same handoff contract as pi/Hermes.
- **Voice** — input channel to inject/approve (not a replacement UI).

---

## What we explicitly do NOT do

| Anti-pattern | Reason |
|--------------|--------|
| Replace Orchestra UI with chat | Kills the product |
| Force single-agent UX | That's Hermes/Cursor Chat |
| Fork UI per host | One `packages/ui`, transport adapters only |
| Implement all runtimes at once | pi-first; adapters later |

---

## Related docs

- [ARCHITECTURE.md](../../ARCHITECTURE.md) — current standalone design
- [guides/HERMES_RUNTIME.md](../guides/HERMES_RUNTIME.md) — Hermes TUI nodes (operational)
- [guides/HERMES_DESKTOP.md](../guides/HERMES_DESKTOP.md) — Hermes Desktop deep dive
- [guides/PROGRAMMATIC_API.md](../guides/PROGRAMMATIC_API.md) — REST/CLI contract for hosts
- [EXPANSION_MOBILE_AND_PHYSICAL.md](./EXPANSION_MOBILE_AND_PHYSICAL.md) — Mobile Companion + Physical Runtime vision
- [docs/README.md](../README.md) — full documentation index
