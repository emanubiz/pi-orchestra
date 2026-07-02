# Extensions roadmap

How **pinodes-orchestra** integrates with IDEs, Hermes Desktop, OpenClaw, and future clients without replacing its core identity as a **visual orchestration console**.

> **Scope:** high-level sequencing only. Implementation details for the active Hermes integration live in [HERMES_CONTROL_PLANE_PLAN.md](../plans/HERMES_CONTROL_PLANE_PLAN.md). Deferred runtime analyses live in `docs/archive/`.

## Product invariant

Whatever the host, these must survive:

| Invariant | Why |
|---|---|
| Graph canvas | Topology is the product. |
| Live terminals per node | Human intervention is the differentiator. |
| Visible handoffs | Users see agents delegating. |
| Edge-gated delegation | Permissions are explicit. |
| Real project cwd per board | Nodes work in actual repos/folders. |

---

## Current baseline

| Area | Status |
|---|---|
| Standalone browser/PWA | ✅ Reference implementation |
| VS Code-compatible extension | ✅ Published; works in VS Code, Cursor, Windsurf |
| Runtimes | ✅ `pi`, `hermes`, `claude` |
| Shared handoff protocol | ✅ `@@HANDOFF`, `@@CARD`, `@@DONE` |
| Programmatic REST API | ✅ Boards, graph, run, status, granular node/edge CRUD |
| Hermes MCP control-plane | 🔜 Next active integration |
| Hermes Desktop tab | 🔜 Thin host after/alongside MCP |
| Native Cursor runtime | ⏸️ Deferred |
| Zero runtime | ❌ Not viable via current PTY pattern |
| OpenClaw runtime/host | 🔜 Future |
| Mobile/physical expansion | 🔜 Future |

---

## Priority order

```text
P0 ✅ Standalone + REST/WS + VS Code extension + pi/Hermes/Claude runtimes
P1 🔜 Hermes MCP control-plane: Hermes creates/runs/supervises Orchestra boards
P2 🔜 Hermes Desktop tab: iframe/webview to existing Orchestra backend/UI
P3 🔜 OpenClaw integration: gateway/client or hosted tab
P4 🔜 Mobile companion: pulse/intervene/Kanban/push
P5 🔜 Physical runtime: edge devices with approval gates
```

**Do not put native Cursor/Zero runtime work ahead of P1/P2.** Their analyses are archived because the cost/benefit is currently poor.

---

## Host integrations

### 1. Standalone browser/PWA — ✅ reference

| Piece | Implementation |
|---|---|
| UI | Vite + React + React Flow + xterm.js |
| Backend | Fastify + WebSocket + SQLite + node-pty |
| Run | `npm run dev` |
| URL | `http://127.0.0.1:5173` in dev; backend serves dist on `:3847` in production |

This remains the canonical product surface. Every host integration must preserve parity with it.

### 2. VS Code / Cursor / Windsurf extension — ✅ shipped

Lives in [`vscode-extension/`](../../vscode-extension/README.md). One extension works across VS Code-compatible IDEs.

| Component | Status |
|---|---|
| Webview panel iframe | ✅ |
| Bundled backend subprocess | ✅ |
| One backend per window, own port/data dir/token | ✅ |
| Workspace cwd via `?embed=vscode&cwd=…` | ✅ |
| Open VSX distribution | ✅ |

Open items:

- multi-root workspace handling;
- optional IDE-agent tool integration, secondary to the visual panel.

### 3. Hermes control-plane — 🔜 active plan

Hermes should control Orchestra through MCP tools, not through a Hermes-core fork.

Primary doc: [HERMES_CONTROL_PLANE_PLAN.md](../plans/HERMES_CONTROL_PLANE_PLAN.md).

Target capabilities:

- create/list boards;
- generate/load graph;
- run/inject/stop/restart;
- inspect status/timeline;
- create workflow templates;
- supervise bounded loops;
- hand the user a live board URL.

Why this comes before the Desktop tab:

- works from Hermes CLI/TUI/Desktop;
- reusable by OpenClaw/Cursor/Claude Desktop;
- keeps Orchestra standalone;
- no dependency on Hermes Desktop plugin/UI support.

### 4. Hermes Desktop tab — 🔜 thin host

Goal:

```text
Hermes Desktop
  ├─ Chat
  ├─ Files
  ├─ Orchestra  ← iframe / BrowserView → http://127.0.0.1:3847
  ├─ Skills
  └─ Settings
```

Rules:

- iframe/webview to existing Orchestra UI;
- health-check `/api/health`;
- pass `?embed=hermes-desktop&cwd=<active-project-cwd>&token=<optional-token>`;
- show a “backend not running” placeholder;
- optional later auto-spawn backend using the VS Code extension backend-manager pattern.

Do **not** rewrite Orchestra as an Electron plugin or put the canvas inside Hermes Chat.

Guide: [HERMES_DESKTOP.md](../guides/HERMES_DESKTOP.md).
Implementation: [HERMES_CONTROL_PLANE_PLAN.md](../plans/HERMES_CONTROL_PLANE_PLAN.md).

### 5. OpenClaw — 🔜 future

Two plausible paths:

| Path | Use when |
|---|---|
| Gateway external client | Orchestra UI talks to OpenClaw gateway; nodes become OpenClaw agent sessions. |
| Hosted tab/plugin | OpenClaw serves/embeds Orchestra UI. |

Keep this behind Hermes MCP + Desktop work. The same MCP/control-plane concepts should be reusable.

---

## Runtime roadmap

### Shipped runtimes

| Runtime | Status | Spawn | Handoff |
|---|---|---|---|
| `pi` | ✅ default | `pi` CLI in PTY | `@@HANDOFF` parsed by `call-agent.ts` |
| `hermes` | ✅ | `hermes chat --tui` in PTY | same sentinel protocol parsed by Hermes plugin |
| `claude` | ✅ | interactive `claude` in PTY | same sentinel protocol parsed by hook bridge |

### Deferred/rejected runtimes

| Runtime | Decision | Reason | Reference |
|---|---|---|---|
| Cursor Agent native runtime | ⏸️ Deferred | pi-as-proxy works; native agent has unresolved per-turn/context/tooling gaps. | [archive/CURSOR_RUNTIME_ANALYSIS.md](../archive/CURSOR_RUNTIME_ANALYSIS.md) |
| Zero runtime | ❌ Not viable today | Interactive mode lacks per-node system prompt and turn-end hook; headless mode breaks live-PTY invariant. | [archive/ZERO_RUNTIME_ANALYSIS.md](../archive/ZERO_RUNTIME_ANALYSIS.md) |

Re-open a deferred runtime only after a focused spike proves:

1. PTY/xterm compatibility;
2. per-node identity/system prompt;
3. per-turn context injection;
4. turn-ended hook or equivalent final-message access;
5. unattended permission model;
6. multi-node isolation on the same cwd.

---

## Future expansions

Detailed long-horizon vision:

→ [EXPANSION_MOBILE_AND_PHYSICAL.md](./EXPANSION_MOBILE_AND_PHYSICAL.md)

Summary:

- **Mobile companion** — remote client for pulse, intervene, Kanban, push; backend stays on dev machine/VPS.
- **Physical runtime** — edge devices with `runtime: "physical"`, physical class metadata, approval gates.
- **Voice** — input/approval channel, not a replacement UI.

---

## Anti-patterns

| Anti-pattern | Decision |
|---|---|
| Replace Orchestra UI with chat | ❌ Kills the product. |
| Make Hermes Desktop tab mandatory | ❌ MCP/control-plane must work standalone. |
| Fork the frontend per host | ❌ One UI, host-specific embed params only. |
| Implement every runtime because it exists | ❌ Runtime must preserve PTY + hooks + handoff contract. |
| Unbounded autonomous loops | ❌ Always bounded and observable. |
| Raw terminal input over MCP by default | ❌ Too risky; use safe injection primitives. |

---

## Related docs

- [ARCHITECTURE.md](../../ARCHITECTURE.md) — current backend/runtimes/handoff design.
- [PROGRAMMATIC_API.md](../guides/PROGRAMMATIC_API.md) — REST/CLI contract for MCP and hosts.
- [HERMES_CONTROL_PLANE_PLAN.md](../plans/HERMES_CONTROL_PLANE_PLAN.md) — active Hermes MCP + Desktop plan.
- [HERMES_DESKTOP.md](../guides/HERMES_DESKTOP.md) — short Desktop operator guide.
- [HERMES_RUNTIME.md](../guides/HERMES_RUNTIME.md) — Hermes runtime nodes.
- [CLAUDE_RUNTIME.md](../guides/CLAUDE_RUNTIME.md) — Claude Code runtime nodes.
- [EXPANSION_MOBILE_AND_PHYSICAL.md](./EXPANSION_MOBILE_AND_PHYSICAL.md) — mobile and physical roadmap.
