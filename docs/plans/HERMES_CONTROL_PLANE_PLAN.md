# Hermes Control Plane for Orchestra — Implementation Plan

> **Status:** 🔜 Active product plan  
> **Date:** 2026-07-02  
> **Decision:** build the **MCP/control-plane first**, keep the **Hermes Desktop tab** as a thin host, and archive deferred runtime ideas until their gaps close.

## 0. Executive summary

The right integration is not “rewrite Orchestra inside Hermes” and not “make the Desktop tab the blocker”. The clean product is:

1. **pinodes-orchestra stays the visual execution surface**: graph, live terminals, Kanban, Timeline.
2. **Hermes becomes the meta-orchestrator** through MCP tools: it can create boards, generate workflows, run flows, inspect status, inject steering messages, stop/retry, and hand the human a live canvas.
3. **Hermes Desktop may embed Orchestra** as a sidebar tab, but this is UX chrome. The feature must work equally from Hermes CLI/TUI/Desktop and standalone Orchestra.

This plan supersedes the previous standalone `HERMES_DESKTOP_H2_PLAN.md`. The good ideas from that doc are folded into §5. The bad ideas are explicitly cut in §9.

---

## 1. Product shape

```text
Hermes Chat / TUI / Desktop
  └─ MCP tools: orchestra_*
       └─ pinodes-orchestra backend (:3847)
            ├─ REST /api/v1/orchestra/*
            ├─ WS /ws for live output
            └─ PtyHub → pi | hermes | claude nodes
                 └─ canvas UI in browser / VS Code / Hermes Desktop iframe
```

User-facing example:

> “Create a documentation cleanup workflow for this repo. Use architect → writer → reviewer, loop at most twice, and show me the board.”

Hermes should then:

1. check or start Orchestra;
2. create/bind a board for the repo cwd;
3. generate a graph using existing built-in prompts;
4. run the entry node;
5. monitor status/timeline;
6. inject corrections if the loop stalls;
7. return/open a board URL for human intervention.

---

## 2. Current code facts this plan relies on

Verified against current code/docs:

- `GET /api/health` and `GET /api/info` exist and expose runtime availability.
- `POST /api/v1/orchestra/boards`, `PUT /boards/:id/graph`, `POST /boards/:id/run`, `GET /boards/:id/status`, node inject/stop/restart, node/edge CRUD, and `POST /flows` exist.
- `frontend/src/lib/embed.ts` is already host-generic: any `?embed=<mode>&cwd=<path>` sets `IS_EMBEDDED`; it is not VS Code-only.
- Current runtimes are `pi`, `hermes`, `claude`.
- Hermes already has a native MCP client; MCP tools appear as first-class tools after restart.

---

## 3. Architecture decisions

| Decision | Verdict | Rationale |
|---|---|---|
| Primary integration | **MCP server** | Works from Hermes CLI/TUI/Desktop; reusable by OpenClaw/Cursor/Claude Desktop; no Hermes Desktop fork required. |
| Visual UI | **Reuse existing Orchestra frontend** | Canvas/terminal/Kanban/Timeline are the product. No duplicate UI. |
| Desktop integration | **Thin iframe tab** | Nice UX, not required for the control plane. Backend remains standalone/subprocess. |
| Agent nodes | **Keep existing PTY runtimes** | `pi`, `hermes`, `claude` are shipped and share the text sentinel contract. |
| Looping | **Bounded supervised loops** | Max iterations/time; human gates for risky actions. No infinite autonomous loops. |
| Cursor/Zero native runtimes | **Archive/defer** | Cursor has unresolved hook/context gaps; Zero fails the PTY invariant today. Keep analyses as reference only. |

---

## 4. P0 — MCP server (`pinodes-orchestra-mcp`)

### Goal

Expose the existing REST API as a safe MCP toolset so Hermes can orchestrate Pinodes without custom Hermes-core changes.

### Files

Create:

```text
mcp-server/
  package.json
  tsconfig.json
  src/index.ts
  src/config.ts
  src/http.ts
  src/schemas.ts
  src/tools/health.ts
  src/tools/boards.ts
  src/tools/graph.ts
  src/tools/run.ts
  src/tools/status.ts
  src/tools/inject.ts
  src/tools/open-ui.ts
  test/*.test.ts
```

Root/package changes only if needed for workspace scripts.

### Hermes config target

```yaml
mcp_servers:
  pinodes_orchestra:
    command: "node"
    args:
      - "/home/emanu/Scrivania/Workspace/pinodes-orchestra/mcp-server/dist/index.js"
    env:
      PINODES_ORCHESTRA_URL: "http://127.0.0.1:3847"
      PINODES_ORCHESTRA_ALLOWED_ROOTS: "/home/emanu/Scrivania/Workspace"
      PINODES_ORCHESTRA_MCP_MODE: "safe"
```

### P0 tools

| Tool | Safe by default | Maps to |
|---|---:|---|
| `orchestra_health` | ✅ | `GET /api/health` |
| `orchestra_info` | ✅ | `GET /api/info` |
| `orchestra_list_boards` | ✅ | `GET /api/v1/orchestra/boards` |
| `orchestra_create_board` | ✅ with allowed-root check | `POST /boards` |
| `orchestra_get_graph` | ✅ | `GET /boards/:id/graph` |
| `orchestra_put_graph` | ✅ with graph validation | `PUT /boards/:id/graph` |
| `orchestra_run_board` | ✅ | `POST /boards/:id/run` |
| `orchestra_get_status` | ✅ | `GET /boards/:id/status` |
| `orchestra_inject_node` | ✅ | `POST /boards/:id/nodes/:nodeId/inject` |
| `orchestra_stop_board` | ⚠️ confirmation-worthy | `POST /boards/:id/stop` |
| `orchestra_open_ui` | ✅ | returns URL/deep link; optionally shell-open outside MCP safe mode |

### P0 implementation tasks

1. Add TypeScript MCP server skeleton using the official MCP SDK.
2. Implement `config.ts`:
   - `PINODES_ORCHESTRA_URL`, default `http://127.0.0.1:3847`;
   - optional `PINODES_ORCHESTRA_TOKEN`;
   - `PINODES_ORCHESTRA_ALLOWED_ROOTS`, comma-separated;
   - `PINODES_ORCHESTRA_MCP_MODE=safe|full`.
3. Implement `http.ts` wrapper:
   - JSON fetch;
   - token header `X-PiNodes-Orchestra-Token`;
   - useful error messages;
   - timeout.
4. Implement P0 tools with Zod/input schemas.
5. Add allowed-root validation for cwd before board/flow creation.
6. Add tests with mocked fetch for success, error, auth header, allowed-root rejection.
7. Add `docs/guides/HERMES_CONTROL_PLANE.md` as the user/operator guide after implementation.

### P0 verification

```bash
npm install -w mcp-server
npm run build -w mcp-server
npm test -w mcp-server
node mcp-server/dist/index.js  # should start MCP stdio server
hermes mcp add pinodes_orchestra --command node --args /abs/path/mcp-server/dist/index.js
hermes mcp test pinodes_orchestra
```

Then from Hermes: ask it to create a 2-node docs workflow and verify the board appears in the UI.

---

## 5. P1 — workflow generation and templates

### Goal

Let Hermes create high-quality workflow graphs from intent without inventing node shapes every time.

### Files

```text
workflows/templates/
  docs-cleanup.json
  feature-build.json
  bugfix-loop.json
  code-review.json
  research-synthesis.json
```

### Template contract

```json
{
  "id": "docs-cleanup",
  "name": "Docs cleanup loop",
  "description": "Architect plans, writer edits, reviewer validates.",
  "graph": {
    "name": "docs-cleanup",
    "entryNodeId": "architect",
    "nodes": [
      { "id": "architect", "label": "Architect", "promptId": "builtin-architect", "runtime": "hermes", "position": { "x": 0, "y": 0 }, "canBeFinal": false },
      { "id": "writer", "label": "Technical Writer", "promptId": "builtin-writer", "runtime": "claude", "position": { "x": 340, "y": 0 }, "canBeFinal": false },
      { "id": "reviewer", "label": "Reviewer", "promptId": "builtin-auditor", "runtime": "hermes", "position": { "x": 680, "y": 0 }, "canBeFinal": true }
    ],
    "edges": [
      { "id": "e-architect-writer", "sourceNodeId": "architect", "targetNodeId": "writer" },
      { "id": "e-writer-reviewer", "sourceNodeId": "writer", "targetNodeId": "reviewer" },
      { "id": "e-reviewer-writer", "sourceNodeId": "reviewer", "targetNodeId": "writer" }
    ]
  },
  "policy": {
    "maxIterations": 2,
    "maxMinutes": 30,
    "humanApprovalBeforeCommit": true
  }
}
```

### P1 tools

| Tool | Purpose |
|---|---|
| `orchestra_list_templates` | Show available graph templates. |
| `orchestra_create_from_template` | Instantiate a template with cwd/runtime overrides. |
| `orchestra_run_template` | Create board + graph + run in one call. |

---

## 6. P2 — supervised loops

### Goal

Hermes should supervise a board without hiding the live canvas. It should intervene only through explicit, bounded tools.

### Add tools

| Tool | Purpose |
|---|---|
| `orchestra_wait_for_idle` | Poll status until no nodes running or timeout. |
| `orchestra_get_recent_events` | Return latest Timeline/handoff/error events. If backend lacks durable timeline API, add one first. |
| `orchestra_summarize_node_output` | Return bounded recent terminal output for a node. |
| `orchestra_restart_node` | Recovery primitive. |
| `orchestra_stop_node` | Recovery primitive. |

### Loop policy

Every generated loop must include:

```json
{
  "maxIterations": 3,
  "maxMinutes": 45,
  "maxConsecutiveFailures": 2,
  "humanApprovalBeforeCommit": true,
  "humanApprovalBeforePush": true,
  "stopOnTestsPass": true
}
```

No unbounded loops. No hidden destructive action.

---

## 7. P3 — Hermes Desktop tab

### Goal

Single-window UX. This is not required for P0/P1.

### Minimal Desktop behavior

1. Sidebar item: **Orchestra**.
2. Health check `GET ${orchestra.url}/api/health`.
3. If healthy: iframe to:

```text
http://127.0.0.1:3847/?embed=hermes-desktop&cwd=<active-project-cwd>&token=<optional-token>
```

4. If unhealthy: show:
   - “Start standalone: `cd pinodes-orchestra && npm run dev`”;
   - optional “Start Orchestra” button later.

### Orchestra-side work

Likely none for embed detection: `frontend/src/lib/embed.ts` already treats any `embed` query param as embedded. Verify with a smoke test; add `embed.test.ts` only if coverage is missing.

### Optional P3.5 — auto-spawn

Borrow the VS Code extension backend manager pattern:

- free port from 3847;
- `PINODES_ORCHESTRA_DATA_DIR` under Hermes Desktop user data;
- ephemeral token;
- `PINODES_ORCHESTRA_PARENT_PID` so backend exits with Desktop.

---

## 8. Security model

| Area | Policy |
|---|---|
| Network | Default localhost only. Remote requires token + VPN/Tailscale or equivalent. |
| Filesystem | MCP enforces `allowed_roots`; default `/home/emanu/Scrivania/Workspace` for local dev. |
| Auth | Use `PINODES_ORCHESTRA_TOKEN` when not strictly local. MCP passes token header. |
| Raw PTY input | Not exposed in safe mode. Use `inject_node(message)` instead. |
| Board deletion/stop | Confirmation-worthy in Hermes; MCP should clearly mark as destructive. |
| Audit | MCP writes JSONL audit log for create/run/inject/stop actions. |
| Secrets | Never store secrets in `runtimeConfig`; keep runtime credentials in their own configs/env. |

Audit file candidate:

```text
~/.pinodes-orchestra/mcp-audit.jsonl
```

or under `PINODES_ORCHESTRA_DATA_DIR` if set.

---

## 9. Cuts — ideas explicitly rejected or deferred

| Idea | Decision | Why |
|---|---|---|
| Rewrite Orchestra as a Hermes Desktop-native Electron plugin | ❌ Cut | Duplicates working backend/frontend and couples release cycles. |
| Put the canvas inside Hermes Chat | ❌ Cut | Chat is a single-agent cockpit; Orchestra is a mission-control canvas. |
| Make Desktop tab a prerequisite for Hermes orchestration | ❌ Cut | MCP works everywhere and should ship first. |
| Native Cursor runtime now | ⏸️ Archive | pi-as-proxy works; Cursor native has unresolved per-turn/context/tool gaps. |
| Native Zero runtime now | ❌ Archive | Interactive mode lacks per-node system prompt and turn-end hook; headless mode breaks live-PTY invariant. |
| Raw terminal input over MCP by default | ❌ Cut | Too powerful; unsafe for normal Hermes tool exposure. |
| Unbounded autonomous loops | ❌ Cut | Must be bounded, observable, and stoppable. |
| Fork frontend per host | ❌ Cut | One UI, host-specific embed params only. |

---

## 10. Documentation consolidation rules

Active docs after this cleanup:

- `docs/plans/HERMES_CONTROL_PLANE_PLAN.md` — this plan; source of truth for Hermes↔Orchestra MCP + Desktop tab.
- `docs/guides/HERMES_DESKTOP.md` — concise operator/positioning guide; points here for implementation.
- `docs/roadmaps/EXTENSIONS_ROADMAP.md` — high-level sequencing only, not implementation details.
- `docs/archive/CURSOR_RUNTIME_ANALYSIS.md` — archived feasibility study.
- `docs/archive/ZERO_RUNTIME_ANALYSIS.md` — archived feasibility study.

Do not create another Hermes/Desktop/MCP plan unless it replaces this file.

---

## 11. Verification checklist for implementation PRs

### MCP PR

- [ ] `npm run build -w mcp-server` passes.
- [ ] `npm test -w mcp-server` passes.
- [ ] `hermes mcp test pinodes_orchestra` succeeds.
- [ ] Hermes can create and run a 2-node board from chat.
- [ ] Allowed-root rejection tested.
- [ ] Token header tested.
- [ ] Audit log written for create/run/inject/stop.

### Desktop tab PR

- [ ] `http://127.0.0.1:3847/?embed=hermes-desktop&cwd=/tmp` loads.
- [ ] WS connects and terminals render.
- [ ] Keyboard focus reaches xterm inside iframe.
- [ ] Health placeholder appears when backend is down.
- [ ] Optional token works.
- [ ] Existing standalone and VS Code embed modes are unchanged.

---

## 12. Final target UX

Hermes answer after a user request should look like:

```text
Creato workflow “docs-cleanup” su board b_123.
Nodi: Architect → Writer → Reviewer → Writer(loop max 2).
Run avviato su Architect.
Canvas: http://127.0.0.1:3847/?board=b_123
Sto monitorando: ti avviso/intervengo solo se il loop si blocca o il reviewer boccia due volte.
```

That is the product: Hermes plans and supervises; Orchestra executes visibly; the human can intervene either by chat or by canvas.
