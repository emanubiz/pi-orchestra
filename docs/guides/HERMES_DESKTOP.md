# Hermes Desktop integration

Operational guide for using **pinodes-orchestra** with Hermes Desktop.

> **Implementation source of truth:** [HERMES_CONTROL_PLANE_PLAN.md](../plans/HERMES_CONTROL_PLANE_PLAN.md).
> This guide is intentionally short. Do not duplicate the full plan here.

## Positioning

Hermes Desktop and pinodes-orchestra are complementary:

| Surface | Best at |
|---|---|
| **Hermes Chat/Desktop** | Conversational control, planning, tool use, approvals, memory, MCP. |
| **pinodes-orchestra** | Visual multi-agent execution: graph canvas, live terminals, edge-gated handoffs, Kanban, Timeline. |

The clean integration is:

1. **MCP/control-plane first** — Hermes creates and supervises Orchestra boards via tools.
2. **Standalone UI remains the reference** — browser/PWA works even if Desktop integration is absent.
3. **Desktop tab later** — Hermes Desktop embeds the existing Orchestra UI as a thin iframe/webview.

## Recommended user flow today

Run Orchestra standalone next to Hermes Desktop:

```bash
cd /home/emanu/Scrivania/Workspace/pinodes-orchestra
npm run dev
```

Then open:

```text
http://127.0.0.1:5173
```

Hermes can still reason about the repo and, once the MCP server is implemented, will be able to create/run boards without requiring a Desktop tab.

## Target Desktop tab UX

A future Hermes Desktop tab should be only a host shell:

```text
Hermes Desktop
  ├─ Chat
  ├─ Files
  ├─ Orchestra  ← iframe to pinodes-orchestra backend/frontend
  ├─ Skills
  └─ Settings
```

Minimal iframe URL:

```text
http://127.0.0.1:3847/?embed=hermes-desktop&cwd=<active-project-cwd>&token=<optional-token>
```

`frontend/src/lib/embed.ts` already treats any `?embed=<mode>` as embedded and reads `cwd`; verify this in the Desktop PR rather than adding host-specific frontend forks.

## Desktop implementation rules

Do:

- add a sidebar item “Orchestra”;
- health-check `GET /api/health` before showing the iframe;
- show a clear placeholder if the backend is down;
- pass cwd and optional token through the iframe URL;
- keep Orchestra backend as a separate process or existing standalone service.

Do **not**:

- rewrite Orchestra as a Hermes Electron plugin;
- put the canvas inside the Hermes Chat panel;
- fork the Orchestra frontend for Hermes;
- make Desktop embedding block MCP/control-plane work;
- expose raw terminal input through Hermes by default.

## Security notes

- Local default: backend binds `127.0.0.1`.
- Remote/LAN use: require `PINODES_ORCHESTRA_TOKEN` and protect with VPN/Tailscale or equivalent.
- Never put secrets in `runtimeConfig`; runtime credentials stay in their own configs/env.
- MCP safe mode should enforce allowed workspace roots and avoid raw PTY input.

## Related docs

- [HERMES_CONTROL_PLANE_PLAN.md](../plans/HERMES_CONTROL_PLANE_PLAN.md) — MCP + Desktop implementation plan.
- [PROGRAMMATIC_API.md](./PROGRAMMATIC_API.md) — REST/CLI surface used by MCP and hosts.
- [SECURITY.md](./SECURITY.md) — token, CORS, Origin checks, bind model.
- [EXTENSIONS_ROADMAP.md](../roadmaps/EXTENSIONS_ROADMAP.md) — high-level host/runtime sequencing.
