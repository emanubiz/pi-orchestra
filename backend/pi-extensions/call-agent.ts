/**
 * pinodes-orchestra · deterministic handoff extension
 *
 * Loaded into every node's pi terminal via `--extension`. Four jobs:
 *
 *  1. before_agent_start → refresh the orchestration appendix in the system
 *     prompt every loop (recipients, finality rule, kanban) by fetching
 *     /internal/orchestra-context. Replaces the old approach of typing a
 *     "connection update" into the PTY, which pi mistook for a new user task.
 *     Falls back to a spawn-time baked appendix if the backend is unreachable.
 *     Also POSTs /internal/turn-started — the closed-loop confirmation that an
 *     injected task's paste+submit reached the model (disarms the backend's
 *     submit watch and marks the node busy).
 *
 *  2. agent_end → the agent has finished its whole response (the agent loop is
 *     over, it is now awaiting input). POSTs /internal/turn-ended so the backend
 *     marks the node idle (and arms any submit watch parked while it was busy).
 *     This is also where intent is REQUIRED to be EXPLICIT, never inferred:
 *       - one or more @@HANDOFF:<handle> … @@END  → delegate downstream, or
 *       - @@DONE                                   → end the chain here.
 *     If a *pipeline* node (non-final, or final-but-with-outgoing-edges) ends
 *     with NEITHER, the extension asks the model to choose (capped). A non-final
 *     node that emits @@DONE is rejected — it must hand off. After the cap a
 *     non-final node is reported errored; a final node is allowed to end.
 *     Card moves (@@CARD) and handoff delivery also happen here.
 *
 *  3. session_start → tell the backend this pi is booted so queued injects fire
 *     immediately instead of on a guessed timer.
 *
 * Why agent_end and not turn_end? In pi a "turn" is one iteration of the agent
 * loop (a model call + its tools); turn_end fires mid-work. agent_end fires once,
 * when the agent is truly done — the only correct moment to demand a terminal
 * intent.
 *
 * Output-parsing (not a custom tool) so it works on ANY provider — including
 * Cursor composer, which does not expose extension tools to the model.
 *
 * Identity + endpoint come from env at spawn time:
 *   PINODES_ORCHESTRA_URL · PINODES_ORCHESTRA_BOARD · PINODES_ORCHESTRA_NODE
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BASE_URL = process.env.PINODES_ORCHESTRA_URL ?? "http://localhost:3847";
const BOARD_ID = process.env.PINODES_ORCHESTRA_BOARD ?? "";
const NODE_ID = process.env.PINODES_ORCHESTRA_NODE ?? "";
const TOKEN = process.env.PINODES_ORCHESTRA_TOKEN ?? "";
const FALLBACK = process.env.PINODES_ORCHESTRA_FALLBACK_APPENDIX ?? "";
const MAX_CONFIRM = Number(process.env.PINODES_ORCHESTRA_MAX_STEER_RETRIES ?? 2);

const HANDOFF_RE = /@@HANDOFF:\s*([^\s\n]+)\s*\n([\s\S]*?)@@END/g;
const CARD_RE = /@@CARD:\s*([^\s\n]+)/g;

/** Terminal intent: @@DONE alone on the last non-empty line (not prose mentioning it). */
function hasExplicitDone(text: string): boolean {
  for (const line of text.trim().split(/\r?\n/).reverse()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    return /^@@DONE\s*$/.test(trimmed);
  }
  return false;
}

// Marks the orchestration appendix inside the system prompt so it can be
// stripped and re-appended every loop. This makes the per-turn refresh robust
// whether pi rebuilds the system prompt from the base each loop (in which case
// nothing is stripped) or feeds back the previously-modified one (in which case
// the old appendix is removed so it never accumulates and grows unbounded).
const APPENDIX_OPEN = "\n\n<!--orchestra:appendix-->";
const APPENDIX_CLOSE = "<!--/orchestra:appendix-->";
const APPENDIX_RE = new RegExp(
  `${escapeRegExp(APPENDIX_OPEN)}[\\s\\S]*?${escapeRegExp(APPENDIX_CLOSE)}`,
  "g",
);

// Tag embedded in the auto-confirm message. before_agent_start uses it to tell a
// genuine new task (reset the confirm counter) apart from a loop that the
// confirm itself induced (keep the counter, so the retry cap actually engages
// instead of resetting forever).
const CONFIRM_TAG = "[orchestra:confirm]";

interface OrchestraContext {
  appendix: string;
  canBeFinal: boolean;
  outgoing: Array<{ id: string; handle: string; label: string }>;
  kanban: boolean;
  /** When false, the intent watchdog is off — handoffs/cards still deliver, but
   *  the agent is never asked to confirm handoff vs. done (free-chat mode). */
  enforce?: boolean;
}

// Per-loop state: context fetched in before_agent_start, reused in agent_end.
let loopCtx: OrchestraContext | null = null;
let confirmAttempts = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const authHeaders: Record<string, string> = TOKEN
  ? { "x-pinodes-orchestra-token": TOKEN }
  : {};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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

/** Text of the last assistant message in an agent loop (its final answer). */
function lastAssistantText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string } | null;
    if (m?.role === "assistant") return messageText(m);
  }
  return "";
}

/** Strip any previous appendix, then append the current one (wrapped). */
function withAppendix(base: string, appendix: string): string {
  const stripped = base.replace(APPENDIX_RE, "");
  const trimmed = appendix.trim();
  if (!trimmed) return stripped;
  return `${stripped}${APPENDIX_OPEN}${appendix}${APPENDIX_CLOSE}`;
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

/**
 * POST with bounded retry. Returns true only when the backend accepts AND
 * resolves the request (res.ok && body.ok). A deterministic rejection
 * (res.ok but body.ok === false, e.g. an unresolvable recipient) is NOT
 * retried. Network errors are retried with exponential backoff.
 */
async function postWithRetry(
  url: string,
  body: unknown,
  attempts: number,
  backoffMs: number,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean };
      if (res.ok && data.ok) return true;
      if (res.ok && !data.ok) return false; // deterministic reject — don't retry
    } catch {
      // network blip → retry
    }
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

/** Deliver every @@HANDOFF block; return how many resolved successfully. */
async function deliverHandoffs(text: string): Promise<number> {
  HANDOFF_RE.lastIndex = 0;
  const seen = new Set<string>(); // dedup identical blocks within the loop
  let successCount = 0;
  let match: RegExpExecArray | null;
  while ((match = HANDOFF_RE.exec(text)) !== null) {
    const targetNodeId = match[1].trim().replace(/^["']|["']$/g, "");
    const taskMessage = match[2].trim();
    if (!targetNodeId || !taskMessage) continue;
    const sig = `${targetNodeId}::${taskMessage}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    const ok = await postWithRetry(
      `${BASE_URL}/internal/call-agent`,
      { boardId: BOARD_ID, fromNodeId: NODE_ID, targetNodeId, message: taskMessage },
      3,
      250,
    );
    if (ok) successCount += 1;
  }
  return successCount;
}

/** Build the auto-confirm message tailored to the node's pipeline role. */
function buildConfirm(ctx: OrchestraContext, nonFinal: boolean, hadDone: boolean): string {
  const list = ctx.outgoing.map((o) => `- ${o.handle} — ${o.label}`).join("\n");
  const block =
    `@@HANDOFF:<recipient-handle>\n<complete, self-contained instructions>\n@@END`;
  if (nonFinal) {
    const why = hadDone
      ? `You wrote @@DONE, but you are a NON-TERMINAL node — ending the chain is not permitted for you.`
      : `You ended your turn without handing off, and you are a NON-TERMINAL node.`;
    return (
      `${CONFIRM_TAG} ${why} You MUST delegate the next step now to at least one of the ` +
      `connected agents below (more than one is allowed for parallel work). Re-emit a ` +
      `@@HANDOFF block:\n\n${list}\n\n${block}`
    );
  }
  return (
    `${CONFIRM_TAG} You ended your turn without an explicit signal, so I can't tell if you ` +
    `are finished or meant to hand off. Decide now:\n` +
    `• If the task is complete and nothing remains for a downstream agent, reply with ` +
    `@@DONE on its own line.\n` +
    `• If a downstream agent owns the next step, hand off with a @@HANDOFF block to one of:\n` +
    `${list}\n\n${block}`
  );
}

/**
 * Require an explicit terminal intent at the end of the agent loop. Applies to
 * pipeline nodes only (non-final, or final with outgoing edges); a pure leaf
 * (final, no outgoing) may end freely.
 */
async function enforceIntent(pi: ExtensionAPI, delivered: number, hasDone: boolean): Promise<void> {
  const ctx = loopCtx;
  if (!ctx) return; // backend unreachable → can't enforce; degrade gracefully
  if (ctx.enforce === false) return; // free-chat mode: watchdog disabled for this board

  if (delivered >= 1) {
    confirmAttempts = 0; // handed off explicitly ✅ (fan-out allowed)
    return;
  }

  const nonFinal = ctx.canBeFinal === false;
  const hasOutgoing = ctx.outgoing.length > 0;

  // Pure leaf: final and nothing downstream → free to end, nothing to enforce.
  if (!nonFinal && !hasOutgoing) return;

  // Final-capable node that explicitly declared completion → end ✅.
  if (!nonFinal && hasDone) {
    confirmAttempts = 0;
    return;
  }

  // Otherwise the node owes an explicit signal it didn't give (a non-final node
  // that wrote @@DONE also lands here — @@DONE is not valid for it).
  if (confirmAttempts >= MAX_CONFIRM) {
    if (nonFinal) {
      await postWithRetry(
        `${BASE_URL}/internal/handoff-failed`,
        {
          boardId: BOARD_ID,
          nodeId: NODE_ID,
          reason: hasDone ? "non-final-tried-to-end" : "no-handoff-after-retries",
          recipients: ctx.outgoing.map((o) => o.handle).join(", "),
        },
        2,
        250,
      );
    }
    // Final-capable node: stop asking and allow the silent end.
    return;
  }

  confirmAttempts += 1;
  // agent_end can fire while pi still considers the agent "processing". Queue the
  // confirm as a follow-up so pi drains it and continues the loop (see agent-session
  // _handlePostAgentRun → hasQueuedMessages). Without deliverAs this throws:
  // "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp')".
  pi.sendUserMessage(buildConfirm(ctx, nonFinal, hasDone), { deliverAs: "followUp" });
}

export default function handoffExtension(pi: ExtensionAPI) {
  // Ready marker: tell the backend this pi is booted so pending injects flush
  // immediately instead of waiting on a guessed timer.
  pi.on("session_start", async () => {
    await postWithRetry(`${BASE_URL}/internal/ready`, { boardId: BOARD_ID, nodeId: NODE_ID }, 2, 250);
  });

  // Per-loop system-prompt refresh.
  pi.on("before_agent_start", async (event) => {
    const prompt = (event as { prompt?: string }).prompt ?? "";
    // Reset the confirm counter only for a genuine new task; a loop induced by
    // our own confirm keeps the counter so the retry cap engages.
    if (!prompt.includes(CONFIRM_TAG)) confirmAttempts = 0;

    // Turn-started: the closed-loop confirmation that an injected task's
    // paste+submit reached the model. Best-effort, but retried a few times: if
    // it's lost the backend's submit watch will eventually re-send `\r` and
    // recover, so this is a fast-path, not a correctness requirement.
    void postWithRetry(`${BASE_URL}/internal/turn-started`, { boardId: BOARD_ID, nodeId: NODE_ID }, 2, 250);

    loopCtx = await fetchCtx();
    const appendix = loopCtx?.appendix ?? FALLBACK;
    const base = (event as { systemPrompt?: string }).systemPrompt ?? "";
    return { systemPrompt: withAppendix(base, appendix) };
  });

  // The agent finished its whole response: deliver outputs and require intent.
  pi.on("agent_end", async (event) => {
    const messages = ((event as { messages?: unknown[] }).messages ?? []) as unknown[];
    const text = lastAssistantText(messages);

    await deliverCards(text);
    const delivered = text ? await deliverHandoffs(text) : 0;

    // Turn-ended: marks the node idle and arms any submit watch that was parked
    // while the node was busy (an inject that landed mid-turn). The server-side
    // handoff nudge is Hermes-only, so for pi this is purely the busy/idle +
    // submit-confirmation transition. handoffCalledThisTurn is reported so the
    // backend has the same signal pi's own client-side watchdog uses.
    // Retried: a lost turn-ended leaves the node permanently busy → every later
    // inject parks in pendingArm and never arms → a silent pipeline stall.
    void postWithRetry(
      `${BASE_URL}/internal/turn-ended`,
      { boardId: BOARD_ID, nodeId: NODE_ID, handoffCalledThisTurn: delivered >= 1 },
      3,
      250,
    );

    if (!text) return;
    await enforceIntent(pi, delivered, hasExplicitDone(text));
  });
}
