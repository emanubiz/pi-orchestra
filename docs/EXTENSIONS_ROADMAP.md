# Extensions roadmap

How **pi-orchestra** integrates as a tab/panel in VSCode, Cursor, Hermes Desktop, and OpenClaw — without replacing its core identity as a **visual orchestration console**.

> **Scope of this document:** design and sequencing only. Implementation is future work. Standalone (browser/PWA) is the reference implementation.

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

Handoff: same `@@HANDOFF` block or structured `call_agent` if Cursor exposes it.

### Hermes (🔜 planned)

- Spawn: TUI gateway JSON-RPC session per node (`prompt.submit`, `session.steer`, …)
- Handoff: `delegate_task` or `@@HANDOFF` adapter
- Intervention: gateway `session.steer` + terminal view of stream
- See [HERMES_DESKTOP.md](./HERMES_DESKTOP.md)

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

### 2. VSCode extension

**Placement:** Activity Bar → **Pi Orchestra** → webview panel (not Agent Chat window).

```
VSCode Workbench
  Activity Bar [Pi Orchestra icon]
    └─ Webview Panel
         ├─ FlowCanvas
         ├─ TerminalPanel (xterm)
         └─ Kanban
  Extension Host
    └─ pi-orchestra backend subprocess (or in-process PtyHub)
```

| Component | Strategy |
|-----------|----------|
| UI | Bundle `frontend/dist` into extension; `createWebviewPanel` |
| Transport | Phase 1: localhost WS (spawn backend). Phase 2: `postMessage` |
| cwd | `vscode.workspace.workspaceFolders[0]` |
| Terminals | xterm in webview (same as standalone) |
| Native addons | Avoid in-process `node-pty` — spawn Node subprocess |

**Agent Window integration (optional, secondary):**

- Register `LanguageModelTool`: `orchestra_run_flow`, `orchestra_status`
- MCP server exposing board state
- Do **not** put canvas inside Chat — it's the wrong UX

**Effort:** ~2–3 weeks MVP (thin wrapper + subprocess backend).

**Publish:** VS Code Marketplace + Open VSX.

---

### 3. Cursor extension

Cursor is a VS Code fork — **same extension architecture**:

| Aspect | VSCode | Cursor |
|--------|--------|--------|
| Webview API | ✅ | ✅ |
| Extension host | ✅ | ✅ |
| Agent mode / Composer | Copilot | Cursor Agent |
| Marketplace | VS Marketplace | Cursor marketplace / side-load |

**Differences:**

- Cursor users may want **Cursor agent nodes** (`runtime: "cursor"`) more than pi nodes
- Cursor SDK may already be available in user's pi setup — document both paths
- Extension manifest identical; add `cursor`-specific README for agent node setup

**Placement:** Same as VSCode — sidebar webview, **not** Cursor's agent panel.

**Optional bridge:** Tool in Cursor Agent that calls Orchestra programmatic API (`POST /api/v1/orchestra/flows`).

**Effort:** ~1 week after VSCode extension (mostly repackage + Cursor node runtime).

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

- User runs `npm run dev` for pi-orchestra
- Uses Orchestra in browser while Hermes Desktop open
- Document in [HERMES_DESKTOP.md](./HERMES_DESKTOP.md)

#### Phase H2 — Embedded tab (Hermes Desktop PR)

Hermes Desktop is Electron. Add:

1. Sidebar nav entry "Orchestra"
2. `BrowserView` or sandboxed iframe to Orchestra URL
3. Settings: `orchestra.url` (default `http://127.0.0.1:3847`)
4. On tab open: ensure backend running (spawn `pi-orchestra` subprocess or check health)

**pi-orchestra deliverables for H2:**

- Stable `/api/health` + `/api/info` ✅
- Programmatic API (see [PROGRAMMATIC_API.md](./PROGRAMMATIC_API.md))
- Optional: `pi-orchestra serve --port 3847` single binary

#### Phase H3 — Hermes-native nodes

- `HermesRuntime` replaces pi spawn for `runtime: "hermes"` nodes
- Orchestra tab unchanged; backends swap per node type

**Who implements H2:** Hermes Desktop team or fork; pi-orchestra provides embed contract.

**Effort:** H1 = 0, H2 = ~1–2 weeks (Hermes side) + API P0 endpoints, H3 = ~3–4 weeks.

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
pi-orchestra UI  ──WS──►  OpenClaw Gateway :18789
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

Full spec: [PROGRAMMATIC_API.md](./PROGRAMMATIC_API.md).

---

## Implementation sequence

```
Phase 0  ✅ Standalone solid (PTY + WS + docs)
Phase 1  ✅ Programmatic API P0 (boards + graph + run + status + auth)
Phase 2  🔜 VSCode extension (webview + subprocess)
Phase 3  🔜 Cursor extension (repackage + cursor runtime sketch)
Phase 4  🔜 Hermes H2 embed contract + optional Desktop PR
Phase 5  🔜 OpenClaw O2 plugin (HTTP route + gateway method)
Phase 6  🔜 Multi-runtime adapters (Hermes, OpenClaw, Cursor nodes)
```

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

- [ARCHITECTURE.md](../ARCHITECTURE.md) — current standalone design
- [HERMES_DESKTOP.md](./HERMES_DESKTOP.md) — Hermes Desktop deep dive
- [PROGRAMMATIC_API.md](./PROGRAMMATIC_API.md) — REST/CLI contract for hosts
