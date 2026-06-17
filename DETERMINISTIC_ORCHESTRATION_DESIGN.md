# Deterministic Orchestration — Design Plan

> Status: **IMPLEMENTED** on branch `feat/deterministic-orchestration`. Every
> claim about the `pi` extension API is grounded in the installed
> `@earendil-works/pi-coding-agent@0.79.4` type definitions (paths cited).
>
> **Deviations from this spec, added during implementation for correctness and
> robustness (the §-by-§ body below still describes the original turn_end plan):**
> 1. **Enforce on `agent_end`, not `turn_end`.** In pi a "turn" is one iteration
>    of the agent loop (a model call + its tools); `turn_end` fires mid-work, so
>    a watchdog there false-fires while the agent is still reading files. The
>    check now runs on `agent_end` — once, when the agent is truly done.
> 2. **Explicit intent via `@@DONE`.** Ending is no longer *inferred* from the
>    absence of a handoff. A node must end with an explicit `@@HANDOFF` **or**
>    `@@DONE`. A pipeline node (non-final, or final-with-outgoing-edges) that
>    ends with neither is asked to choose (capped). A non-final node that writes
>    `@@DONE` is rejected. A pure leaf may end freely.
> 3. **Per-node watchdog toggle.** The check can be disabled per node (shield
>    icon / WS `set_enforcement` / env `PINODES_ORCHESTRA_ENFORCE`) for free
>    chat; handoffs/cards still deliver while off. Read per loop via
>    `orchestra-context.enforce`.
> 4. **Anti-accumulation sentinel.** The per-loop appendix is wrapped in
>    `<!--orchestra:appendix-->…<!--/orchestra:appendix-->` and stripped before
>    re-appending, so it never accumulates whether pi rebuilds the system prompt
>    from the base each loop or feeds back the previously-modified one.
> 5. **Loop-proof confirm counter.** `confirmAttempts` is reset in
>    `before_agent_start` only when the prompt does **not** carry the
>    `[orchestra:confirm]` tag — i.e. only for a genuine new task — so the retry
>    cap always engages even if the confirm spawns a new loop.
>
> See `ARCHITECTURE.md` (Handoff protocol → Explicit intent) and
> `docs/PROGRAMMATIC_API.md` (internal endpoints) for user-facing docs.

## TL;DR

Today the orchestra's handoff layer is **advisory, not enforced**: an agent can
end its turn without handing off even when `canBeFinal=false`, the system-prompt
appendix (who you may hand off to) is **frozen at spawn** and then patched by
**typing into the PTY** — which pi interprets as a *user task* and starts
"elaborating" on it. That is the root cause of the "wiring two nodes makes the
second one start working" behavior the author observed.

This plan makes orchestration **deterministic** without touching the product
thesis (visual canvas of live pi terminals, text-based `@@HANDOFF`, human-in-the-
loop typing). It does so by moving the orchestration context off the PTY-typing
channel and onto two **native pi extension hooks** that the installed CLI already
exposes:

1. `before_agent_start` → **replace the system prompt per turn** so the
   recipient list / finality rule are always current (no PTY typing needed).
2. `turn_end` → **watchdog**: if `canBeFinal=false` and the agent emitted **zero
   valid handoffs to connected nodes**, steer it to retry, capped at N attempts.

The determinism rule, stated formally:

> **A node with `canBeFinal === false` MUST emit at least one `@@HANDOFF` block
> targeting a node reachable via one of its outgoing edges. It MAY emit more
> than one (fan-out / parallel handoff). If it emits zero, the system steers it
> to retry; after a bounded number of retries the node is marked `error` and the
> user is notified on the card.**

A node with `canBeFinal === true` may still end the chain silently (unchanged).

---

## 1. Problem statement (observed behavior)

- The author spawns nodes; pi lights up. They wire an edge between two nodes.
- The already-running source node receives a "connection update" message and
  **starts elaborating as if it were a task**, because the update is delivered by
  typing text into the pi PTY (`PtyHub.inject` → bracketed paste → pi reads it as
  a user message → agent loop fires).
- An agent with `canBeFinal=false` can finish a turn with no `@@HANDOFF` block
  and the pipeline silently dies. Nothing enforces the rule.
- The system-prompt appendix (recipients, handles, finality, kanban) is baked at
  spawn (`PtyHub.connectionsAppendix`), so any graph edit after boot is invisible
  to the agent unless the backend types a "notify" message into the PTY — which
  again triggers elaboration.

## 2. Root causes (with file:line references)

| # | Root cause | Location |
|---|------------|----------|
| C1 | Orchestration context is delivered by **PTY typing**, which pi treats as a user task | `backend/src/pty/PtyHub.ts:478` (`notifyFinalityChange`), `:487` (`notifyConnectionsChange`), `:536` (`inject`) |
| C2 | System-prompt appendix is **frozen at spawn**; live edits require C1 to propagate | `backend/src/pty/PtyHub.ts:315` (`spawn` → `connectionsAppendix`) |
| C3 | No enforcement that a non-final node hands off; `turn_end` only *parses* handoffs, never *requires* them | `backend/pi-extensions/call-agent.ts:45` |
| C4 | Handoff delivery `fetch` swallows errors silently; a transient backend blip loses the handoff | `backend/pi-extensions/call-agent.ts:91` (`catch {}`) |
| C5 | Inject timing is a guessed `setTimeout(3000 - age)`; on slow boot it races, on fast boot it needlessly waits | `backend/src/pty/PtyHub.ts:523` |
| C6 | `delivered` / `movedTo` Sets grow for the whole session (minor leak) | `backend/pi-extensions/call-agent.ts:42` |
| C7 | Graph allows `canBeFinal=false` with **zero outgoing edges** — a contradictory state the agent can never satisfy | `backend/src/orchestra/BoardManager.ts:190` (`updateNode`) / `:239` (`addEdge` deletion path) |

## 3. pi extension API findings (facts, not assumptions)

All references are from the installed `pi-coding-agent@0.79.4` type definitions.

### 3.1 The system prompt is mutable **per turn**

`AgentHarness.systemPrompt` is `private` and set only in the constructor
(`.../pi-agent-core/dist/harness/agent-harness.d.ts:13`), so it is **immutable
in place after spawn**. However the `before_agent_start` event lets an extension
**replace it for each turn**:

```ts
// .../pi-coding-agent/dist/core/extensions/types.d.ts:491
export interface BeforeAgentStartEvent {
  type: "before_agent_start";
  prompt: string;
  images?: ImageContent[];
  /** The fully assembled system prompt string. */
  systemPrompt: string;
  systemPromptOptions: BuildSystemPromptOptions;
}

// .../pi-coding-agent/dist/core/extensions/types.d.ts:760
export interface BeforeAgentStartEventResult {
  message?: Pick<CustomMessage, "customType" | "content" | "display" | "details">;
  /** Replace the system prompt for this turn. If multiple extensions return
   *  this, they are chained. */
  systemPrompt?: string;
}
```

`pi` reassembles `event.systemPrompt` each turn from the base `--system-prompt`
value plus loaded resources, so an extension can **append a fresh appendix every
turn without accumulation**. This is the key enabler.

### 3.2 Steering vs. user task

The extension API exposes three delivery modes for injecting text
(`.../pi-coding-agent/dist/core/extensions/types.d.ts:867`):

```ts
sendUserMessage(content: string | (TextContent | ImageContent)[], options?: {
  deliverAs?: "steer" | "followUp";
}): void;
```

`deliverAs: "steer"` queues the text as **steering context** (guidance the agent
considers mid-stream) — not as a brand-new user task that resets the work. The
harness has a dedicated `steerQueue` and `steeringQueueMode`
(`.../pi-agent-core/dist/harness/agent-harness.d.ts:19`, `:50`). This is exactly
what we want for the watchdog nudge: *"you must hand off, here are your
recipients"* — guidance, not a job.

### 3.3 `turn_end` carries the full assistant message

```ts
// .../pi-coding-agent/dist/core/extensions/types.d.ts:518
export interface TurnEndEvent {
  type: "turn_end";
  turnIndex: number;
  message: AgentMessage;
  toolResults: ToolResultMessage[];
}
```

Already used by the current `call-agent.ts` to parse `@@HANDOFF`. We will extend
it with the watchdog.

### 3.4 `session_start` fires once on boot

Available as `on(event: "session_start", ...)` (`types.d.ts:811`). We will use it
as the **ready marker** so the backend stops guessing boot time with
`setTimeout`.

### 3.5 Custom tool registration is NOT required

`ExtensionAPI.registerTool` exists (`types.d.ts:840`), but we deliberately keep
handoff as **text parsing** so it works on any provider, including Cursor
composer, which does not expose extension tools to the model. This is the
product thesis and we preserve it.

---

## 4. Design goals

**Preserve (do not touch):**
- Visual canvas of live pi terminals; human typing into any node.
- `@@HANDOFF:<handle>` / `@@END` text protocol (provider-agnostic).
- `@@CARD:<column>` Kanban protocol.
- PtyHub spawn / kill / resize / scrollback / mirror-read-only-without-resize.
- Multi-board + embedded host (VS Code) model.
- Fastify + WS + SQLite + node-pty + React + xyflow + xterm + Zustand stack.

**Fix:**
- F1 — Orchestration context travels via system-prompt-per-turn, not PTY typing.
- F2 — `canBeFinal=false` ⇒ ≥1 valid handoff enforced; fan-out (>1) allowed.
- F3 — Ready-gated inject instead of `setTimeout(3000 - age)`.
- F4 — Handoff delivery retry + backoff; no silent loss.
- F5 — Graph rejects `canBeFinal=false` with zero outgoing edges.
- F6 — Per-turn Sets are cleared between turns (no session leak).

---

## 5. The determinism rule (formal)

Let `node.n.outgoing` = nodes reachable via `node`'s outgoing edges.
Let `emitted` = set of `@@HANDOFF` blocks in the turn's assistant message.
Let `delivered` = subset of `emitted` whose target resolved to an outgoing node
  (backend `deliverCall` returned `ok:true`).

| `canBeFinal` | `\|outgoing\|` | `\|delivered\|` | Action |
|--------------|---------------|------------------|--------|
| `true`       | any           | any (0+ valid)   | Allow. Chain may end or continue. (unchanged) |
| `false`      | `0`           | —                | **Rejected at graph-edit time** (F5). At runtime, treat as `true` + warn the user. |
| `false`      | `>0`          | `0`              | **Steer retry** (watchdog). After `MAX_STEER_RETRIES` → mark node `error`, notify card. |
| `false`      | `>0`          | `≥1`             | Allow. Fan-out (`>1`) is permitted and encouraged for parallel work. |

`MAX_STEER_RETRIES` proposed = **2** (one natural attempt + two steers = three
chances total). Configurable via env `PINODES_ORCHESTRA_MAX_STEER_RETRIES`.

The rule is enforced **in the extension** (per turn, with the turn's context
already fetched for the system-prompt refresh), not in the backend, so it is
deterministic regardless of backend reachability: if the context fetch failed,
the extension falls back to the spawn-time baked appendix and still enforces the
rule using the baked `canBeFinal` / outgoing list.

---

## 6. Architecture overview (before / after)

### 6.1 Before

```
 graph edit  ──► PtyHub.setGraph ──► notifyConnectionsChange ──► inject(PTY typing)
                                                                   │
                                                                   ▼
                                                          pi reads as USER TASK
                                                          agent loop fires ❌
                                                          ("starts elaborating")

 spawn ──► connectionsAppendix baked into --system-prompt (frozen)

 turn_end ──► parse @@HANDOFF ──► fetch /internal/call-agent (catch {} silent)

 injectTask ──► scheduleInject ──► setTimeout(3000 - age) ──► inject
```

### 6.2 After

```
 graph edit ──► PtyHub.setGraph ──► (just update the graph + kill removed PTYs)
                                   no PTY typing, no notify* methods ✅

 spawn ──► role prompt only into --system-prompt
           + env PINODES_ORCHESTRA_FALLBACK_APPENDIX (baked snapshot for degrade)

 every turn:
   before_agent_start ──► GET /internal/orchestra-context
        │                     │
        │                     ▼
        │               { appendix, canBeFinal, outgoing, kanban }
        │                     │
        ▼                     ▼
   return { systemPrompt: event.systemPrompt + data.appendix }   ✅ fresh per turn
   (on fetch failure) return { systemPrompt + FALLBACK_APPENDIX }  ✅ graceful degrade

 turn_end ──► parse @@HANDOFF[] ──► POST each /internal/call-agent (retry+backoff)
        │
        ├── delivered ≥1 (and canBeFinal false)  ──► OK ✅
        ├── delivered  0 & canBeFinal false      ──► pi.sendUserMessage(steer) ⛳ retry
        │                                            (cap MAX_STEER_RETRIES)
        └── after cap   ──► POST /internal/handoff-failed ──► node_status=error ✅

 session_start ──► POST /internal/ready ──► PtyHub flushes pending inject ✅
                                            (fallback timeout 10s if no extension)
```

---

## 7. Component-by-component design

### 7.A — Per-turn system-prompt refresh

#### 7.A.1 New backend endpoint: `GET /internal/orchestra-context`

Read-only, fast (localhost, ~2 ms), no auth (internal only, same as existing
`/internal/call-agent`). Returns **the rendered appendix string** so the
rendering logic stays in one place (`PtyHub`), not duplicated in the extension.

**Request:** `GET /internal/orchestra-context?boardId=<id>&nodeId=<id>`

**200 Response:**
```jsonc
{
  "boardId": "...",
  "nodeId": "...",
  "appendix": "\n\n## Orchestration — you are one link ...\n@@HANDOFF:...\n@@END\n",
  "canBeFinal": false,
  "outgoing": [
    { "id": "uuid", "handle": "developer-1", "label": "Developer" },
    { "id": "uuid", "handle": "qa-1",        "label": "QA" }
  ],
  "kanban": false,
  "sessionId": "board-node"
}
```

**404** if board/node unknown → extension falls back to baked appendix.

The `appendix` field is produced by the **same** `connectionsAppendix` +
`kanbanAppendix` methods of `PtyHub`, refactored to be callable without a
running session (they already only need the graph, not the session). The `outgoing`
array is the watchdog's source of truth for "valid targets".

#### 7.A.2 `PtyHub` changes

- `spawn`: the system prompt passed via `--system-prompt` becomes **the role
  prompt only** (no appendix). The appendix is injected per turn by the
  extension. To preserve graceful degrade when the extension cannot reach the
  backend, `spawn` also sets env `PINODES_ORCHESTRA_FALLBACK_APPENDIX` to the
  rendered appendix at spawn time.

```ts
// backend/src/pty/PtyHub.ts — spawn() change (illustrative)
private spawn(boardId: string, nodeId: string, cols: number, rows: number): void {
  const graph = this.graphs.get(boardId);
  const node = graph?.nodes.get(nodeId);
  const cwd = graph?.cwd && fs.existsSync(graph.cwd) ? graph.cwd : process.cwd();

  const rolePrompt = node
    ? (node.promptOverride?.trim() || getPrompt(node.promptId)?.content || "").trim()
    : "";

  // Appendix is NO LONGER baked into --system-prompt; it is refreshed per turn
  // by the extension via /internal/orchestra-context. We still bake a fallback
  // so the extension can degrade gracefully if the backend is briefly unreachable.
  const fallbackAppendix =
    this.connectionsAppendix(boardId, nodeId) +
    (this.kanbanBoards.has(boardId) ? this.kanbanAppendix() : "");

  const args = [
    ...this.cmd.baseArgs,
    "--tools", "read,bash,edit,write,grep",
    "--session-id", `${boardId}-${nodeId}`.replace(/[^a-zA-Z0-9-]/g, ""),
    "--name", node?.label ?? "pi",
    "--system-prompt", rolePrompt,            // <-- role only, no appendix
    // extension path pushed below if present
  ];
  if (fs.existsSync(EXTENSION_PATH)) args.push("--extension", EXTENSION_PATH);

  const term = pty.spawn(this.cmd.file, args, {
    name: "xterm-256color", cols, rows, cwd,
    env: {
      ...process.env,
      PINODES_ORCHESTRA_URL: BASE_URL,
      PINODES_ORCHESTRA_BOARD: boardId,
      PINODES_ORCHESTRA_NODE: nodeId,
      PINODES_ORCHESTRA_FALLBACK_APPENDIX: fallbackAppendix,  // <-- new
    } as Record<string, string>,
  });
  // ... rest unchanged (session, onData, onExit) ...
}
```

- **Delete** `notifyFinalityChange`, `notifyConnectionsChange`,
  `connectionSig`, `outgoingSignature`, and the two live-sync loops in
  `setGraph` (the `for (const [id, node] of nodes)` finality-diff block and the
  outgoing-signature-diff block). `setGraph` becomes: store graph, kill PTYs of
  removed nodes, spawn pending. ~60 lines removed. The information those blocks
  pushed by PTY typing is now pulled by the extension per turn.

```ts
// backend/src/pty/PtyHub.ts — setGraph() simplified (illustrative)
setGraph(boardId: string, graph: WorkflowGraph, cwd: string): void {
  const prev = this.graphs.get(boardId);
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  this.graphs.set(boardId, { cwd, nodes, edges: graph.edges ?? [] });
  // (finality/connection live-sync removed — context is now per-turn via extension)

  // Kill terminals of removed nodes (unchanged)
  for (const k of [...this.sessions.keys()]) {
    const [b, nodeId] = k.split(":");
    if (b === boardId && !nodes.has(nodeId)) this.kill(boardId, nodeId);
  }
  // Spawn pending terminals now that the graph arrived (unchanged)
  for (const [k, size] of [...this.pending]) {
    const [b, nodeId] = k.split(":");
    if (b === boardId && nodes.has(nodeId)) {
      this.pending.delete(k);
      this.spawn(boardId, nodeId, size.cols, size.rows);
      if (size.message) this.scheduleInject(boardId, nodeId, size.message);
    }
  }
}
```

- **Expose** `connectionsAppendix`, `kanbanAppendix`, `outgoingTargets`,
  `handles`, `canBeFinal` via a single public method used by the new route:

```ts
// backend/src/pty/PtyHub.ts — new public read method
orchestraContext(boardId: string, nodeId: string): {
  appendix: string;
  canBeFinal: boolean;
  outgoing: Array<{ id: string; handle: string; label: string }>;
  kanban: boolean;
} | null {
  const graph = this.graphs.get(boardId);
  if (!graph || !graph.nodes.has(nodeId)) return null;
  const outgoing = this.outgoingTargets(boardId, nodeId).map((t) => ({
    id: t.id,
    handle: this.handles(boardId).get(t.id) ?? t.label,
    label: t.label,
  }));
  return {
    appendix:
      this.connectionsAppendix(boardId, nodeId) +
      (this.kanbanBoards.has(boardId) ? this.kanbanAppendix() : ""),
    canBeFinal: this.canBeFinal(boardId, nodeId),
    outgoing,
    kanban: this.kanbanBoards.has(boardId),
  };
}
```

#### 7.A.3 `call-agent.ts` — `before_agent_start` handler

```ts
// backend/pi-extensions/call-agent.ts — new (illustrative, full file in §9)
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BASE_URL = process.env.PINODES_ORCHESTRA_URL ?? "http://localhost:3847";
const BOARD_ID = process.env.PINODES_ORCHESTRA_BOARD ?? "";
const NODE_ID  = process.env.PINODES_ORCHESTRA_NODE  ?? "";
const FALLBACK = process.env.PINODES_ORCHESTRA_FALLBACK_APPENDIX ?? "";
const MAX_STEER_RETRIES = Number(process.env.PINODES_ORCHESTRA_MAX_STEER_RETRIES ?? 2);

const HANDOFF_RE = /@@HANDOFF:\s*([^\s\n]+)\s*\n([\s\S]*?)@@END/g;
const CARD_RE    = /@@CARD:\s*([^\s\n]+)/g;

interface OrchestraContext {
  appendix: string;
  canBeFinal: boolean;
  outgoing: Array<{ id: string; handle: string; label: string }>;
  kanban: boolean;
}

// Per-turn state: fetched once in before_agent_start, reused in turn_end.
let turnCtx: OrchestraContext | null = null;
let steerAttempts = 0;

async function fetchCtx(): Promise<OrchestraContext | null> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 1500);
  try {
    const res = await fetch(
      `${BASE_URL}/internal/orchestra-context?boardId=${encodeURIComponent(BOARD_ID)}&nodeId=${encodeURIComponent(NODE_ID)}`,
      { signal: ac.signal, headers: { "cache-control": "no-store" } },
    );
    if (!res.ok) return null;
    return (await res.json()) as OrchestraContext;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export default function handoffExtension(pi: ExtensionAPI) {
  // Ready marker: tell the backend this pi is booted so pending injects flush.
  pi.on("session_start", async () => {
    try {
      await fetch(`${BASE_URL}/internal/ready`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ boardId: BOARD_ID, nodeId: NODE_ID }),
      }),
    } catch { /* best-effort */ }
  });

  // Per-turn system-prompt refresh.
  pi.on("before_agent_start", async (event) => {
    turnCtx = await fetchCtx();
    const appendix = turnCtx?.appendix ?? FALLBACK;
    // event.systemPrompt is the role prompt pi assembled this turn; append fresh.
    return { systemPrompt: event.systemPrompt + appendix };
  });

  // Reset steer counter at the start of every turn.
  pi.on("turn_start", () => { steerAttempts = 0; });

  pi.on("turn_end", async (event) => {
    const message = (event as { message?: unknown }).message;
    if ((message as { role?: string } | null)?.role !== "assistant") return;
    const text = messageText(message);

    // @@CARD moves (unchanged, but moved before handoff logic)
    deliverCards(text);

    // @@HANDOFF delivery with retry+backoff; count successes.
    const delivered = await deliverHandoffs(text);

    // Determinism watchdog.
    enforceDeterminism(pi, delivered);
  });
}
```

### 7.B — Deterministic handoff watchdog + fan-out

#### 7.B.1 The watchdog (in the extension)

```ts
// backend/pi-extensions/call-agent.ts — watchdog (illustrative)

async function enforceDeterminism(pi: ExtensionAPI, delivered: number): Promise<void> {
  const ctx = turnCtx;
  if (!ctx) return;                       // no context → don't enforce (degrade)
  if (ctx.canBeFinal) return;             // final-capable node may end the chain
  if (ctx.outgoing.length === 0) return;  // contradictory state; F5 prevents at edit time

  if (delivered >= 1) return;             // ✅ at least one valid handoff happened

  // Fan-out is allowed: delivered may be >1; we only require ≥1.
  if (steerAttempts >= MAX_STEER_RETRIES) {
    // Give up deterministically: report to backend so the card shows error.
    try {
      await fetch(`${BASE_URL}/internal/handoff-failed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          boardId: BOARD_ID,
          nodeId: NODE_ID,
          reason: "no-handoff-after-retries",
          recipients: ctx.outgoing.map((o) => o.handle).join(", "),
        }),
      });
    } catch { /* best-effort */ }
    return;
  }

  steerAttempts += 1;
  const list = ctx.outgoing
    .map((o) => `- ${o.handle} — ${o.label}`)
    .join("\n");
  const nudge =
    `[orchestra] You are NOT allowed to end the chain: your work requires a ` +
    `downstream agent. You MUST hand off to at least one of the connected agents ` +
    `below (you may hand off to MORE than one if the work should run in parallel). ` +
    `Re-emit a @@HANDOFF block now for each recipient.\n\n` +
    `Agents you can hand off to (use the handle on the left as the recipient):\n${list}\n\n` +
    `Format (no backticks, no text after @@END):\n` +
    `@@HANDOFF:<recipient-handle>\n<complete, self-contained instructions>\n@@END`;

  // Steer = guidance, NOT a new user task. This is the crux of the fix.
  pi.sendUserMessage(nudge, { deliverAs: "steer" });
}
```

#### 7.B.2 Why `steer` and not `inject` (PTY typing)

`pi.sendUserMessage(..., { deliverAs: "steer" })` enqueues into pi's
**steering queue** (`AgentHarness.steerQueue`), which pi presents as in-flight
guidance to the running agent — it does **not** create a fresh user task that
resets the work. The old `PtyHub.inject` path typed into the PTY, so pi read it
as a brand-new user message and kicked off the agent loop from scratch
("started elaborating"). Steering is the deterministic, non-disruptive channel.

#### 7.B.3 Fan-out (multi-handoff) is already mechanically supported

The current `call-agent.ts` already loops over **all** `@@HANDOFF` matches and
POSTs each to `/internal/call-agent` independently. `PtyHub.deliverCall` resolves
each target against the sender's outgoing neighbours separately. So an agent
that writes:

```
@@HANDOFF:developer-1
<instructions for dev branch A>
@@END

@@HANDOFF:developer-2
<instructions for dev branch B>
@@END
```

already delivers to both `developer-1` and `developer-2`. The watchdog
explicitly **permits** `delivered > 1` and only requires `delivered >= 1` when
`canBeFinal=false`. No change to `deliverCall` is needed for fan-out; we only
hardten the delivery path (retry/backoff, §7.D) and count successes.

#### 7.B.4 Counting successes

`deliverHandoffs` must distinguish "the backend accepted and resolved the
target" (ok:true) from "the recipient was invalid / edge missing" (ok:false).
Today the extension fires-and-forgets; we make it `await` and count.

```ts
// backend/pi-extensions/call-agent.ts — delivery with retry + success count
async function deliverHandoffs(text: string): Promise<number> {
  HANDOFF_RE.lastIndex = 0;
  const delivered = new Set<string>();   // dedup by signature within the turn
  let successCount = 0;
  let match: RegExpExecArray | null;
  while ((match = HANDOFF_RE.exec(text)) !== null) {
    const targetNodeId = match[1].trim().replace(/^["']|["']$/g, "");
    const taskMessage = match[2].trim();
    if (!targetNodeId || !taskMessage) continue;
    const sig = `${targetNodeId}::${taskMessage}`;
    if (delivered.has(sig)) continue;
    delivered.add(sig);

    const ok = await postWithRetry(
      `${BASE_URL}/internal/call-agent`,
      { boardId: BOARD_ID, fromNodeId: NODE_ID, targetNodeId, message: taskMessage },
      3, 250, // 3 attempts, 250ms initial backoff (doubles)
    );
    if (ok) successCount += 1;
  }
  return successCount;
}

async function postWithRetry(
  url: string, body: unknown, attempts: number, backoffMs: number,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && (data as { ok?: boolean }).ok) return true;
      // ok:false means the backend rejected (bad recipient) — don't retry, it's deterministic.
      if (res.ok && !(data as { ok?: boolean }).ok) return false;
    } catch { /* network blip → retry */ }
    if (i < attempts - 1) await sleep(backoffMs * 2 ** i);
  }
  return false;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
```

Note: `ok:false` from `deliverCall` (unresolvable recipient) is **not** retried —
it is a deterministic rejection, and the existing nudge-to-sender path in
`PtyHub.deliverCall` already injects a correction. The watchdog's steer will
also fire (since `successCount === 0`), giving the agent a consolidated
"here are your valid handles" message. The two nudges are complementary and
idempotent within a turn because `deliverCall`'s nudge is sent to the **same**
sender and arrives as context for the steer-driven retry.

### 7.C — Ready-gated inject (replaces `setTimeout(3000 - age)`)

#### 7.C.1 Backend side

`PtyHub` gains a per-node ready flag and a queue of waiting injects:

```ts
// backend/src/pty/PtyHub.ts — ready gating (illustrative)
private ready = new Map<string, true>();                       // boardId:nodeId -> ready
private waitingInjects = new Map<string, string[]>();          // boardId:nodeId -> messages

/** Called by POST /internal/ready (extension session_start). */
markReady(boardId: string, nodeId: string): void {
  const k = key(boardId, nodeId);
  this.ready.set(k, true);
  const queued = this.waitingInjects.get(k);
  if (queued) {
    this.waitingInjects.delete(k);
    // Inject immediately now that pi is booted and ready.
    for (const msg of queued) this.inject(boardId, nodeId, msg);
  }
}

private scheduleInject(boardId: string, nodeId: string, message: string): void {
  this.ensure(boardId, nodeId, 80, 24);
  const k = key(boardId, nodeId);
  if (this.ready.has(k)) {                 // already booted → inject now
    this.inject(boardId, nodeId, message);
    return;
  }
  // Not ready yet → queue; flushed on markReady or on fallback timeout.
  const q = this.waitingInjects.get(k) ?? [];
  q.push(message);
  this.waitingInjects.set(k, q);
  // Fallback: if the extension never reports ready (old pi, extension load
  // failure), inject after a conservative timeout so we never drop a task.
  setTimeout(() => {
    if (this.ready.has(k)) return;          // already handled
    const pending = this.waitingInjects.get(k);
    if (!pending) return;
    this.waitingInjects.delete(k);
    for (const msg of pending) this.inject(boardId, nodeId, msg);
  }, 10_000);
}
```

`spawn` should `ready.delete(k)` and `waitingInjects.delete(k)` so a restart
re-gates correctly. `kill`/`killBoard` also clear them.

#### 7.C.2 Route

```ts
// backend/src/index.ts — new internal route (illustrative)
app.post("/internal/ready", async (req) => {
  const { boardId, nodeId } = req.body as { boardId: string; nodeId: string };
  ptyHub.markReady(boardId, nodeId);
  return { ok: true };
});
```

#### 7.C.3 Why this is better than the timer

- Fast boot → inject fires at `session_start` (sub-second) instead of waiting 3s.
- Slow boot → inject waits for the real ready signal instead of racing at 3s.
- No extension → 10s conservative fallback (still better than a wrong 3s guess
  that types into a not-yet-ready pi and loses the first task).

### 7.D — Handoff retry + backoff

Covered in §7.B.4 (`postWithRetry`). Also applied to `@@CARD` posts:

```ts
// backend/pi-extensions/call-agent.ts — card delivery (illustrative)
async function deliverCards(text: string): Promise<void> {
  CARD_RE.lastIndex = 0;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = CARD_RE.exec(text)) !== null) {
    const column = m[1].trim().replace(/^["']|["']$/g, "");
    if (!column || seen.has(column)) continue;
    seen.add(column);
    await postWithRetry(
      `${BASE_URL}/internal/card-status`,
      { boardId: BOARD_ID, column },
      3, 250,
    );
  }
}
```

The per-turn `seen` Set replaces the session-long `movedTo` Set (F6: leak fix).

### 7.E — Graph validation: reject `canBeFinal=false` with zero outgoing

Enforced in `BoardManager` at edit time so the contradictory state never reaches
a running agent. Three edit points: `updateNode`, `addEdge` (deletion path
indirectly via `deleteEdge`), and `deleteNode` (which may orphan the node's
finality). The cleanest single chokepoint is `setGraph`, since every CRUD path
already funnels through it.

```ts
// backend/src/orchestra/BoardManager.ts — validation (illustrative)
private validateGraph(graph: WorkflowGraph): void {
  const outCount = new Map<string, number>();
  for (const e of graph.edges) {
    outCount.set(e.sourceNodeId, (outCount.get(e.sourceNodeId) ?? 0) + 1);
  }
  for (const n of graph.nodes) {
    if (n.canBeFinal === false && (outCount.get(n.id) ?? 0) === 0) {
      throw new Error(
        `Node "${n.label}" is marked non-final (canBeFinal=false) but has no ` +
        `outgoing edges — it can neither end the chain nor hand off. Connect it ` +
        `to at least one downstream node, or set canBeFinal=true.`,
      );
    }
  }
}

setGraph(boardId: string, graph: WorkflowGraph): BoardState {
  this.validateGraph(graph);                 // <-- new, single chokepoint
  const board = this.boards.get(boardId);
  // ... rest unchanged ...
}
```

This covers `addNode`, `updateNode`, `deleteNode`, `addEdge`, `deleteEdge` —
all of them call `setGraph`. The error propagates to the REST layer, which
already maps `Error.message` to a 400 body (`routes/orchestra.ts` pattern).

### 7.F — New backend route: `POST /internal/handoff-failed`

So the watchdog's give-up signal surfaces on the node card as `error` state:

```ts
// backend/src/index.ts — new internal route (illustrative)
app.post("/internal/handoff-failed", async (req) => {
  const { boardId, nodeId, reason, recipients } = req.body as {
    boardId: string; nodeId: string; reason: string; recipients?: string;
  };
  ptyHub.notify({
    type: "node_status",
    boardId,
    nodeId,
    status: "error",
    message:
      `Handoff not completed after retries (${reason}). ` +
      `Expected recipient(s): ${recipients ?? "(none connected)"}.`,
  });
  return { ok: true };
});
```

The frontend already renders per-node error messages inline
(`ARCHITECTURE.md:39`), so no frontend change is required for the card to show
it. (A future, optional `HandoffLog` panel — see §11 — would also consume this
event.)

---

## 8. Data contracts (new endpoints)

| Method | Path | Body / Query | Response | Purpose |
|--------|------|--------------|----------|---------|
| `GET`  | `/internal/orchestra-context` | `?boardId=&nodeId=` | `{ appendix, canBeFinal, outgoing[], kanban }` or 404 | Per-turn system-prompt refresh + watchdog truth source |
| `POST` | `/internal/ready` | `{ boardId, nodeId }` | `{ ok }` | Ready marker; flushes queued injects |
| `POST` | `/internal/handoff-failed` | `{ boardId, nodeId, reason, recipients? }` | `{ ok }` | Watchdog give-up → node card error |

All three are **internal** (localhost extension → backend), consistent with the
existing `/internal/call-agent` and `/internal/card-status` routes. Auth: none
(same as the existing internal routes); if `PINODES_ORCHESTRA_TOKEN` is set, the
extension should send it — see §10.

---

## 9. Full example: new `call-agent.ts`

```ts
/**
 * pinodes-orchestra · deterministic handoff extension
 *
 * Three responsibilities:
 *  1. before_agent_start → refresh the orchestration appendix in the system
 *     prompt every turn (recipients, finality, kanban) by fetching
 *     /internal/orchestra-context. Falls back to a spawn-time baked appendix
 *     if the backend is briefly unreachable.
 *  2. turn_end → deliver @@HANDOFF and @@CARD blocks to the backend with
 *     retry+backoff, then enforce the determinism rule: a non-final node must
 *     hand off to at least one connected agent (more than one is allowed).
 *  3. session_start → tell the backend this pi is ready so queued injects fire
 *     immediately instead of on a guessed timer.
 *
 * Text-protocol (not a custom tool) so it works on ANY provider, including
 * Cursor composer, which does not expose extension tools to the model.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BASE_URL = process.env.PINODES_ORCHESTRA_URL ?? "http://localhost:3847";
const BOARD_ID = process.env.PINODES_ORCHESTRA_BOARD ?? "";
const NODE_ID  = process.env.PINODES_ORCHESTRA_NODE  ?? "";
const TOKEN    = process.env.PINODES_ORCHESTRA_TOKEN ?? "";
const FALLBACK = process.env.PINODES_ORCHESTRA_FALLBACK_APPENDIX ?? "";
const MAX_STEER_RETRIES = Number(process.env.PINODES_ORCHESTRA_MAX_STEER_RETRIES ?? 2);

const HANDOFF_RE = /@@HANDOFF:\s*([^\s\n]+)\s*\n([\s\S]*?)@@END/g;
const CARD_RE    = /@@CARD:\s*([^\s\n]+)/g;

interface OrchestraContext {
  appendix: string;
  canBeFinal: boolean;
  outgoing: Array<{ id: string; handle: string; label: string }>;
  kanban: boolean;
}

let turnCtx: OrchestraContext | null = null;
let steerAttempts = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const authHeaders = TOKEN ? { "x-pinodes-orchestra-token": TOKEN } : {};

function messageText(message: unknown): string {
  const content = (message as { content?: unknown } | null)?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p): p is { type: string; text?: string } => Boolean(p) && typeof p === "object")
      .map((p) => (p.type === "text" ? p.text ?? "" : ""))
      .join("");
  }
  return "";
}

async function fetchCtx(): Promise<OrchestraContext | null> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 1500);
  try {
    const res = await fetch(
      `${BASE_URL}/internal/orchestra-context?boardId=${encodeURIComponent(BOARD_ID)}&nodeId=${encodeURIComponent(NODE_ID)}`,
      { signal: ac.signal, headers: { "cache-control": "no-store", ...authHeaders } },
    );
    if (!res.ok) return null;
    return (await res.json()) as OrchestraContext;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function postWithRetry(
  url: string, body: unknown, attempts: number, backoffMs: number,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && (data as { ok?: boolean }).ok) return true;
      if (res.ok && !(data as { ok?: boolean }).ok) return false; // deterministic reject
    } catch { /* network blip → retry */ }
    if (i < attempts - 1) await sleep(backoffMs * 2 ** i);
  }
  return false;
}

async function deliverCards(text: string): Promise<void> {
  CARD_RE.lastIndex = 0;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = CARD_RE.exec(text)) !== null) {
    const column = m[1].trim().replace(/^["']|["']$/g, "");
    if (!column || seen.has(column)) continue;
    seen.add(column);
    await postWithRetry(`${BASE_URL}/internal/card-status`, { boardId: BOARD_ID, column }, 3, 250);
  }
}

async function deliverHandoffs(text: string): Promise<number> {
  HANDOFF_RE.lastIndex = 0;
  const delivered = new Set<string>();
  let successCount = 0;
  let match: RegExpExecArray | null;
  while ((match = HANDOFF_RE.exec(text)) !== null) {
    const targetNodeId = match[1].trim().replace(/^["']|["']$/g, "");
    const taskMessage = match[2].trim();
    if (!targetNodeId || !taskMessage) continue;
    const sig = `${targetNodeId}::${taskMessage}`;
    if (delivered.has(sig)) continue;
    delivered.add(sig);
    const ok = await postWithRetry(
      `${BASE_URL}/internal/call-agent`,
      { boardId: BOARD_ID, fromNodeId: NODE_ID, targetNodeId, message: taskMessage },
      3, 250,
    );
    if (ok) successCount += 1;
  }
  return successCount;
}

async function enforceDeterminism(pi: ExtensionAPI, delivered: number): Promise<void> {
  const ctx = turnCtx;
  if (!ctx || ctx.canBeFinal || ctx.outgoing.length === 0) return;
  if (delivered >= 1) return; // ✅ at least one valid handoff (fan-out allowed)

  if (steerAttempts >= MAX_STEER_RETRIES) {
    await postWithRetry(
      `${BASE_URL}/internal/handoff-failed`,
      {
        boardId: BOARD_ID, nodeId: NODE_ID,
        reason: "no-handoff-after-retries",
        recipients: ctx.outgoing.map((o) => o.handle).join(", "),
      },
      2, 250,
    );
    return;
  }
  steerAttempts += 1;
  const list = ctx.outgoing.map((o) => `- ${o.handle} — ${o.label}`).join("\n");
  const nudge =
    `[orchestra] You are NOT allowed to end the chain: your work requires a ` +
    `downstream agent. You MUST hand off to at least one of the connected agents ` +
    `below (you may hand off to MORE than one if the work should run in parallel). ` +
    `Re-emit a @@HANDOFF block now for each recipient.\n\n` +
    `Agents you can hand off to (use the handle on the left as the recipient):\n${list}\n\n` +
    `Format (no backticks, no text after @@END):\n` +
    `@@HANDOFF:<recipient-handle>\n<complete, self-contained instructions>\n@@END`;
  pi.sendUserMessage(nudge, { deliverAs: "steer" });
}

export default function handoffExtension(pi: ExtensionAPI) {
  pi.on("session_start", async () => {
    await postWithRetry(`${BASE_URL}/internal/ready`, { boardId: BOARD_ID, nodeId: NODE_ID }, 2, 250);
  });

  pi.on("before_agent_start", async (event) => {
    turnCtx = await fetchCtx();
    const appendix = turnCtx?.appendix ?? FALLBACK;
    return { systemPrompt: event.systemPrompt + appendix };
  });

  pi.on("turn_start", () => { steerAttempts = 0; });

  pi.on("turn_end", async (event) => {
    const message = (event as { message?: unknown }).message;
    if ((message as { role?: string } | null)?.role !== "assistant") return;
    const text = messageText(message);
    await deliverCards(text);
    const delivered = await deliverHandoffs(text);
    await enforceDeterminism(pi, delivered);
  });
}
```

---

## 10. Auth consideration

The existing `/internal/call-agent` and `/internal/card-status` routes are not
gated by `PINODES_ORCHESTRA_TOKEN` (the token check lives in the
`/api/v1/orchestra/*` route group only). The three new internal routes should
follow the same precedent (internal, localhost-only, no token) to keep the
extension simple. If a deployment exposes the backend remotely and sets a token,
the extension reads `PINODES_ORCHESTRA_TOKEN` from env (already injected by
`PtyHub.spawn`'s env spread) and sends it as `x-pinodes-orchestra-token`; the
internal routes may optionally enforce it. Recommended: keep internal routes
unauthenticated for parity, document the assumption "backend must not be
exposed on a non-loopback interface without a reverse proxy".

---

## 11. Optional, coherence-preserving extensions (not required for determinism)

These are listed because they were discussed and reinforce the product thesis
("visible handoffs"), but they are **separate** from the determinism work and
can be deferred:

- **Handoff log / timeline panel.** A new frontend view that renders the stream
  of handoffs (from → to, timestamp, message preview) by listening to a new WS
  event `handoff` emitted by `PtyHub.deliverCall`. Pure addition, no change to
  existing flows. The `handoff-failed` event (§7.F) also surfaces here.
- **Edge labels / guard conditions.** `@@HANDOFF:<handle> IF <condition>` —
  lets an edge carry a guard. Preserves the text protocol; `deliverCall`
  evaluates the guard against node/board state. Out of scope for this plan but
  the per-turn system-prompt refresh already makes the condition visible to the
  agent each turn.
- **CLI human-friendly default output** with `--json` for raw — aligns the CLI
  with the "figa da terminale" feel.

---

## 12. Edge cases & failure modes

| Scenario | Behavior |
|----------|----------|
| Backend down at `before_agent_start` | `fetchCtx` returns null → extension uses `FALLBACK` appendix (spawn-time snapshot). Watchdog uses fallback `canBeFinal`/`outgoing`? **No** — `turnCtx` is null → watchdog skips enforcement (degrade gracefully, do not falsely steer). The baked appendix still tells the agent who to hand off to. |
| Backend down at `turn_end` delivery | `postWithRetry` retries 3× then returns false → `successCount=0` → if `turnCtx` present and non-final, watchdog steers. If backend still down, the steer is local (pi steering queue) and the next turn retries the whole cycle. |
| Agent hands off to a non-connected target | `deliverCall` returns `ok:false` and nudges sender (existing). `postWithRetry` returns false (no retry on deterministic reject). Watchdog steers with valid handles. |
| Agent emits 3 handoffs to 3 valid targets | `successCount=3`; watchdog sees `≥1` → OK. Fan-out works. |
| `canBeFinal=false`, 0 outgoing (should be impossible) | F5 rejects at edit time. If it slips through (e.g. race), watchdog treats `outgoing.length===0` as "cannot enforce" and skips, avoiding a deadlock. |
| Extension absent (old pi, load failure) | No `before_agent_start` → spawn-time prompt has no appendix (we removed it!). **Mitigation:** keep a minimal appendix in `--system-prompt` when `EXTENSION_PATH` is missing, else rely on the ready-marker 10s fallback for inject. Detect via `fs.existsSync(EXTENSION_PATH)`. |
| Restart node | `spawn` clears `ready` + `waitingInjects` for the key; new `session_start` re-marks ready. |
| Multi-board | All endpoints keyed by `boardId:nodeId`; no cross-board leakage. |

---

## 13. Migration / impact on existing files

| File | Change | Est. delta |
|------|--------|------------|
| `backend/pi-extensions/call-agent.ts` | Rewrite per §9 (add `before_agent_start`, `session_start`, `turn_start`, watchdog, retry). | 96 → ~220 lines |
| `backend/pi-extensions/call-agent.test.ts` | New tests for context fetch, watchdog (all table rows of §5), retry, dedup. | +~180 lines |
| `backend/src/pty/PtyHub.ts` | Remove `notifyFinalityChange`, `notifyConnectionsChange`, `connectionSig`, `outgoingSignature`, two live-sync loops in `setGraph`. Add `orchestraContext()`, `markReady()`, `ready`/`waitingInjects` maps, ready-gated `scheduleInject`, fallback timeout. `spawn` bakes `PINODES_ORCHESTRA_FALLBACK_APPENDIX` and drops the appendix from `--system-prompt`. | net −30 lines |
| `backend/src/pty/PtyHub.test.ts` (new) | Tests for `orchestraContext`, ready-gating, `setGraph` no longer side-effecting notifications, kill clears ready. | +~150 lines |
| `backend/src/orchestra/BoardManager.ts` | Add `validateGraph` chokepoint in `setGraph`. | +~20 lines |
| `backend/src/orchestra/BoardManager.test.ts` | Tests for the 5 validation scenarios. | +~60 lines |
| `backend/src/index.ts` | Add 3 internal routes (`/internal/orchestra-context`, `/internal/ready`, `/internal/handoff-failed`). | +~30 lines |
| `backend/src/ws/handler.ts` | No change (WS protocol unchanged). | 0 |
| `backend/src/routes/orchestra.ts` | No change (REST CRUD unchanged). | 0 |
| `frontend/*` | No change required (node card already renders `error` + message). Optional HandoffLog panel is separate (§11). | 0 |
| `ARCHITECTURE.md` | Update "Handoff protocol", "User intervention", "WebSocket protocol" sections to reflect per-turn prompt + watchdog + ready marker. | docs |
| `docs/PROGRAMMATIC_API.md` | Document the 3 new internal endpoints. | docs |

No changes to: `cli.ts`, `db/index.ts`, `types.ts`, stores, `ptyBus`, xterm
components, VS Code extension. The WS protocol is unchanged; the REST CRUD is
unchanged.

---

## 14. Test plan

### 14.1 Unit (`call-agent.test.ts`)

- `before_agent_start`: returns `{ systemPrompt: base + appendix }` on fetch
  success; returns `{ systemPrompt: base + FALLBACK }` on fetch failure/timeout.
- `turn_end` handoff delivery: one valid → `successCount=1`; two valid (fan-out)
  → `successCount=2`; one invalid recipient → `successCount=0`, no retry on
  `ok:false`.
- `turn_end` watchdog table (every row of §5):
  - `canBeFinal=true`, 0 delivered → no steer.
  - `canBeFinal=false`, outgoing>0, 0 delivered, attempts<MAX → `sendUserMessage`
    called once with `{ deliverAs: "steer" }` and a nudge containing all handles.
  - `canBeFinal=false`, outgoing>0, 0 delivered, attempts≥MAX →
    `handoff-failed` POSTed, no steer.
  - `canBeFinal=false`, outgoing=0 → no steer, no failure (degrade).
  - `turnCtx=null` → no enforcement.
- `turn_start` resets `steerAttempts`.
- `session_start` POSTs `/internal/ready`.
- `postWithRetry`: succeeds on attempt 1; retries on network error; does **not**
  retry on `ok:false`; respects exponential backoff schedule (use fake timers).
- Dedup: identical `@@HANDOFF` signature twice in one turn → delivered once.

### 14.2 Unit (`PtyHub.test.ts`, new)

- `orchestraContext`: returns current appendix + outgoing + canBeFinal; null
  for unknown board/node.
- `markReady` flushes queued injects immediately; `scheduleInject` before ready
  queues and does not inject; fallback timeout injects after 10s if no ready.
- `setGraph` no longer calls any inject/notify (assert no `pty.write` with
  connection-update text); it still kills removed nodes and spawns pending.
- `spawn` sets `PINODES_ORCHESTRA_FALLBACK_APPENDIX` env and `--system-prompt`
  equals the role prompt only (no "## Orchestration" section).
- `kill`/`restart` clear `ready` + `waitingInjects`.

### 14.3 Unit (`BoardManager.test.ts`)

- `validateGraph` rejects `canBeFinal=false` + 0 outgoing with the exact error
  message; accepts `canBeFinal=false` + ≥1 outgoing; accepts `canBeFinal=true`
  regardless of outgoing.
- Rejection propagates through `addNode`, `updateNode`, `deleteNode`,
  `deleteEdge` (each must call `setGraph` and surface the error).

### 14.4 Integration (manual / `routes/orchestra.test.ts`)

- Spin a board with A(architect, canBeFinal=false) → B(developer) → C(qa).
  Inject a task into A; simulate A's `turn_end` with no `@@HANDOFF`; assert the
  extension steers A (a mock pi captures `sendUserMessage` calls); simulate a
  second `turn_end` still with no handoff; assert `/internal/handoff-failed`
  received and `node_status=error` broadcast.
- Same board, A emits `@@HANDOFF:developer-1` and `@@HANDOFF:qa-1` (fan-out):
  assert both delivered, no steer, no failure.
- Wire an edge after A is already running; assert A's **next** turn's
  `before_agent_start` returns a system prompt containing the new recipient, and
  **no** PTY-typed notification was sent (assert `pty.write` never called with
  `[orchestra] Connection update`).

### 14.5 Regression

- Existing `BoardManager.test.ts`, `routes/orchestra.test.ts`,
  `db/index.test.ts`, `NodeTerminal.test.tsx` must stay green.
- `tsc --noEmit` zero errors in `backend` and `frontend`.
- `npm run build` clean.

---

## 15. What we explicitly do NOT change (essence preservation)

- The product is still a **visual canvas of live pi terminals** with
  human-in-the-loop typing. The interactive side panel and the read-only node
  card mirrors are untouched.
- Handoff is still a **text protocol** (`@@HANDOFF`/`@@END`), parsed on
  `turn_end`, so it works on any provider including Cursor composer. We do not
  introduce a custom tool.
- `PtyHub`'s PTY lifecycle (spawn/kill/resize/scrollback/mirror-without-resize)
  is unchanged.
- The WS protocol and the REST CRUD surface are unchanged; existing CLI and
  programmatic API callers keep working.
- Multi-board, embedded host (VS Code), Kanban integration, prompt override,
  `canBeFinal` UI toggle — all unchanged.
- The only thing that moves is the **channel** for orchestration context: from
  PTY typing (which pi mistook for a user task) to the native per-turn system
  prompt + steering hooks. That is a *more* faithful implementation of the
  thesis, not a departure from it.

---

## 16. Open questions (to confirm before implementation)

1. **Fallback appendix in `--system-prompt` when the extension is absent.** If
   `EXTENSION_PATH` does not exist, should `spawn` bake the full appendix back
   into `--system-prompt` (preserving old behavior) and rely only on the
   ready-marker 10s fallback? Recommended: yes.
2. **Steer retry count default.** `MAX_STEER_RETRIES=2` (three total chances).
   Confirm or tune.
3. **Watchdog when `turnCtx` is null (backend down).** Current proposal: skip
   enforcement (degrade). Alternative: enforce using the `FALLBACK` appendix's
   baked `canBeFinal`/`outgoing` — but the fallback is a string, not structured,
   so we'd need to also bake a structured JSON snapshot. Recommended: skip
   enforcement when unreachable; the baked appendix still *advises* the agent.
4. **Should `/internal/*` routes enforce `PINODES_ORCHESTRA_TOKEN`?** Recommended:
   no, for parity with existing internal routes; document the loopback
   assumption.
5. **HandoffLog panel (§11).** In scope for this pass or deferred? Recommended:
   deferred; track as a follow-up so the determinism change stays small.

---

*End of plan. No source files were modified in the writing of this document.*
