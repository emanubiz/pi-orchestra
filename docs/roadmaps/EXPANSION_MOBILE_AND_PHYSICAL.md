# PiNodes Orchestra Expansion — Mobile Companion & Physical Runtime

> **Date:** 2026-07-01  
> **Status:** Vision / plan — no mandatory implementation yet  
> **Author:** brainstorming Emanuele + OpenClaw, to be consolidated into an ADR when M1 or P1 begins

---

## Table of Contents

1. [Context](#context)
2. [Product invariants](#product-invariants)
3. [Expansion A — Mobile Companion](#expansion-a--mobile-companion)
4. [Expansion B — Physical Runtime & network orchestration](#expansion-b--physical-runtime--network-orchestration)
5. [Voice channel (input/output, not product)](#voice-channel-inputoutput-not-product)
6. [Unified target architecture](#unified-target-architecture)
7. [Implementation sequence](#implementation-sequence)
8. [Risks, open decisions, success metrics](#risks-open-decisions-success-metrics)
9. [Related documents](#related-documents)

---

## Context

**PiNodes Orchestra** today is a web app / PWA (+ VS Code/Cursor extension) that displays an **agent node canvas**. Each node is a real AI process in a PTY (`pi` or `hermes`), connected to other nodes by **edges** that define handoff permissions. The human can intervene at any time in a node's terminal.

Current stack (see [ARCHITECTURE.md](../../ARCHITECTURE.md)):

```
Frontend (React Flow + xterm + Kanban)
    ↔ WebSocket + REST
Backend (Fastify + PtyHub + SQLite)
    → INodeRuntime (PiRuntime | HermesRuntime)
    → handoff via /internal/call-agent (single contract)
```

**What's missing today to "go beyond the desk":**

| Gap | Impact |
|-----|--------|
| UI designed for desktop (canvas + full xterm) | Hard to supervise from a phone |
| Software-only runtime (local PTYs) | Physical machine nodes not modeled |
| No explicit approval gate for irreversible actions | Critical when adding hardware |
| Voice not integrated | Opportunity for hands-free inject/approve |

This document describes **two complementary expansions** that respect product invariants and reuse existing APIs/protocols.

---

## Product invariants

From [EXTENSIONS_ROADMAP.md](../roadmaps/EXTENSIONS_ROADMAP.md) — **non-negotiable** in any expansion:

| Invariant | Meaning for mobile/physical |
|-----------|----------------------------|
| Graph / topology | Remains the mental model; mobile can be read-only on the graph |
| Visible handoffs | Timeline + WS `handoff` events on companion too |
| Human intervention | Core value; mobile = remote control + approve |
| Edge-gated delegation | Edges = permissions; extend with `requiresApproval` for L2/L3 |
| Multi-board per cwd | Unchanged; mobile selects remote board |

**Explicit anti-patterns:**

- ❌ Replace Orchestra with a mobile chat app
- ❌ Run heavy PTY/agents *inside* the mobile app (battery, sandbox, API keys)
- ❌ Fork full UI for every host — thin client + same backend

---

## Expansion A — Mobile Companion

### Why

1. **Asynchronous supervision** — multi-agent pipelines run for hours; the user doesn't stay in front of the canvas.
2. **Portable human-in-the-loop** — approve handoffs, inject corrections, stop nodes from a Telegram-style UX.
3. **Kanban already mobile-friendly** — column view exists in the frontend; natural entry point on a small screen.
4. **APIs already ready** — [PROGRAMMATIC_API.md](../guides/PROGRAMMATIC_API.md): status, inject, run, stop, WS events.
5. **Stack alignment** — Expo/React Native already used in other projects (e.g. SwappIt); reuse existing skills.

### What (product scope)

**Orchestra Mobile Companion** — app (native or mobile-first PWA) that **does not replace** the desktop canvas but **complements** it:

| Screen | Function | MVP priority |
|--------|----------|--------------|
| **Pulse** | Board state: nodes running/idle/error, last handoff, watchdog failures | P0 |
| **Intervene** | Tap node → inject, stop, restart; approve pending handoffs | P0 |
| **Kanban** | Columns + cards; tap card → message to entry node | P1 |
| **Graph (read-only)** | Zoomable topology, no editing | P2 |
| **Settings** | Backend URL, token, Tailscale hint, notifications | P0 |

**Out of scope for mobile MVP:**

- Graph editing (drag nodes, new edges)
- Full interactive xterm (too small; optional scrollback summary)
- Backend embedded on the phone
- Local spawn of pi/hermes

### How (technical architecture)

#### Topology

```
┌─────────────────────┐         HTTPS/WSS (+ token)        ┌──────────────────────────┐
│  Mobile Companion   │ ◄──────────────────────────────────► │  Orchestra Backend       │
│  (Expo RN or PWA)   │                                      │  (Fastify :3847)         │
│  - Pulse UI         │                                      │  PtyHub + SQLite         │
│  - Push (FCM/APNs)  │                                      │  PTY agents (pi/hermes)  │
└─────────────────────┘                                      └──────────────────────────┘
         ▲                                                              ▲
         │ optional: Tailscale / WireGuard / reverse tunnel           │
         └──────────────────────── homelab / laptop dev ────────────────┘
```

The backend stays **always-on** on the work machine (or VPS). Mobile is a **thin client**.

#### Reuse of existing protocol

| Mobile need | Existing endpoint / event |
|-------------|---------------------------|
| Health check | `GET /api/health` |
| Board list | `GET /api/v1/orchestra/boards` |
| Node status | `GET .../boards/:id/status` + WS `node_status` |
| Inject message | `POST .../nodes/:nodeId/inject` |
| Stop node | `POST .../nodes/:nodeId/stop` |
| Start flow | `POST /api/v1/orchestra/flows` |
| Handoff timeline | WS event `handoff` (already consumed by frontend) |
| Auth | `PINODES_ORCHESTRA_TOKEN` header or query |

**Minimal API extensions (proposed, to implement in M1):**

```http
GET /api/v1/orchestra/boards/:boardId/pulse
→ {
    nodes: [{ id, label, status, runtime, lastHandoffAt, needsAttention }],
    pendingApprovals: [{ id, fromNode, toNode, message, createdAt }],
    kanbanSummary: { todo, doing, done, blocked }
  }

POST /api/v1/orchestra/boards/:boardId/approvals/:approvalId/respond
  { action: "approve" | "reject", comment?: string }
```

`pendingApprovals` also becomes relevant for Physical Runtime (section B).

#### Mobile client — recommended stack

| Option | Pros | Cons |
|--------|------|------|
| **Expo (React Native)** | Native push, background, STT plugin, same RN ecosystem | Separate repo or `packages/mobile` |
| **Mobile-first PWA** | Zero store, reuses Vite | Limited iOS push, xterm absent anyway |

**Recommendation:** Expo app in `packages/mobile/` (monorepo) with `@tanstack/react-query` SDK + WS client extracted from `frontend/src/hooks/useOrchestraWs.ts`.

#### Push notifications

Triggers (server-side, new `ApprovalNotifier` module or hook in PtyHub):

| Event | Push |
|-------|------|
| Handoff to node with `requiresApproval` | "Approve handoff: Dev → Deploy" |
| Watchdog `handoff-failed` | "Node X blocked — intervention needed" |
| Flow completed | "Auth pipeline finished" |
| Node crash (exit ≠ 0) | "Backend-Dev terminated with error" |

Device token registered via:

```http
POST /api/v1/orchestra/devices/register
  { platform: "ios"|"android", token: string, label?: string }
```

#### UX principles

1. **Glanceable first** — Pulse must be readable in 3 seconds.
2. **One tap to intervene** — inject with templates ("Stop", "Retry", "Use PostgreSQL").
3. **Read-only graph** — pan/zoom, tap node → Intervene.
4. **Graceful offline** — cache last Pulse; reconnect WS with backoff.

#### Mobile phases

| Phase | Deliverable | Estimated duration |
|-------|-------------|-------------------|
| **M0** | Spike: Expo + WS + inject on remote board via Tailscale | 3–5 days |
| **M1** | Pulse + Intervene + token auth + deploy README | 2 weeks |
| **M2** | Mobile Kanban + push (FCM) | 1–2 weeks |
| **M3** | Read-only graph + polish | 1 week |
| **M4** | Voice inject (STT → inject API) | 1–2 weeks |

#### M1 verification

- [ ] Connect to remote backend with token
- [ ] See node status in <2s after opening app
- [ ] Inject message on running node from phone
- [ ] Receive WS update without refresh
- [ ] Stop node from mobile reflected on desktop canvas

---

## Expansion B — Physical Runtime & network orchestration

### Why

1. **INodeRuntime is already an abstraction** — today `PiRuntime` / `HermesRuntime`; adding `PhysicalRuntime` aligns with `feat/multi-runtime`.
2. **Handoff contract is runtime-agnostic** — `/internal/call-agent` → `PtyHub.deliverCall` → inject/broadcast (see ARCHITECTURE.md).
3. **Graph = real topology** — software factory, homelab, home robotics, edge IoT: same mental model as the canvas.
4. **Safety** — physical actions require **structural** human-in-the-loop, not optional.
5. **Agent network** — central hub + workers on Raspberry Pi / OpenClaw gateway / MQTT devices.

### What (product scope)

A node with `runtime: "physical"` (or `"edge"`) represents a **network machine or service**, not a PTY:

| Node type | Example | Output to Orchestra |
|-----------|---------|---------------------|
| **observe** | Sensor, camera, log tail | Telemetry, snapshot |
| **actuate** | Relay, deploy script, printer | Job queue + ack |
| **critical** | Robot arm, CNC, lock door | Requires human approval |

The canvas shows the **same node** (label, status, mini-log); the side panel shows **telemetry + pending actions** instead of xterm (or optional xterm if edge emulates PTY).

### Security model — physicalClass

Extension to `WorkflowNode`:

```typescript
interface WorkflowNode {
  runtime?: "pi" | "hermes" | "physical" | "edge" | "openclaw";
  runtimeConfig?: {
    /** Device agent endpoint, e.g. http://192.168.1.50:9090 */
    endpoint?: string;
    protocol?: "http" | "mqtt" | "ros2" | "openclaw-gateway";
    topic?: string;
    /** Risk class — default "observe" */
    physicalClass?: "observe" | "actuate" | "critical";
    /** Block outgoing handoff until approved (mobile/desktop) */
    requiresApproval?: boolean;
    /** Approval timeout (ms), then fail or retry */
    approvalTimeoutMs?: number;
  };
}
```

| Class | Examples | Human gate |
|-------|----------|--------------|
| **L0 observe** | Temperature, presence, log | None |
| **L1 actuate soft** | LED, notification, reversible file write | Optional |
| **L2 actuate** | Deploy, marketplace order, batch job | Tap approve (mobile/desktop) |
| **L3 critical** | Motor, robot, heat | Double confirm + timeout + hardware kill switch |

**Timeline UI:**  
*"Robot-Arm-1 proposes: pick up object A → pass to QA-Camera"* — Approve / Reject / Edit message buttons.

### How (technical architecture)

#### PhysicalRuntime — target interface

Implements `INodeRuntime` where possible; where PTY doesn't exist, adapt PtyHub with **runtime capabilities**:

```typescript
/** backend/src/pty/runtime/PhysicalRuntime.ts (draft) */

export interface PhysicalCapabilities {
  hasPty: false;
  supportsInject: true;      // message → device agent
  supportsStream: true;      // telemetry → onOutput (text/JSON lines)
  supportsKill: true;        // abort job / estop
  requiresApproval: boolean;
}

export class PhysicalRuntime implements INodeRuntime {
  spawn(config: RuntimeSpawnConfig): void {
    // 1. POST config.endpoint + /orchestra/spawn
    //    body: { boardId, nodeId, systemPrompt, appendix, physicalClass }
    // 2. Subscribe telemetry (SSE / WS / MQTT)
    // 3. on first telemetry → markReady()
    // 4. stream lines → config.onOutput(JSON.stringify(evt) + "\n")
  }

  inject(message: string): void {
    // POST .../inject — device agent executes or enqueues
  }

  kill(): void {
    // POST .../kill — includes estop if critical
  }

  // write/resize: no-op or forward if device exposes shell
}
```

**Note:** PtyHub today assumes ANSI output for xterm. For physical:

- Option A: `onOutput` remains a string (JSON log line) — frontend detects `runtime === "physical"` and renders **TelemetryPanel** instead of xterm.
- Option B: new WS message type `telemetry` (minor breaking change, cleaner).

**Recommendation:** B in P2, A for P0 spike.

#### Device Agent (edge)

Each physical machine runs a **lightweight agent** (not full Orchestra):

```
pinodes-orchestra-edge   (Python/Node, ~500 lines)
  - Registers capabilities (observe/actuate/critical)
  - Exposes local HTTP:
      POST /orchestra/spawn
      POST /orchestra/inject
      POST /orchestra/kill
      GET  /orchestra/health
  - Callbacks to hub:
      POST {ORCHESTRA_URL}/internal/ready
      POST {ORCHESTRA_URL}/internal/call-agent   (handoff)
      POST {ORCHESTRA_URL}/internal/turn-ended   (watchdog)
  - Executes real commands (GPIO, ROS, script, OpenClaw RPC)
```

The hub **does not** reach GPIO directly — only the edge agent on the device's LAN.

#### Network topologies

**1. Central hub + edge agents (recommended)**

```
                    ┌─────────────────┐
                    │ Orchestra Hub   │
                    │ (laptop/VPS)    │
                    └────────┬────────┘
           ┌─────────────────┼─────────────────┐
           ▼                 ▼                 ▼
    ┌─────────────┐   ┌─────────────┐   ┌─────────────┐
    │ Edge@raspi  │   │ Edge@pi5    │   │ pi/hermes   │
    │ (camera)    │   │ (deploy)    │   │ (software)  │
    └─────────────┘   └─────────────┘   └─────────────┘
```

**2. Mini Orchestra per site**

Industrial site with local Orchestra + graph sync to cloud hub (future, not MVP).

**3. OpenClaw Gateway as transport**

`runtime: "openclaw"` + `protocol: "openclaw-gateway"` — reuses plane O1 in EXTENSIONS_ROADMAP.

#### Example mixed software + physical graph

```
[PM pi] → [Architect hermes] → [Deploy-Edge@raspi] → [QA-Camera@pi5] → [Human Review]
                                      │                      │
                                      └──── handoff ──────────┘
[OpenClaw@server] → [Telegram notify mobile]
```

Handoff and watchdog **identical** to software; only how the runtime signals completion changes (HTTP tool vs @@HANDOFF).

#### Approval flow (backend)

New state in PtyHub:

```
handoff proposed → (requiresApproval?) → pending_approval
  → approve (mobile/desktop/API) → deliverCall
  → reject → nudge source node or mark failed
  → timeout → handoff-failed event + push
```

SQLite persistence: `approvals` table (boardId, fromNode, toNode, message, status, expiresAt).

Mobile Companion (section A) consumes `GET .../pulse` → `pendingApprovals`.

#### Physical phases

| Phase | Deliverable | Estimated duration |
|-------|-------------|-------------------|
| **P0** | Device agent OpenAPI spec + HTTP mock spike | 1 week |
| **P1** | `PhysicalRuntime` + `telemetry` WS + web TelemetryPanel | 2–3 weeks |
| **P2** | `physicalClass` + `requiresApproval` + approve API | 2 weeks |
| **P3** | `pinodes-orchestra-edge` reference (Raspberry Pi + camera) | 2–3 weeks |
| **P4** | MQTT adapter + OpenClaw gateway adapter | 2 weeks each |

#### P1 verification

- [ ] Node with `runtime: "physical"` appears on canvas with status
- [ ] Telemetry stream visible (web + mobile Pulse)
- [ ] Handoff pi → physical → pi completes end-to-end
- [ ] Kill/estop stops job within N seconds
- [ ] No regression on pi/hermes nodes

---

## Voice channel (input/output, not product)

Voice **does not** replace the canvas. It is an **I/O channel** for Mobile Companion and desktop.

| Voice action | API mapping |
|--------------|-------------|
| "Stop the DevOps node" | `POST .../nodes/:id/stop` |
| "Approve handoff" | `POST .../approvals/:id/respond { approve }` |
| "Inject: use PostgreSQL" | `POST .../inject` |
| "Confirm arm movement" | L3 approve with challenge phrase |

**Implementation:** M4 mobile (Expo Speech / whisper API) → same REST endpoints.  
**Voice output (TTS):** optional read-aloud on push ("Handoff pending from Backend to Deploy").

---

## Unified target architecture

Extends the diagram in EXTENSIONS_ROADMAP:

```
┌─────────────────────────────────────────────────────────────────┐
│  packages/ui           Flow + Kanban + TelemetryPanel (shared)   │
│  packages/mobile       Pulse + Intervene + Push (new)           │
├─────────────────────────────────────────────────────────────────┤
│  packages/core         Graph, handoff, approvals, protocol      │
├─────────────────────────────────────────────────────────────────┤
│  packages/runtime-*    Pi | Hermes | Physical | OpenClaw | …    │
├─────────────────────────────────────────────────────────────────┤
│  packages/host-*       standalone | vscode | mobile | edge-agent│
└─────────────────────────────────────────────────────────────────┘
```

**Hub backend** remains single per board; edge agents are **remote runtimes**, not second hubs (except future multi-site).

---

## Implementation sequence

Integration with [EXTENSIONS_ROADMAP.md](./EXTENSIONS_ROADMAP.md):

```
Phase 0–2  ✅ Standalone, API, VS Code extension
Phase 3    🔜 Cursor native nodes
Phase 4    🔜 Hermes Desktop embed tab (host-side)
Phase 5    🔜 OpenClaw plugin
Phase 6    ✅ Multi-runtime (pi + Hermes TUI shipped on feat/multi-runtime)

── New phases (this document) ──

Phase M1   🔜 Mobile Companion MVP (Pulse + Intervene)
Phase M2   🔜 Mobile Kanban + push notifications
Phase P1   🔜 PhysicalRuntime + device agent spec
Phase P2   🔜 Approval gates (physicalClass + mobile approve)
Phase M4   🔜 Voice inject (depends on M1)
Phase P3   🔜 Reference edge (Raspberry Pi)
```

**Recommended parallelism:**

- **M1 ∥ P0** — mobile client and edge spec don't block each other
- **P2 after M1** — approve UI on mobile requires base companion
- **P3 after P1** — hardware reference after working runtime

---

## Risks, open decisions, success metrics

### Risks

| Risk | Mitigation |
|------|------------|
| Exposing backend on the Internet | Tailscale default; token required; never `0.0.0.0` without auth |
| Irreversible physical action | physicalClass L3 + double confirm + hardware estop |
| WS latency on mobile | Pulse cached; reconnect; don't stream full PTY |
| Scope creep (voice-first, chat-first) | Invariants + this doc as gate review |
| PhysicalRuntime forces PtyHub refactor | Capabilities flag; phase A string output compat |

### Open decisions

1. **Mobile repo:** `packages/mobile` folder in monorepo vs separate repo?
2. **WS `telemetry` vs string hack** — when to introduce breaking protocol?
3. **Device agent language:** Node (aligned with backend) vs Python (GPIO/ROS)?
4. **Approval mobile-only or desktop modal too?** — both, same API
5. **Store distribution:** TestFlight/APK sideload vs PWA for M1?

### Success metrics

| Expansion | Metric |
|-----------|--------|
| Mobile M1 | Intervene on remote node in <30s from push notification |
| Mobile M2 | ≥80% L2 handoffs approved from mobile without opening desktop |
| Physical P1 | 1 edge node completes handoff with hub in lab setup |
| Physical P2 | Zero L3 actuation without double approval in test suite |
| Voice M4 | 5 standard voice commands with ≥90% correct intent |

---

## Related documents

| Document | Relationship |
|----------|--------------|
| [ARCHITECTURE.md](../../ARCHITECTURE.md) | Current PtyHub, handoff, runtime design |
| [EXTENSIONS_ROADMAP.md](./EXTENSIONS_ROADMAP.md) | IDE/Hermes/OpenClaw hosts — Phase 0–6 sequence |
| [PROGRAMMATIC_API.md](../guides/PROGRAMMATIC_API.md) | REST/WS reused by mobile |
| [SECURITY.md](../guides/SECURITY.md) | Token, bind localhost, threat model |
| [MULTI_INSTANCE.md](../guides/MULTI_INSTANCE.md) | Board isolation per cwd |
| [HERMES_TUI_IMPLEMENTATION_PLAN.md](../archive/HERMES_TUI_IMPLEMENTATION_PLAN.md) | Multi-runtime pattern (Pi/Hermes) — ✅ completed |

---

## Revision history

| Date | Author | Change |
|------|--------|--------|
| 2026-07-01 | Emanuele + OpenClaw | First draft — mobile companion + physical runtime + voice + sequence |
