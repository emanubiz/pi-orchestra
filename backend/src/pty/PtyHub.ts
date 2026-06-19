import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pty, { type IPty } from "node-pty";
import { getPrompt } from "../db/index.js";
import type { NodeStatus, WorkflowEdge, WorkflowGraph, WorkflowNode } from "../types.js";
import { resolveCwd } from "../utils/paths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAX_BUFFER = 256_000; // scrollback kept per node for re-attach
// After pi reports `session_start` we give its TUI a brief moment to mount the
// input line before pasting, so the first task can't race the initial render.
const READY_SETTLE_MS = 250;
// If the extension never reports ready (old pi, extension load failure), inject
// after this so a queued task is never dropped — still better than a wrong 3s
// guess that types into a not-yet-ready pi.
const READY_FALLBACK_MS = 10_000;
// Default for the determinism watchdog when a board has no explicit override.
const ENFORCE_DEFAULT = process.env.PINODES_ORCHESTRA_ENFORCE !== "false";
const PORT = Number(
  process.env.PINODES_ORCHESTRA_PORT ?? process.env.PORT ?? 3847,
);
const BASE_URL =
  process.env.PINODES_ORCHESTRA_URL ?? `http://localhost:${PORT}`;
const EXTENSION_PATH = path.resolve(__dirname, "../../pi-extensions/call-agent.ts");

type BroadcastFn = (msg: Record<string, unknown>) => void;

interface BoardGraph {
  cwd: string;
  nodes: Map<string, WorkflowNode>;
  edges: WorkflowEdge[];
}

interface Session {
  pty: IPty;
  buffer: string;
  cols: number;
  rows: number;
  startedAt: number;
}

// On Windows the `pi` launcher is `pi.cmd` (npm shim); `pi` with no extension
// does not exist, so spawning it verbatim fails with ENOENT.
const PI_BIN_NAMES = process.platform === "win32" ? ["pi.cmd", "pi.exe", "pi.bat", "pi"] : ["pi"];

/** Search an executable in PATH, trying platform-specific extensions. */
function findInPath(names: string[]): string | undefined {
  const pathVar = process.env.PATH ?? "";
  for (const dir of pathVar.split(path.delimiter)) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    }
  }
  return undefined;
}

/** Resolve the `pi` CLI entry, falling back to the binary on PATH. */
function resolvePiCommand(): { file: string; baseArgs: string[] } {
  const candidates = [
    path.resolve(__dirname, "../../node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
    path.resolve(process.cwd(), "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return { file: process.execPath, baseArgs: [c] };
  }
  const piBin = findInPath(PI_BIN_NAMES);
  if (piBin) {
    // On Windows `pi` on PATH is the npm batch shim `pi.cmd`. Spawning it forces
    // node-pty through cmd.exe, which treats the first CRLF inside our multiline
    // `--system-prompt` as end-of-command: it truncates the line and drops every
    // argument after it — including `--extension …call-agent.ts`. pi then boots
    // as a plain session with no orchestration extension and the nodes never see
    // each other. Resolve the cli.js the shim itself runs and launch it with node
    // directly (no shell), so args pass verbatim exactly like on Linux.
    if (/\.(cmd|bat)$/i.test(piBin)) {
      const cliFromShim = path.join(
        path.dirname(piBin),
        "node_modules",
        "@earendil-works",
        "pi-coding-agent",
        "dist",
        "cli.js",
      );
      if (fs.existsSync(cliFromShim)) {
        return { file: process.execPath, baseArgs: [cliFromShim] };
      }
    }
    return { file: piBin, baseArgs: [] };
  }
  console.error(
    "pinodes-orchestra: pi CLI not found. Install `@earendil-works/pi-coding-agent` globally (npm i -g) " +
      "or run `npm install` in the `backend` folder.",
  );
  return { file: PI_BIN_NAMES[0], baseArgs: [] };
}

function key(boardId: string, nodeId: string): string {
  return `${boardId}:${nodeId}`;
}

export class PtyHub {
  private broadcast: BroadcastFn = () => {};
  private graphs = new Map<string, BoardGraph>();
  private sessions = new Map<string, Session>();
  private pending = new Map<string, { cols: number; rows: number; message?: string }>();
  // Nodes whose pi has reported `session_start` (booted and ready for input).
  // Injects wait for this instead of guessing the boot time with a timer.
  private ready = new Map<string, true>();
  // Injects queued while a node is spawning, flushed on markReady (or a
  // conservative fallback timeout if the extension never reports ready).
  private waitingInjects = new Map<string, string[]>();
  private kanbanBoards = new Set<string>();
  // Per-node override of the determinism watchdog, keyed by boardId:nodeId.
  // Absent → use the env default (PINODES_ORCHESTRA_ENFORCE, on unless "false").
  // Toggled live so the user can chat freely with one node without being asked
  // "handoff or done?", while the rest of the board stays enforced.
  private enforceOverride = new Map<string, boolean>();
  private cmd = resolvePiCommand();
  private events = new EventEmitter();

  setBroadcast(fn: BroadcastFn): void {
    this.broadcast = fn;
  }

  /** Relay an arbitrary message to all clients (used by HTTP internal hooks). */
  notify(msg: Record<string, unknown>): void {
    this.broadcast(msg);
  }

  /** Mark a board as Kanban-tracked so its agents learn to move the card. */
  setKanbanTracked(boardId: string): void {
    this.kanbanBoards.add(boardId);
  }

  /** Whether the determinism watchdog is active for a node. */
  isEnforced(boardId: string, nodeId: string): boolean {
    return this.enforceOverride.get(key(boardId, nodeId)) ?? ENFORCE_DEFAULT;
  }

  /** Toggle the determinism watchdog for one node (live; read per loop by the
   *  extension via orchestra-context). Broadcasts so the UI reflects it. */
  setEnforcement(boardId: string, nodeId: string, enabled: boolean): void {
    this.enforceOverride.set(key(boardId, nodeId), enabled);
    this.broadcast({ type: "enforcement", boardId, nodeId, enabled });
  }

  /** Per-node enforcement overrides for a board (only nodes that differ from the
   *  default), so a reconnecting client can sync its toggles. */
  enforcementOverrides(boardId: string): Array<{ nodeId: string; enabled: boolean }> {
    const out: Array<{ nodeId: string; enabled: boolean }> = [];
    for (const [k, enabled] of this.enforceOverride) {
      const [b, nodeId] = k.split(":");
      if (b === boardId) out.push({ nodeId, enabled });
    }
    return out;
  }

  /**
   * Store node + edge metadata and cwd for a board. Kills terminals of removed
   * nodes and spawns any that were pending. Orchestration context (recipients,
   * finality, kanban) is NOT pushed into running terminals here: each agent
   * pulls the current context per turn via /internal/orchestra-context, so a
   * live graph edit is picked up on the node's next turn without typing into
   * the PTY (which pi used to mistake for a new user task).
   */
  setGraph(boardId: string, graph: WorkflowGraph, cwd: string): void {
    const resolvedCwd = resolveCwd(cwd);
    const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
    this.graphs.set(boardId, { cwd: resolvedCwd, nodes, edges: graph.edges ?? [] });
    for (const k of [...this.sessions.keys()]) {
      const [b, nodeId] = k.split(":");
      if (b === boardId && !nodes.has(nodeId)) this.kill(boardId, nodeId);
    }
    // Spawn terminals that were requested before this board's graph arrived.
    // If a task was queued while the node was pending (e.g. injectTask before
    // the graph sync), schedule its injection once pi has booted.
    for (const [k, size] of [...this.pending]) {
      const [b, nodeId] = k.split(":");
      if (b === boardId && nodes.has(nodeId)) {
        this.pending.delete(k);
        this.spawn(boardId, nodeId, size.cols, size.rows);
        if (size.message) {
          this.scheduleInject(boardId, nodeId, size.message);
        }
      }
    }
  }

  /**
   * Read-only orchestration context for a node, consumed by the per-turn
   * system-prompt refresh (and the determinism watchdog) in the extension.
   * Returns null for an unknown board/node so the extension degrades to its
   * spawn-time baked fallback appendix.
   */
  orchestraContext(
    boardId: string,
    nodeId: string,
  ): {
    appendix: string;
    canBeFinal: boolean;
    outgoing: Array<{ id: string; handle: string; label: string }>;
    kanban: boolean;
    enforce: boolean;
  } | null {
    const graph = this.graphs.get(boardId);
    if (!graph || !graph.nodes.has(nodeId)) return null;
    const handles = this.handles(boardId);
    const outgoing = this.outgoingTargets(boardId, nodeId).map((t) => ({
      id: t.id,
      handle: handles.get(t.id) ?? t.label,
      label: t.label,
    }));
    const kanban = this.kanbanBoards.has(boardId);
    return {
      appendix:
        this.connectionsAppendix(boardId, nodeId) + (kanban ? this.kanbanAppendix() : ""),
      canBeFinal: this.canBeFinal(boardId, nodeId),
      outgoing,
      kanban,
      enforce: this.isEnforced(boardId, nodeId),
    };
  }

  /** Nodes this node can hand off to: the targets of its outgoing edges. */
  private outgoingTargets(boardId: string, nodeId: string): WorkflowNode[] {
    const graph = this.graphs.get(boardId);
    if (!graph) return [];
    const targetIds = graph.edges
      .filter((e) => e.sourceNodeId === nodeId)
      .map((e) => e.targetNodeId);
    return targetIds
      .map((id) => graph.nodes.get(id))
      .filter((n): n is WorkflowNode => Boolean(n));
  }

  private hasEdge(boardId: string, from: string, to: string): boolean {
    const graph = this.graphs.get(boardId);
    return Boolean(graph?.edges.some((e) => e.sourceNodeId === from && e.targetNodeId === to));
  }

  /**
   * Short, unique, model-friendly handle per node, derived from its label.
   * Labels are roles and can repeat (e.g. two "Developer" nodes running in
   * parallel), so duplicates are suffixed: developer-1, developer-2. This is the
   * id agents use in @@HANDOFF — they can't be trusted to echo a long UUID, and
   * the bare label is ambiguous when a role is parallelised.
   */
  private handles(boardId: string): Map<string, string> {
    const map = new Map<string, string>();
    const graph = this.graphs.get(boardId);
    if (!graph) return map;
    const nodes = [...graph.nodes.values()];
    const slug = (s: string) =>
      s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
    const total = new Map<string, number>();
    for (const n of nodes) total.set(slug(n.label), (total.get(slug(n.label)) ?? 0) + 1);
    const seen = new Map<string, number>();
    for (const n of nodes) {
      const base = slug(n.label);
      if ((total.get(base) ?? 0) > 1) {
        const i = (seen.get(base) ?? 0) + 1;
        seen.set(base, i);
        map.set(n.id, `${base}-${i}`);
      } else {
        map.set(n.id, base);
      }
    }
    return map;
  }

  /** Whether a node is allowed to end the chain (undefined/null === yes). */
  private canBeFinal(boardId: string, nodeId: string): boolean {
    return this.graphs.get(boardId)?.nodes.get(nodeId)?.canBeFinal !== false;
  }

  /** System-prompt appendix telling an agent which nodes it may hand off to. */
  private connectionsAppendix(boardId: string, nodeId: string): string {
    const targets = this.outgoingTargets(boardId, nodeId);
    if (targets.length === 0) {
      return (
        "\n\n## Orchestration\n" +
        "You have no outgoing connected agents: carry the task through to completion yourself. " +
        "When the task is finished, end your turn with `@@DONE` on its own line.\n"
      );
    }
    const handles = this.handles(boardId);
    const lines = targets.map((t) => `- ${handles.get(t.id)} — ${t.label}`).join("\n");
    // A non-final node must always pass the ball downstream; a final-capable one
    // may close the chain when its part truly finishes the task.
    const endingRule = this.canBeFinal(boardId, nodeId)
      ? "- Ending is allowed, but it must be EXPLICIT: if your part finishes the task and nothing " +
        "is left for a downstream agent (e.g. a final review you approve), end your turn with " +
        "`@@DONE` on its own line. Do NOT end silently — a turn that has neither a @@HANDOFF block " +
        "nor @@DONE will be bounced back asking you to choose.\n"
      : "- You are NOT a terminal node: you must NEVER end the chain yourself. When your part is " +
        "done you are REQUIRED to hand off to one of the connected agents below — always close " +
        "your message with a @@HANDOFF block. Do not use @@DONE (it is not permitted for you). " +
        "(This rule can be lifted later at runtime.)\n";
    return (
      "\n\n## Orchestration — you are one link in a pipeline of agents\n" +
      "CORE RULE: this runs as a pipeline — do your part, then hand the next step to the " +
      "connected agent that owns it. Absorbing the whole job yourself defeats the point of the pipeline.\n" +
      "- When your part is done and a downstream agent owns the next step, hand off to it. " +
      "This is the expected default — don't silently take over their work.\n" +
      endingRule +
      "- You *may* do some of another agent's work yourself if it is genuinely warranted, but " +
      "that is the exception, not the default — prefer delegating the next step.\n\n" +
      "Agents you can hand work off to (outgoing) — use the handle on the left as the recipient:\n" +
      lines +
      "\n\nIf the same role appears more than once (e.g. developer-1, developer-2) pick the " +
      "specific handle you want; they are separate agents working in parallel.\n\n" +
      "To delegate, end your message with a hand-off block in EXACTLY this " +
      "format (no backticks, no text after @@END):\n\n" +
      "@@HANDOFF:<recipient-handle>\n" +
      "<complete, self-contained instructions: what you produced, files touched, what they must do>\n" +
      "@@END\n\n" +
      "Example: an architect produces the plan/spec and hands it to the developer — it does NOT " +
      "implement; the developer implements and hands off to QA/the auditor; the auditor reviews and, " +
      "if everything is fine, closes the chain with `@@DONE`. The system delivers each hand-off " +
      "automatically into the recipient's terminal.\n"
    );
  }

  /** Appendix telling agents to advance the linked Kanban card by real state. */
  private kanbanAppendix(): string {
    return (
      "\n\n## Kanban — advancing the card\n" +
      "This work is tracked on a Kanban board with columns: To Do, In Progress, Test, Review, Done.\n" +
      "When the real state of the work changes, move the card by writing on its own line:\n\n" +
      "@@CARD:<column>\n\n" +
      "Valid columns: todo, in_progress, test, review, done. Move the card to the state that truly " +
      "reflects the work (e.g. `@@CARD:test` when the code is ready for testing, `@@CARD:review` " +
      "when it needs reviewing, `@@CARD:done` when the work is finished). You can also use it together with a " +
      "@@HANDOFF block in the same message.\n"
    );
  }

  /**
   * Return a node's scrollback, spawning its pi terminal if needed.
   * With spawnIfMissing=false it only mirrors an already-running session (used
   * by the read-only mini terminals so they never spawn a pi before the board's
   * graph — hence the right prompt/cwd — has reached the backend).
   */
  ensure(
    boardId: string,
    nodeId: string,
    cols: number,
    rows: number,
    spawnIfMissing = true,
    allowResize = spawnIfMissing,
  ): string {
    const k = key(boardId, nodeId);
    const existing = this.sessions.get(k);
    if (existing) {
      // Only the interactive owner may resize the shared PTY. Read-only mirrors
      // (the node-card mini terminals) must not fight it for dimensions: if they
      // did, the PTY width would no longer match the interactive xterm and pi's
      // input line would wrap on every keystroke. Mirrors may still *spawn* a
      // node (spawnIfMissing) without claiming resize authority (allowResize).
      if (allowResize && cols && rows && (cols !== existing.cols || rows !== existing.rows)) {
        this.resize(boardId, nodeId, cols, rows);
      }
      return existing.buffer;
    }
    if (!spawnIfMissing) return "";
    const graph = this.graphs.get(boardId);
    if (!graph || !graph.nodes.has(nodeId)) {
      // Graph not synced yet → defer the spawn so pi gets the right prompt/cwd.
      this.pending.set(k, { cols: cols || 80, rows: rows || 24 });
      return "";
    }
    this.spawn(boardId, nodeId, cols || 80, rows || 24);
    return "";
  }

  private spawn(boardId: string, nodeId: string, cols: number, rows: number): void {
    const graph = this.graphs.get(boardId);
    const node = graph?.nodes.get(nodeId);
    const cwd = resolveCwd(graph?.cwd ?? process.cwd());

    let rolePrompt = "";
    if (node) {
      const row = getPrompt(node.promptId);
      rolePrompt = (node.promptOverride?.trim() || row?.content || "").trim();
    }
    // The orchestration appendix (recipients, finality, kanban) is refreshed per
    // turn by the extension via /internal/orchestra-context, so it is NOT baked
    // into --system-prompt when the extension is present. We still bake a
    // snapshot into env so the extension can degrade gracefully if the backend
    // is briefly unreachable. Without the extension there is no per-turn refresh,
    // so the appendix is baked directly into the system prompt instead.
    const appendix =
      this.connectionsAppendix(boardId, nodeId) +
      (this.kanbanBoards.has(boardId) ? this.kanbanAppendix() : "");
    const hasExtension = fs.existsSync(EXTENSION_PATH);
    const systemPrompt = (hasExtension ? rolePrompt : rolePrompt + appendix).trim();

    const args = [
      ...this.cmd.baseArgs,
      "--tools",
      "read,bash,edit,write,grep",
      "--session-id",
      `${boardId}-${nodeId}`.replace(/[^a-zA-Z0-9-]/g, ""),
      "--name",
      node?.label ?? "pi",
      "--system-prompt",
      systemPrompt,
    ];
    if (hasExtension) args.push("--extension", EXTENSION_PATH);

    console.log("pinodes-orchestra: spawning pi", this.cmd.file, args);
    const term = pty.spawn(this.cmd.file, args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: {
        ...process.env,
        PINODES_ORCHESTRA_URL: BASE_URL,
        PINODES_ORCHESTRA_BOARD: boardId,
        PINODES_ORCHESTRA_NODE: nodeId,
        PINODES_ORCHESTRA_FALLBACK_APPENDIX: appendix,
        ...(process.env.PINODES_ORCHESTRA_TOKEN
          ? { PINODES_ORCHESTRA_TOKEN: process.env.PINODES_ORCHESTRA_TOKEN }
          : {}),
      } as Record<string, string>,
    });

    const session: Session = { pty: term, buffer: "", cols, rows, startedAt: Date.now() };
    const k = key(boardId, nodeId);
    this.sessions.set(k, session);
    // A fresh session is not yet ready for input; the extension's session_start
    // will mark it (or the fallback timeout in scheduleInject will).
    this.ready.delete(k);
    this.waitingInjects.delete(k);
    this.broadcast({ type: "node_status", boardId, nodeId, status: "running" });
    // Tell read-only mirrors the PTY's real size so they can render pi's
    // absolute-cursor output faithfully (and scale it down) instead of fitting
    // a narrower grid that would garble it.
    this.broadcast({ type: "pty_size", boardId, nodeId, cols, rows });

    term.onData((data) => {
      session.buffer = (session.buffer + data).slice(-MAX_BUFFER);
      this.broadcast({ type: "pty_output", boardId, nodeId, data });
    });

    term.onExit(({ exitCode }) => {
      // Only clear if this exact session is still the active one (guards restart).
      if (this.sessions.get(k) === session) {
        this.sessions.delete(k);
        this.ready.delete(k);
        this.waitingInjects.delete(k);
      }
      this.broadcast({ type: "pty_exit", boardId, nodeId, code: exitCode });
      this.broadcast({ type: "node_status", boardId, nodeId, status: "idle" });
      this.events.emit(`exit:${boardId}:${nodeId}`, exitCode ?? null);
    });
  }

  input(boardId: string, nodeId: string, data: string): void {
    this.sessions.get(key(boardId, nodeId))?.pty.write(data);
  }

  /**
   * Resolve the recipient an agent asked for to one of its outgoing neighbours.
   * Forgiving on purpose: a model rarely echoes a long UUID node-id verbatim, so
   * we also accept the agent's name/label (case-insensitive, partial), and fall
   * back to the sole outgoing target when there is no ambiguity. Direction is
   * still enforced — only outgoing edges are considered.
   */
  private resolveOutgoingTarget(
    boardId: string,
    fromNodeId: string,
    requested: string,
  ): WorkflowNode | undefined {
    const targets = this.outgoingTargets(boardId, fromNodeId);
    if (targets.length === 0) return undefined;
    const handles = this.handles(boardId);
    const want = requested.trim().toLowerCase().replace(/^["']|["']$/g, "");
    if (want) {
      // Unique handle (developer-1) — the canonical recipient id.
      const byHandle = targets.find((t) => handles.get(t.id)?.toLowerCase() === want);
      if (byHandle) return byHandle;
      // Raw UUID node-id, still accepted.
      const byId = targets.find((t) => t.id.toLowerCase() === want);
      if (byId) return byId;
      // Bare label/partial — only when it resolves to exactly one node, so a
      // parallelised role ("developer" with two nodes) is never picked at random.
      const exact = targets.filter((t) => t.label.toLowerCase() === want);
      if (exact.length === 1) return exact[0];
      const partial = targets.filter(
        (t) =>
          t.label.toLowerCase().includes(want) || want.includes(t.label.toLowerCase()),
      );
      if (partial.length === 1) return partial[0];
    }
    // Only one place this agent can hand off to → the choice is unambiguous.
    if (targets.length === 1) return targets[0];
    return undefined;
  }

  /**
   * Deliver a task from one node to a connected one (call_agent). Resolves the
   * requested recipient against the sender's outgoing neighbours (by id OR name),
   * ensures the target terminal is running, and types the task into it. On
   * failure it tells the sender how to address its agents so the hand-off never
   * fails silently. Returns immediately; injection happens once the target's pi
   * is ready.
   */
  deliverCall(
    boardId: string,
    fromNodeId: string,
    targetNodeId: string,
    message: string,
  ): { ok: boolean; message?: string; error?: string } {
    const target = this.resolveOutgoingTarget(boardId, fromNodeId, targetNodeId);
    if (!target) {
      const options = this.outgoingTargets(boardId, fromNodeId);
      const handles = this.handles(boardId);
      const list = options.length
        ? options.map((t) => `${handles.get(t.id)} (${t.label})`).join(", ")
        : "(none — you have no outgoing connected agents)";
      const error = `Could not hand off to "${targetNodeId}". You can only delegate to: ${list}.`;
      // Nudge the sender so it retries with a valid recipient instead of silently
      // doing the downstream work itself.
      if (options.length) {
        this.injectTask(
          boardId,
          fromNodeId,
          `[orchestra] ${error} Re-issue the @@HANDOFF block using one of those names.`,
        );
      }
      return { ok: false, error };
    }

    this.scheduleInject(boardId, target.id, message);

    // The sender just handed off successfully, so clear any stale "handoff
    // failed" error on its card (it is alive and running).
    if (this.sessions.has(key(boardId, fromNodeId))) {
      this.broadcast({ type: "node_status", boardId, nodeId: fromNodeId, status: "running" });
    }

    return {
      ok: true,
      message: `Task delivered to ${target.label}. It is working in its terminal.`,
    };
  }

  /**
   * Feed a task into a node's pi terminal directly (e.g. launched from a Kanban
   * card). No edge check — it's a user-initiated start, not an agent hand-off.
   */
  injectTask(boardId: string, nodeId: string, message: string): void {
    this.scheduleInject(boardId, nodeId, message);
  }

  /**
   * Mark a node's pi as booted (its extension reported `session_start`). Flushes
   * any injects that were queued while it was still spawning.
   */
  markReady(boardId: string, nodeId: string): void {
    const k = key(boardId, nodeId);
    if (!this.sessions.has(k)) return;
    this.ready.set(k, true);
    // Tell clients pi has actually booted so the "starting pi…" overlay clears at
    // the right moment on every OS. (Clients can't rely on the first PTY byte:
    // Windows ConPTY emits terminal-init escape sequences immediately, before pi
    // is up, which would hide the overlay too early.)
    this.broadcast({ type: "node_ready", boardId, nodeId });
    const queued = this.waitingInjects.get(k);
    if (queued && queued.length) {
      this.waitingInjects.delete(k);
      // Give the TUI a beat to mount its input line before the first paste.
      setTimeout(() => {
        for (const msg of queued) this.inject(boardId, nodeId, msg);
      }, READY_SETTLE_MS);
    }
  }

  /** Whether a node's pi has booted (reported `session_start`). */
  isReady(boardId: string, nodeId: string): boolean {
    return this.ready.has(key(boardId, nodeId));
  }

  /**
   * Ensure the node is running, then inject once its pi is ready. If the node
   * has already reported ready the inject fires immediately; otherwise it is
   * queued and flushed by markReady (or a conservative fallback timeout, so a
   * task is never dropped even if the extension never reports ready).
   */
  private scheduleInject(boardId: string, nodeId: string, message: string): void {
    this.ensure(boardId, nodeId, 80, 24);
    const k = key(boardId, nodeId);
    const s = this.sessions.get(k);
    if (!s) {
      // Session was deferred (graph not synced yet) — store the message so it is
      // injected when setGraph spawns the terminal (see the pending loop there).
      const pending = this.pending.get(k);
      if (pending) pending.message = message;
      return;
    }
    if (this.ready.has(k)) {
      this.inject(boardId, nodeId, message);
      return;
    }
    // Not ready yet → queue; flushed on markReady or on the fallback timeout.
    const q = this.waitingInjects.get(k) ?? [];
    q.push(message);
    this.waitingInjects.set(k, q);
    setTimeout(() => {
      if (this.ready.has(k)) return; // markReady already flushed it
      const pending = this.waitingInjects.get(k);
      if (!pending || pending.length === 0) return;
      this.waitingInjects.delete(k);
      for (const msg of pending) this.inject(boardId, nodeId, msg);
    }, READY_FALLBACK_MS);
  }

  /** Type text into a node's pi editor as a bracketed paste, then submit. */
  private inject(boardId: string, nodeId: string, message: string): void {
    const s = this.sessions.get(key(boardId, nodeId));
    if (!s) return;
    // Bracketed paste keeps embedded newlines from submitting early.
    s.pty.write(`\x1b[200~${message}\x1b[201~`);
    setTimeout(() => this.sessions.get(key(boardId, nodeId))?.pty.write("\r"), 80);
  }

  resize(boardId: string, nodeId: string, cols: number, rows: number): void {
    const s = this.sessions.get(key(boardId, nodeId));
    if (!s || !cols || !rows) return;
    s.cols = cols;
    s.rows = rows;
    try {
      s.pty.resize(cols, rows);
    } catch (err) {
      // terminal may have just exited
      console.error(`pinodes-orchestra: pty resize failed for ${boardId}:${nodeId}`, err);
    }
    // Keep read-only mirrors in sync with the new PTY dimensions.
    this.broadcast({ type: "pty_size", boardId, nodeId, cols, rows });
  }

  /** Current PTY dimensions for a node, if it has a running session. */
  size(boardId: string, nodeId: string): { cols: number; rows: number } | undefined {
    const s = this.sessions.get(key(boardId, nodeId));
    return s ? { cols: s.cols, rows: s.rows } : undefined;
  }

  /** Kill and respawn a node's terminal (fresh pi session). */
  restart(boardId: string, nodeId: string, cols: number, rows: number): void {
    this.kill(boardId, nodeId);
    this.spawn(boardId, nodeId, cols || 80, rows || 24);
  }

  kill(boardId: string, nodeId: string): void {
    const k = key(boardId, nodeId);
    const s = this.sessions.get(k);
    if (!s) return;
    this.sessions.delete(k);
    this.ready.delete(k);
    this.waitingInjects.delete(k);
    try {
      s.pty.kill();
    } catch (err) {
      // already gone
      console.error(`pinodes-orchestra: pty kill failed for ${boardId}:${nodeId}`, err);
    }
  }

  killBoard(boardId: string): void {
    for (const k of [...this.sessions.keys()]) {
      if (k.startsWith(`${boardId}:`)) {
        const [, nodeId] = k.split(":");
        this.kill(boardId, nodeId);
      }
    }
    // Clean up deferred spawns that will never happen.
    for (const k of [...this.pending.keys()]) {
      if (k.startsWith(`${boardId}:`)) this.pending.delete(k);
    }
  }

  /** Whether a node currently has a running pi session. */
  isNodeRunning(boardId: string, nodeId: string): boolean {
    return this.sessions.has(key(boardId, nodeId));
  }

  /** Return status and start time for every node on a board. */
  getNodeStatuses(
    boardId: string,
  ): Array<{ nodeId: string; label: string; status: NodeStatus; startedAt?: number }> {
    const graph = this.graphs.get(boardId);
    if (!graph) return [];
    return [...graph.nodes.values()].map((n) => {
      const s = this.sessions.get(key(boardId, n.id));
      return {
        nodeId: n.id,
        label: n.label,
        status: s ? "running" : "idle",
        startedAt: s?.startedAt,
      };
    });
  }

  /** Return the edges of the loaded graph for a board. */
  getEdges(boardId: string): WorkflowEdge[] {
    return this.graphs.get(boardId)?.edges ?? [];
  }

  /**
   * Wait for a node's pi session to exit. Resolves immediately if the node is
   * not running. Returns `{ timedOut: true }` if the timeout fires first.
   */
  waitForExit(
    boardId: string,
    nodeId: string,
    timeoutMs = 120_000,
  ): Promise<{ code: number | null; timedOut: boolean }> {
    const k = key(boardId, nodeId);
    if (!this.sessions.has(k)) {
      return Promise.resolve({ code: null, timedOut: false });
    }
    return new Promise((resolve) => {
      const eventName = `exit:${boardId}:${nodeId}`;
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.events.off(eventName, handler);
              resolve({ code: null, timedOut: true });
            }, timeoutMs)
          : null;
      const handler = (code: number | null) => {
        if (timer) clearTimeout(timer);
        resolve({ code, timedOut: false });
      };
      this.events.once(eventName, handler);
    });
  }
}

export const ptyHub = new PtyHub();
