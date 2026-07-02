import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NodeRuntime, WorkflowGraph } from "../types.js";

// ── mocks ─────────────────────────────────────────────────────────────────────

interface FakePty {
  sessionId: string;
  writes: string[];
  _exit: ((e: { exitCode: number }) => void) | null;
  _data: ((d: string) => void) | null;
  onData: (cb: (d: string) => void) => void;
  onExit: (cb: (e: { exitCode: number }) => void) => void;
  write: (d: string) => void;
  kill: () => void;
  resize: (c: number, r: number) => void;
}

const spawnCalls = vi.hoisted(
  () => [] as Array<{ file: string; args: string[]; opts: Record<string, unknown> }>,
);
const ptyInstances = vi.hoisted(() => [] as FakePty[]);

// HermesRuntime.spawn triggers the plugin auto-install (which shells out to
// `hermes plugins enable`) — stub it so PtyHub unit tests stay hermetic.
vi.mock("./runtime/installHermesPlugin.js", () => ({
  ensureHermesPluginInstalled: vi.fn(),
}));

vi.mock("node-pty", () => ({
  default: {
    spawn: (file: string, args: string[], opts: Record<string, unknown>) => {
      const resumeIdx = args.indexOf("--resume");
      const sidIdx = args.indexOf("--session-id");
      // Hermes no longer passes --resume/--session-id (a synthetic id would fail
      // with "Session not found"); its node identity lives in the env vars the
      // plugin reads, so fall back to those to map the spawn back to a node.
      const env = (opts?.env ?? {}) as Record<string, string>;
      const envSid =
        env.PINODES_ORCHESTRA_BOARD && env.PINODES_ORCHESTRA_NODE
          ? `${env.PINODES_ORCHESTRA_BOARD}-${env.PINODES_ORCHESTRA_NODE}`
          : "";
      const sessionId =
        resumeIdx >= 0
          ? args[resumeIdx + 1]
          : sidIdx >= 0
            ? args[sidIdx + 1]
            : envSid;
      const inst: FakePty = {
        sessionId: sessionId ?? "",
        writes: [],
        _exit: null,
        _data: null,
        onData(cb) {
          this._data = cb;
        },
        onExit(cb) {
          this._exit = cb;
        },
        write(d) {
          this.writes.push(d);
        },
        kill: vi.fn(),
        resize: vi.fn(),
      };
      spawnCalls.push({ file, args, opts });
      ptyInstances.push(inst);
      return inst;
    },
  },
}));

vi.mock("../db/index.js", () => ({
  getPrompt: vi.fn(() => ({ content: "ROLE PROMPT" })),
}));

import { PtyHub } from "./PtyHub.js";

// ── helpers ───────────────────────────────────────────────────────────────────

const BOARD = "b1";

function graphOf(opts: {
  edges: boolean;
  n1Final?: boolean;
  n1Runtime?: NodeRuntime;
  n2Runtime?: NodeRuntime;
}): WorkflowGraph {
  return {
    name: "Test",
    cwd: "/tmp",
    entryNodeId: "n1",
    nodes: [
      {
        id: "n1",
        label: "Architect",
        promptId: "p1",
        canBeFinal: opts.n1Final ?? true,
        runtime: opts.n1Runtime,
        position: { x: 0, y: 0 },
      },
      {
        id: "n2",
        label: "Developer",
        promptId: "p2",
        runtime: opts.n2Runtime,
        position: { x: 1, y: 0 },
      },
    ],
    edges: opts.edges ? [{ id: "e1", sourceNodeId: "n1", targetNodeId: "n2" }] : [],
  };
}


function graphWithDuplicateDevelopers(): WorkflowGraph {
  return {
    name: "Duplicates",
    cwd: "/tmp",
    entryNodeId: "n1",
    nodes: [
      { id: "n1", label: "Architect", promptId: "p1", position: { x: 0, y: 0 } },
      { id: "dev-a", label: "Developer", promptId: "p2", position: { x: 1, y: 0 } },
      { id: "dev-b", label: "Developer", promptId: "p2", position: { x: 2, y: 0 } },
      { id: "qa", label: "Quality Analyst", promptId: "p2", position: { x: 3, y: 0 } },
    ],
    edges: [
      { id: "e1", sourceNodeId: "n1", targetNodeId: "dev-a" },
      { id: "e2", sourceNodeId: "n1", targetNodeId: "dev-b" },
      { id: "e3", sourceNodeId: "n1", targetNodeId: "qa" },
    ],
  };
}

function emitData(inst: FakePty, data: string): void {
  expect(inst._data).toBeTypeOf("function");
  inst._data?.(data);
}

function emitExit(inst: FakePty, exitCode: number): void {
  expect(inst._exit).toBeTypeOf("function");
  inst._exit?.({ exitCode });
}

/** Last pty spawned for a node (sessionId is `${board}-${node}` sanitized). */
function ptyFor(nodeId: string): FakePty | undefined {
  const sid = `${BOARD}-${nodeId}`;
  return [...ptyInstances].reverse().find((p) => p.sessionId === sid);
}

function argValue(call: { args: string[] }, flag: string): string | undefined {
  const i = call.args.indexOf(flag);
  return i >= 0 ? call.args[i + 1] : undefined;
}

function lastSpawnFor(nodeId: string) {
  const sid = `${BOARD}-${nodeId}`;
  return [...spawnCalls].reverse().find((c) => {
    if (c.args.includes(sid)) return true;
    // Hermes carries node identity in env vars, not in a session-id arg.
    const env = (c.opts?.env ?? {}) as Record<string, string>;
    return env.PINODES_ORCHESTRA_BOARD === BOARD && env.PINODES_ORCHESTRA_NODE === nodeId;
  });
}

describe("PtyHub", () => {
  let hub: PtyHub;

  beforeEach(() => {
    spawnCalls.length = 0;
    ptyInstances.length = 0;
    hub = new PtyHub();
    hub.setBroadcast(vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── orchestraContext ─────────────────────────────────────────────────────────

  it("orchestraContext returns appendix, outgoing and finality", () => {
    hub.setGraph(BOARD, graphOf({ edges: true, n1Final: false }), "/tmp");
    const ctx = hub.orchestraContext(BOARD, "n1");
    expect(ctx).not.toBeNull();
    expect(ctx?.canBeFinal).toBe(false);
    expect(ctx?.outgoing).toEqual([{ id: "n2", handle: "developer", label: "Developer" }]);
    expect(ctx?.appendix).toContain("## Orchestration");
  });

  it("orchestraContext returns null for an unknown board or node", () => {
    hub.setGraph(BOARD, graphOf({ edges: true }), "/tmp");
    expect(hub.orchestraContext(BOARD, "ghost")).toBeNull();
    expect(hub.orchestraContext("nope", "n1")).toBeNull();
  });

  it("orchestraContext reflects the per-node enforcement toggle", () => {
    hub.setGraph(BOARD, graphOf({ edges: true }), "/tmp");
    expect(hub.orchestraContext(BOARD, "n1")?.enforce).toBe(true); // default on
    hub.setEnforcement(BOARD, "n1", false);
    expect(hub.orchestraContext(BOARD, "n1")?.enforce).toBe(false);
    expect(hub.orchestraContext(BOARD, "n2")?.enforce).toBe(true); // sibling unaffected
    expect(hub.isEnforced(BOARD, "n1")).toBe(false);
    expect(hub.enforcementOverrides(BOARD)).toEqual([{ nodeId: "n1", enabled: false }]);
  });

  // ── unified appendix (pi + hermes share ONE @@HANDOFF text protocol) ─────────

  it.each(["pi", "hermes"] as const)(
    "connectionsAppendix for %s non-final nodes instructs @@HANDOFF text blocks, never a tool",
    (runtime) => {
      hub.setGraph(BOARD, graphOf({ edges: true, n1Runtime: runtime, n1Final: false }), "/tmp");
      const ctx = hub.orchestraContext(BOARD, "n1");
      expect(ctx?.appendix).toContain("@@HANDOFF");
      expect(ctx?.appendix).toContain("@@END");
      expect(ctx?.appendix).not.toContain("orchestra_handoff");
      // A non-terminal node is explicitly forbidden from ending the chain.
      expect(ctx?.appendix).toContain("NOT a terminal node");
      expect(ctx?.appendix).toContain("Do not use @@DONE");
    },
  );

  it("connectionsAppendix is byte-for-byte identical for pi and hermes", () => {
    hub.setGraph(BOARD, graphOf({ edges: true, n1Runtime: "pi", n1Final: true }), "/tmp");
    const pi = hub.orchestraContext(BOARD, "n1")?.appendix;
    hub.setGraph(BOARD, graphOf({ edges: true, n1Runtime: "hermes", n1Final: true }), "/tmp");
    const hermes = hub.orchestraContext(BOARD, "n1")?.appendix;
    expect(hermes).toBe(pi);
    expect(pi).toContain("@@DONE"); // final-capable node may close the chain
  });

  it.each(["pi", "hermes"] as const)(
    "kanbanAppendix for %s nodes instructs @@CARD text, never a tool",
    (runtime) => {
      hub.setKanbanTracked(BOARD);
      hub.setGraph(BOARD, graphOf({ edges: true, n1Runtime: runtime }), "/tmp");
      const ctx = hub.orchestraContext(BOARD, "n1");
      expect(ctx?.appendix).toContain("@@CARD");
      expect(ctx?.appendix).not.toContain("orchestra_card");
    },
  );

  it("deliverCall error nudge always instructs @@HANDOFF, never a tool (any runtime)", () => {
    vi.useFakeTimers();
    // n1 is a hermes node — it must still be nudged with the text protocol.
    const graph: WorkflowGraph = {
      ...graphWithDuplicateDevelopers(),
      nodes: graphWithDuplicateDevelopers().nodes.map((n) =>
        n.id === "n1" ? { ...n, runtime: "hermes" as NodeRuntime } : n,
      ),
    };
    hub.setGraph(BOARD, graph, "/tmp");
    hub.ensure(BOARD, "n1", 80, 24);
    hub.markReady(BOARD, "n1");
    const sender = ptyFor("n1")!;

    hub.deliverCall(BOARD, "n1", "developer", "ambiguous");

    const writes = sender.writes.join("");
    expect(writes).toContain("Re-issue the @@HANDOFF");
    expect(writes).not.toContain("orchestra_handoff");
  });

  // ── spawn: role-only prompt + fallback env ───────────────────────────────────

  it("spawns with a role-only system prompt and bakes the appendix into env", () => {
    hub.setGraph(BOARD, graphOf({ edges: true }), "/tmp");
    hub.ensure(BOARD, "n1", 80, 24);

    const call = lastSpawnFor("n1")!;
    expect(call).toBeDefined();
    // The extension is present in the repo, so the appendix is NOT baked here.
    expect(argValue(call, "--system-prompt")).toBe("ROLE PROMPT");
    expect(argValue(call, "--system-prompt")).not.toContain("## Orchestration");
    expect(call.args).toContain("--extension");
    expect(String((call.opts.env as Record<string, string>).PINODES_ORCHESTRA_FALLBACK_APPENDIX)).toContain(
      "## Orchestration",
    );
  });



  it("spawns with the expected command, cwd, size, env and startup broadcasts", () => {
    const broadcasts: Array<Record<string, unknown>> = [];
    const oldToken = process.env.PINODES_ORCHESTRA_TOKEN;
    process.env.PINODES_ORCHESTRA_TOKEN = "test-token";
    hub.setBroadcast((msg) => broadcasts.push(msg));

    try {
      hub.setGraph(BOARD, graphOf({ edges: true }), "/tmp");
      hub.ensure(BOARD, "n1", 111, 33);
    } finally {
      if (oldToken === undefined) delete process.env.PINODES_ORCHESTRA_TOKEN;
      else process.env.PINODES_ORCHESTRA_TOKEN = oldToken;
    }

    const call = lastSpawnFor("n1")!;
    expect(call).toBeDefined();
    expect(argValue(call, "--tools")).toBe("read,bash,edit,write,grep");
    expect(argValue(call, "--session-id")).toBe("b1-n1");
    expect(argValue(call, "--name")).toBe("Architect");
    expect(call.opts).toMatchObject({ name: "xterm-256color", cols: 111, rows: 33, cwd: "/tmp" });
    expect((call.opts.env as Record<string, string>).PINODES_ORCHESTRA_BOARD).toBe(BOARD);
    expect((call.opts.env as Record<string, string>).PINODES_ORCHESTRA_NODE).toBe("n1");
    expect((call.opts.env as Record<string, string>).PINODES_ORCHESTRA_TOKEN).toBe("test-token");
    expect((call.opts.env as Record<string, string>).PINODES_ORCHESTRA_URL).toMatch(/^http:\/\/localhost:/);
    expect(broadcasts).toContainEqual({ type: "node_status", boardId: BOARD, nodeId: "n1", status: "running" });
    expect(broadcasts).toContainEqual({ type: "pty_size", boardId: BOARD, nodeId: "n1", cols: 111, rows: 33 });
  });

  // ── setGraph no longer types into running terminals ──────────────────────────

  it("setGraph does not type any orchestration update into a running node", () => {
    hub.setGraph(BOARD, graphOf({ edges: false }), "/tmp");
    hub.ensure(BOARD, "n1", 80, 24);
    const inst = ptyFor("n1")!;
    inst.writes.length = 0;

    // Wire an edge after n1 is already running — old behaviour typed a
    // "[orchestra] Connection update" into the PTY; now it must stay silent.
    hub.setGraph(BOARD, graphOf({ edges: true }), "/tmp");
    expect(inst.writes.join("")).toBe("");
  });

  // ── ready-gated inject ───────────────────────────────────────────────────────



  it("defers a direct inject until the graph arrives, then waits for readiness", () => {
    vi.useFakeTimers();
    hub.injectTask(BOARD, "n2", "queued before graph");
    expect(spawnCalls).toHaveLength(0);

    hub.setGraph(BOARD, graphOf({ edges: true }), "/tmp");
    const inst = ptyFor("n2")!;
    expect(inst).toBeDefined();
    expect(inst.writes.join("")).not.toContain("queued before graph");

    hub.markReady(BOARD, "n2");
    vi.advanceTimersByTime(250);
    expect(inst.writes.join("")).toContain("[200~queued before graph[201~");
  });

  it("queues an inject until the node reports ready, then flushes it", () => {
    vi.useFakeTimers();
    hub.setGraph(BOARD, graphOf({ edges: true }), "/tmp");
    hub.injectTask(BOARD, "n2", "hello world");

    const inst = ptyFor("n2")!;
    expect(inst.writes.join("")).not.toContain("hello world");

    hub.markReady(BOARD, "n2");
    vi.advanceTimersByTime(250); // READY_SETTLE_MS
    expect(inst.writes.join("")).toContain("hello world");
  });

  it("injects immediately if the node is already ready", () => {
    vi.useFakeTimers();
    hub.setGraph(BOARD, graphOf({ edges: true }), "/tmp");
    hub.ensure(BOARD, "n2", 80, 24);
    hub.markReady(BOARD, "n2");

    hub.injectTask(BOARD, "n2", "second task");
    const inst = ptyFor("n2")!;
    expect(inst.writes.join("")).toContain("second task");
  });

  it("falls back to injecting after the timeout if ready never arrives", () => {
    vi.useFakeTimers();
    hub.setGraph(BOARD, graphOf({ edges: true }), "/tmp");
    hub.injectTask(BOARD, "n2", "delayed task");
    const inst = ptyFor("n2")!;
    expect(inst.writes.join("")).not.toContain("delayed task");

    vi.advanceTimersByTime(10_000); // READY_FALLBACK_MS
    expect(inst.writes.join("")).toContain("delayed task");
  });

  it("re-gates a restarted node: a fresh spawn clears the ready flag", () => {
    vi.useFakeTimers();
    hub.setGraph(BOARD, graphOf({ edges: true }), "/tmp");
    hub.ensure(BOARD, "n2", 80, 24);
    hub.markReady(BOARD, "n2");

    hub.restart(BOARD, "n2", 80, 24); // kill + respawn → ready cleared
    hub.injectTask(BOARD, "n2", "after restart");
    const inst = ptyFor("n2")!;
    expect(inst.writes.join("")).not.toContain("after restart");

    hub.markReady(BOARD, "n2");
    vi.advanceTimersByTime(250);
    expect(inst.writes.join("")).toContain("after restart");
  });



  // ── PTY I/O, lifecycle and replay buffer ───────────────────────────────────

  it("passes input through, resizes the owner PTY and reports current size", () => {
    const broadcasts: Array<Record<string, unknown>> = [];
    hub.setBroadcast((msg) => broadcasts.push(msg));
    hub.setGraph(BOARD, graphOf({ edges: true }), "/tmp");
    hub.ensure(BOARD, "n1", 80, 24);
    const inst = ptyFor("n1")!;

    hub.input(BOARD, "n1", "abc");
    expect(inst.writes).toEqual(["abc"]);

    hub.resize(BOARD, "n1", 120, 40);
    expect(inst.resize).toHaveBeenCalledWith(120, 40);
    expect(hub.size(BOARD, "n1")).toEqual({ cols: 120, rows: 40 });
    expect(broadcasts).toContainEqual({ type: "pty_size", boardId: BOARD, nodeId: "n1", cols: 120, rows: 40 });
  });

  it("accumulates PTY output, broadcasts chunks and replays only the bounded scrollback", () => {
    const broadcasts: Array<Record<string, unknown>> = [];
    hub.setBroadcast((msg) => broadcasts.push(msg));
    hub.setGraph(BOARD, graphOf({ edges: true }), "/tmp");
    hub.ensure(BOARD, "n1", 80, 24);
    const inst = ptyFor("n1")!;

    emitData(inst, "hello");
    expect(hub.ensure(BOARD, "n1", 0, 0, false)).toBe("hello");
    expect(broadcasts).toContainEqual({ type: "pty_output", boardId: BOARD, nodeId: "n1", data: "hello" });

    const large = "x".repeat(256_010);
    emitData(inst, large);
    const replay = hub.ensure(BOARD, "n1", 0, 0, false);
    expect(replay).toHaveLength(256_000);
    expect(replay).toBe("x".repeat(256_000));
  });

  it("scrollback ring buffer matches the legacy concat+slice oracle under heavy output", () => {
    const MAX = 256_000;
    hub.setGraph(BOARD, graphOf({ edges: true }), "/tmp");
    hub.ensure(BOARD, "n1", 80, 24);
    const inst = ptyFor("n1")!;

    let oracle = "";
    const chunks = [
      "a".repeat(100_000),
      "b".repeat(100_000),
      "c".repeat(100_000),
      "d".repeat(MAX + 500), // single chunk larger than MAX_BUFFER
      "e".repeat(42),
      "f",
      "g".repeat(10_000),
    ];

    for (const data of chunks) {
      emitData(inst, data);
      oracle = (oracle + data).slice(-MAX);
    }
    // Simulate many small chunks (hot path during verbose output).
    for (let i = 0; i < 500; i++) {
      const data = String(i % 10);
      emitData(inst, data);
      oracle = (oracle + data).slice(-MAX);
    }

    const replay = hub.ensure(BOARD, "n1", 0, 0, false);
    expect(replay.length).toBeLessThanOrEqual(MAX);
    expect(replay).toBe(oracle);
  });

  it("kills sessions and resolves waitForExit when the active PTY exits", async () => {
    const broadcasts: Array<Record<string, unknown>> = [];
    hub.setBroadcast((msg) => broadcasts.push(msg));
    hub.setGraph(BOARD, graphOf({ edges: true }), "/tmp");
    hub.ensure(BOARD, "n1", 80, 24);
    const inst = ptyFor("n1")!;

    const wait = hub.waitForExit(BOARD, "n1", 1_000);
    emitExit(inst, 7);

    await expect(wait).resolves.toEqual({ code: 7, timedOut: false });
    expect(hub.isNodeRunning(BOARD, "n1")).toBe(false);
    expect(hub.isReady(BOARD, "n1")).toBe(false);
    expect(broadcasts).toContainEqual({ type: "pty_exit", boardId: BOARD, nodeId: "n1", code: 7 });
    expect(broadcasts).toContainEqual({ type: "node_status", boardId: BOARD, nodeId: "n1", status: "idle" });
  });

  it("waitForExit resolves immediately for missing sessions and times out for running ones", async () => {
    await expect(hub.waitForExit(BOARD, "n1", 1_000)).resolves.toEqual({ code: null, timedOut: false });

    vi.useFakeTimers();
    hub.setGraph(BOARD, graphOf({ edges: true }), "/tmp");
    hub.ensure(BOARD, "n1", 80, 24);
    const wait = hub.waitForExit(BOARD, "n1", 1_000);
    vi.advanceTimersByTime(1_000);
    await expect(wait).resolves.toEqual({ code: null, timedOut: true });
  });

  it("kill and killBoard remove active sessions without waiting for an exit event", () => {
    hub.setGraph(BOARD, graphOf({ edges: true }), "/tmp");
    hub.ensure(BOARD, "n1", 80, 24);
    hub.ensure(BOARD, "n2", 80, 24);
    const n1 = ptyFor("n1")!;
    const n2 = ptyFor("n2")!;

    hub.kill(BOARD, "n1");
    expect(n1.kill).toHaveBeenCalledOnce();
    expect(hub.isNodeRunning(BOARD, "n1")).toBe(false);

    hub.killBoard(BOARD);
    expect(n2.kill).toHaveBeenCalledOnce();
    expect(hub.isNodeRunning(BOARD, "n2")).toBe(false);
  });

  it("killBoard clears deferred spawns for that board", () => {
    hub.ensure(BOARD, "n1", 80, 24);
    expect(spawnCalls).toHaveLength(0);

    hub.killBoard(BOARD);
    hub.setGraph(BOARD, graphOf({ edges: true }), "/tmp");

    expect(spawnCalls).toHaveLength(0);
  });

  it("a stale exit from a killed session does not clear the restarted session", () => {
    hub.setGraph(BOARD, graphOf({ edges: true }), "/tmp");
    hub.ensure(BOARD, "n1", 80, 24);
    const stale = ptyFor("n1")!;

    hub.restart(BOARD, "n1", 100, 30);
    const fresh = ptyFor("n1")!;
    expect(fresh).not.toBe(stale);

    emitExit(stale, 99);

    expect(hub.isNodeRunning(BOARD, "n1")).toBe(true);
    expect(hub.size(BOARD, "n1")).toEqual({ cols: 100, rows: 30 });
    hub.input(BOARD, "n1", "still alive");
    expect(fresh.writes).toContain("still alive");
  });

  // ── deliverCall emits the canonical handoff event ────────────────────────────

  it("deliverCall broadcasts a `handoff` event with the real from/to node ids", () => {
    const broadcasts: Array<Record<string, unknown>> = [];
    hub.setBroadcast((msg) => broadcasts.push(msg));
    hub.setGraph(BOARD, graphOf({ edges: true }), "/tmp");
    hub.ensure(BOARD, "n1", 80, 24);
    hub.ensure(BOARD, "n2", 80, 24);

    const res = hub.deliverCall(BOARD, "n1", "developer", "do the thing");

    expect(res.ok).toBe(true);
    const handoffs = broadcasts.filter((m) => m.type === "handoff");
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]).toMatchObject({
      boardId: BOARD,
      fromNodeId: "n1",
      toNodeId: "n2",
    });
  });



  it("deliverCall resolves recipients by raw id, unique partial label and duplicate-safe handle", () => {
    const broadcasts: Array<Record<string, unknown>> = [];
    hub.setBroadcast((msg) => broadcasts.push(msg));
    hub.setGraph(BOARD, graphWithDuplicateDevelopers(), "/tmp");

    expect(hub.deliverCall(BOARD, "n1", "dev-a", "by id").ok).toBe(true);
    expect(hub.deliverCall(BOARD, "n1", "quality", "by label").ok).toBe(true);
    expect(hub.deliverCall(BOARD, "n1", "developer-2", "by handle").ok).toBe(true);

    const handoffs = broadcasts.filter((m) => m.type === "handoff");
    expect(handoffs.map((m) => m.toNodeId)).toEqual(["dev-a", "qa", "dev-b"]);
  });

  it("deliverCall rejects ambiguous recipients and nudges the sender with valid handles", () => {
    vi.useFakeTimers();
    hub.setGraph(BOARD, graphWithDuplicateDevelopers(), "/tmp");
    hub.ensure(BOARD, "n1", 80, 24);
    hub.markReady(BOARD, "n1");
    const sender = ptyFor("n1")!;

    const res = hub.deliverCall(BOARD, "n1", "developer", "ambiguous");

    expect(res.ok).toBe(false);
    expect(res.error).toContain("developer-1 (Developer), developer-2 (Developer), quality-analyst (Quality Analyst)");
    expect(sender.writes.join("")).toContain("[orchestra] Could not hand off");
    expect(sender.writes.join("")).toContain("developer-1");
  });

  it("deliverCall does NOT broadcast a handoff when the recipient is invalid", () => {
    const broadcasts: Array<Record<string, unknown>> = [];
    hub.setBroadcast((msg) => broadcasts.push(msg));
    // No outgoing edges from n1 → the recipient can't be resolved at all.
    hub.setGraph(BOARD, graphOf({ edges: false }), "/tmp");
    hub.ensure(BOARD, "n1", 80, 24);

    const res = hub.deliverCall(BOARD, "n1", "nonexistent", "do the thing");

    expect(res.ok).toBe(false);
    expect(broadcasts.filter((m) => m.type === "handoff")).toHaveLength(0);
  });

  // ── HermesRuntime E2E (PINODES_ORCHESTRA_HERMES enabled) ─────────────────

  describe("with Hermes enabled", () => {
    beforeEach(() => {
      process.env.PINODES_ORCHESTRA_HERMES = "true";
    });

    afterEach(() => {
      delete process.env.PINODES_ORCHESTRA_HERMES;
    });

    it("spawns a hermes node with --tui and HERMES_EPHEMERAL_SYSTEM_PROMPT", () => {
      hub.setGraph(
        BOARD,
        graphOf({ edges: true, n1Runtime: "hermes" }),
        "/tmp",
      );
      hub.ensure(BOARD, "n1", 80, 24);

      const call = lastSpawnFor("n1")!;
      expect(call).toBeDefined();
      expect(call.args[0]).toBe("chat");
      expect(call.args).toContain("--tui");
      expect(call.args).toContain("-t");
      expect(call.args).not.toContain("--system-prompt");
      expect(call.args).not.toContain("--extension");
      const env = call.opts.env as Record<string, string>;
      expect(env.HERMES_EPHEMERAL_SYSTEM_PROMPT).toBe("ROLE PROMPT");
    });

    it("defaults to PiRuntime when runtime field is absent or is pi", () => {
      // n1 has no runtime → pi (default)
      hub.setGraph(BOARD, graphOf({ edges: true }), "/tmp");
      hub.ensure(BOARD, "n1", 80, 24);

      const call = lastSpawnFor("n1")!;
      expect(call.args).toContain("--system-prompt");
      expect(call.args).toContain("--tools");
      expect(call.args).not.toContain("--tui");

      // n2 explicitly pi
      hub.setGraph(
        BOARD,
        graphOf({ edges: true, n2Runtime: "pi" }),
        "/tmp",
      );
      hub.ensure(BOARD, "n2", 80, 24);
      const call2 = lastSpawnFor("n2")!;
      expect(call2.args).toContain("--system-prompt");
      expect(call2.args).toContain("--tools");
    });

    it("handoff from pi to hermes node works", () => {
      const broadcasts: Array<Record<string, unknown>> = [];
      hub.setBroadcast((msg) => broadcasts.push(msg));
      hub.setGraph(
        BOARD,
        graphOf({ edges: true, n1Runtime: "pi", n2Runtime: "hermes" }),
        "/tmp",
      );
      hub.ensure(BOARD, "n1", 80, 24);
      hub.ensure(BOARD, "n2", 80, 24);

      const res = hub.deliverCall(BOARD, "n1", "developer", "handoff task");
      expect(res.ok).toBe(true);
      const handoffs = broadcasts.filter((m) => m.type === "handoff");
      expect(handoffs).toHaveLength(1);
      expect(handoffs[0]).toMatchObject({
        fromNodeId: "n1",
        toNodeId: "n2",
      });
    });

    it("restart and kill work with Hermes nodes", () => {
      hub.setGraph(
        BOARD,
        graphOf({ edges: true, n1Runtime: "hermes" }),
        "/tmp",
      );
      hub.ensure(BOARD, "n1", 80, 24);
      const inst = ptyFor("n1")!;
      expect(inst).toBeDefined();

      hub.kill(BOARD, "n1");
      expect(inst.kill).toHaveBeenCalled();
      expect(hub.isNodeRunning(BOARD, "n1")).toBe(false);

      hub.restart(BOARD, "n1", 100, 30);
      const fresh = ptyFor("n1")!;
      expect(fresh).not.toBe(inst);
      expect(hub.isNodeRunning(BOARD, "n1")).toBe(true);
    });

    it("orchestraContext correctly reports hermes nodes as non-final when canBeFinal is false", () => {
      hub.setGraph(
        BOARD,
        graphOf({ edges: true, n1Runtime: "hermes", n1Final: false }),
        "/tmp",
      );
      const ctx = hub.orchestraContext(BOARD, "n1");
      expect(ctx?.canBeFinal).toBe(false);
      expect(ctx?.outgoing).toHaveLength(1);
      expect(ctx?.outgoing[0].handle).toBe("developer");
    });

    it("handleTurnEnded: final node with no handoff is a no-op — not nudged, no PTY writes", () => {
      const broadcasts: Array<Record<string, unknown>> = [];
      hub.setBroadcast((msg) => broadcasts.push(msg));
      hub.setGraph(
        BOARD,
        graphOf({ edges: true, n1Runtime: "hermes", n1Final: true }),
        "/tmp",
      );
      hub.ensure(BOARD, "n1", 80, 24);
      hub.markReady(BOARD, "n1");
      broadcasts.length = 0; // drop spawn/ready broadcasts (node_status running, pty_size, node_ready)

      const result = hub.handleTurnEnded(BOARD, "n1", false);

      expect(result).toEqual({ ok: true });
      expect(ptyFor("n1")?.writes ?? []).toEqual([]);
      expect(broadcasts).toEqual([]);
    });

    it("handleTurnEnded: non-final node is nudged with incrementing retries, then errors after the cap", () => {
      const broadcasts: Array<Record<string, unknown>> = [];
      hub.setBroadcast((msg) => broadcasts.push(msg));
      hub.setGraph(
        BOARD,
        graphOf({ edges: true, n1Runtime: "hermes", n1Final: false }),
        "/tmp",
      );
      hub.ensure(BOARD, "n1", 80, 24);
      hub.markReady(BOARD, "n1");
      const inst = ptyFor("n1")!;

      const r1 = hub.handleTurnEnded(BOARD, "n1", false);
      expect(r1).toEqual({ ok: true, retries: 1 });
      expect(inst.writes.join("")).toContain("Attempt 1/3");
      expect(inst.writes.join("")).toContain("developer"); // n2's handle, the only outgoing target

      const r2 = hub.handleTurnEnded(BOARD, "n1", false);
      expect(r2).toEqual({ ok: true, retries: 2 });
      expect(inst.writes.join("")).toContain("Attempt 2/3");

      const r3 = hub.handleTurnEnded(BOARD, "n1", false);
      expect(r3).toEqual({ ok: true, retries: 3 });
      expect(inst.writes.join("")).toContain("Attempt 3/3");

      const writesBeforeCap = inst.writes.length;
      const r4 = hub.handleTurnEnded(BOARD, "n1", false);
      expect(r4).toEqual({ ok: true, retries: 4, exceeded: true });
      // Cap exceeded → reports error instead of writing another nudge.
      expect(inst.writes.length).toBe(writesBeforeCap);
      expect(broadcasts).toContainEqual(
        expect.objectContaining({
          type: "node_status",
          boardId: BOARD,
          nodeId: "n1",
          status: "error",
        }),
      );

      // A later handoff resets the counter for the next turn.
      const r5 = hub.handleTurnEnded(BOARD, "n1", true);
      expect(r5).toEqual({ ok: true });
      const r6 = hub.handleTurnEnded(BOARD, "n1", false);
      expect(r6).toEqual({ ok: true, retries: 1 });
    });

    it("handleTurnEnded returns a no-op for an unknown board or node", () => {
      hub.setGraph(BOARD, graphOf({ edges: true, n1Runtime: "hermes" }), "/tmp");
      expect(hub.handleTurnEnded(BOARD, "ghost", false)).toEqual({ ok: true });
      expect(hub.handleTurnEnded("nope", "n1", false)).toEqual({ ok: true });
    });

    it("Hermes not installed degrades gracefully (spawn still attempted)", () => {
      // Even without Hermes on PATH, PtyHub still creates the runtime and spawns.
      // The PTY will fail at the OS level, which is handled by onExit.
      hub.setGraph(
        BOARD,
        graphOf({ edges: true, n1Runtime: "hermes" }),
        "/tmp",
      );
      hub.ensure(BOARD, "n1", 80, 24);

      const call = lastSpawnFor("n1")!;
      expect(call).toBeDefined();
      // Spawn was attempted with hermes args
      expect(call.args).toContain("--tui");
    });
  });

  // ── ClaudeRuntime (PINODES_ORCHESTRA_CLAUDE enabled) ──────────────────────

  describe("with Claude enabled", () => {
    beforeEach(() => {
      process.env.PINODES_ORCHESTRA_CLAUDE = "true";
    });

    afterEach(() => {
      delete process.env.PINODES_ORCHESTRA_CLAUDE;
    });

    it("spawns a claude node with hook settings and appended system prompt", () => {
      hub.setGraph(BOARD, graphOf({ edges: true, n1Runtime: "claude" }), "/tmp");
      hub.ensure(BOARD, "n1", 80, 24);

      const call = lastSpawnFor("n1")!;
      expect(call).toBeDefined();
      expect(call.args).toContain("--append-system-prompt");
      expect(call.args).toContain("--settings");
      expect(call.args).toContain("--allowedTools");
      expect(call.args).not.toContain("--tui");
      expect(call.args).not.toContain("--extension");
      const env = call.opts.env as Record<string, string>;
      expect(env.PINODES_ORCHESTRA_NODE).toBe("n1");
    });

    it("falls back to pi when claude is not available", () => {
      process.env.PINODES_ORCHESTRA_CLAUDE = "false";
      hub.setGraph(BOARD, graphOf({ edges: true, n1Runtime: "claude" }), "/tmp");
      hub.ensure(BOARD, "n1", 80, 24);

      const call = lastSpawnFor("n1")!;
      expect(call.args).toContain("--system-prompt"); // pi args
      expect(call.args).not.toContain("--append-system-prompt");
    });

    it("handleTurnEnded nudges a non-final claude node server-side (like hermes)", () => {
      hub.setGraph(
        BOARD,
        graphOf({ edges: true, n1Runtime: "claude", n1Final: false }),
        "/tmp",
      );
      hub.ensure(BOARD, "n1", 80, 24);
      hub.markReady(BOARD, "n1");
      const inst = ptyFor("n1")!;

      const r1 = hub.handleTurnEnded(BOARD, "n1", false);
      expect(r1).toEqual({ ok: true, retries: 1 });
      expect(inst.writes.join("")).toContain("Attempt 1/3");

      // A handoff clears the retry counter, same contract as hermes.
      expect(hub.handleTurnEnded(BOARD, "n1", true)).toEqual({ ok: true });
    });
  });

  // ── Closed-loop submit confirmation (plan B) ────────────────────────────────
  // The watch is armed when the submit `\r` is written (after the paste→submit
  // delay), disarmed by turn-started, and re-sends `\r` on timeout. Timing:
  // pi's submitDelayMs floor is 80ms; SUBMIT_CONFIRM_MS is 1500ms.

  function countCr(inst: FakePty): number {
    return inst.writes.filter((w) => w === "\r").length;
  }

  describe("submit-watch state machine", () => {
    it("turn-started disarms the watch — no re-send after confirmation", () => {
      vi.useFakeTimers();
      hub.setGraph(BOARD, graphOf({ edges: true }), "/tmp");
      hub.ensure(BOARD, "n1", 80, 24);
      hub.markReady(BOARD, "n1");
      const inst = ptyFor("n1")!;

      hub.injectTask(BOARD, "n1", "a task");
      vi.advanceTimersByTime(80); // paste→submit → `\r` written, watch armed
      expect(countCr(inst)).toBe(1);

      hub.handleTurnStarted(BOARD, "n1"); // confirm → disarm
      vi.advanceTimersByTime(1_500); // past SUBMIT_CONFIRM_MS
      expect(countCr(inst)).toBe(1); // no re-send
    });

    it("watch re-sends `\r` on timeout, then turn-started disarms", () => {
      vi.useFakeTimers();
      hub.setGraph(BOARD, graphOf({ edges: true }), "/tmp");
      hub.ensure(BOARD, "n1", 80, 24);
      hub.markReady(BOARD, "n1");
      const inst = ptyFor("n1")!;

      hub.injectTask(BOARD, "n1", "a task");
      vi.advanceTimersByTime(80); // submit → watch armed
      expect(countCr(inst)).toBe(1);

      vi.advanceTimersByTime(1_500); // timeout → re-send `\r` (retries=1)
      expect(countCr(inst)).toBe(2);

      hub.handleTurnStarted(BOARD, "n1"); // disarm
      vi.advanceTimersByTime(1_500); // no further timeout
      expect(countCr(inst)).toBe(2);
    });

    it("errors after MAX_SUBMIT_RETRIES timeouts (3 re-sends then a stuck error)", () => {
      vi.useFakeTimers();
      const broadcasts: Array<Record<string, unknown>> = [];
      hub.setBroadcast((msg) => broadcasts.push(msg));
      hub.setGraph(BOARD, graphOf({ edges: true }), "/tmp");
      hub.ensure(BOARD, "n1", 80, 24);
      hub.markReady(BOARD, "n1");
      const inst = ptyFor("n1")!;

      hub.injectTask(BOARD, "n1", "a task");
      vi.advanceTimersByTime(80); // submit → 1 `\r`, watch armed

      vi.advanceTimersByTime(1_500); // timeout 1 → re-send (2nd `\r`)
      vi.advanceTimersByTime(1_500); // timeout 2 → re-send (3rd `\r`)
      vi.advanceTimersByTime(1_500); // timeout 3 → re-send (4th `\r`)
      vi.advanceTimersByTime(1_500); // timeout 4 → cap exceeded → error

      expect(countCr(inst)).toBe(4); // 1 submit + 3 re-sends
      expect(broadcasts).toContainEqual(
        expect.objectContaining({ type: "node_status", boardId: BOARD, nodeId: "n1", status: "error" }),
      );
    });

    it("inject while busy parks the watch; turn-ended arms it", () => {
      vi.useFakeTimers();
      hub.setGraph(BOARD, graphOf({ edges: true }), "/tmp");
      hub.ensure(BOARD, "n1", 80, 24);
      hub.markReady(BOARD, "n1");
      const inst = ptyFor("n1")!;

      hub.handleTurnStarted(BOARD, "n1"); // node busy
      // "task" (4 chars) → submitDelayMs = 80 + round(0.2) = 80ms exactly, so the
      // submit lands within the first 80ms advance (longer messages shift it past
      // 80 and the snapshot would capture a not-yet-fired submit).
      hub.injectTask(BOARD, "n1", "task");
      vi.advanceTimersByTime(80); // paste+submit land during the turn
      const submitsSoFar = countCr(inst); // the one submit `\r`

      vi.advanceTimersByTime(1_500); // watch NOT armed yet → no timeout re-send
      expect(countCr(inst)).toBe(submitsSoFar);

      hub.handleTurnEnded(BOARD, "n1", false); // idle → arm parked watch
      vi.advanceTimersByTime(1_500); // now the watch fires → re-send `\r`
      expect(countCr(inst)).toBe(submitsSoFar + 1);
    });

    it("kill clears submit state — no timer fires after kill", () => {
      vi.useFakeTimers();
      const broadcasts: Array<Record<string, unknown>> = [];
      hub.setBroadcast((msg) => broadcasts.push(msg));
      hub.setGraph(BOARD, graphOf({ edges: true }), "/tmp");
      hub.ensure(BOARD, "n1", 80, 24);
      hub.markReady(BOARD, "n1");

      hub.injectTask(BOARD, "n1", "a task");
      vi.advanceTimersByTime(80); // submit → watch armed
      hub.kill(BOARD, "n1");
      vi.advanceTimersByTime(5_000); // well past all timeouts

      expect(broadcasts.filter((m) => m.status === "error")).toHaveLength(0);
    });

    it("handleTurnEnded does NOT nudge pi nodes server-side (pi enforces client-side)", () => {
      vi.useFakeTimers();
      hub.setGraph(BOARD, graphOf({ edges: true, n1Runtime: "pi", n1Final: false }), "/tmp");
      hub.ensure(BOARD, "n1", 80, 24);
      hub.markReady(BOARD, "n1");
      const inst = ptyFor("n1")!;
      const writesBefore = inst.writes.length;

      const res = hub.handleTurnEnded(BOARD, "n1", false);
      expect(res).toEqual({ ok: true });
      // No nudge injected for a pi node — its extension handles intent itself.
      expect(inst.writes.length).toBe(writesBefore);
    });
  });

  describe("Codex structured runtime", () => {
    beforeEach(() => {
      process.env.PINODES_ORCHESTRA_CODEX = "false";
    });

    afterEach(() => {
      delete process.env.PINODES_ORCHESTRA_CODEX;
    });

    it("does not broadcast running after synchronous spawn failure (Codex unavailable)", () => {
      const broadcasts: Array<Record<string, unknown>> = [];
      hub.setBroadcast((msg) => broadcasts.push(msg));
      hub.setGraph(
        BOARD,
        {
          ...graphOf({ edges: true, n1Runtime: "codex" }),
          nodes: [
            {
              id: "n1",
              label: "Developer",
              promptId: "p1",
              runtime: "codex",
              canBeFinal: false,
              position: { x: 0, y: 0 },
            },
            {
              id: "n2",
              label: "Reviewer",
              promptId: "p2",
              position: { x: 1, y: 0 },
            },
          ],
        },
        "/tmp",
      );

      hub.ensure(BOARD, "n1", 80, 24);

      expect(hub.isNodeRunning(BOARD, "n1")).toBe(false);
      expect(broadcasts).toContainEqual(
        expect.objectContaining({
          type: "pty_output",
          boardId: BOARD,
          nodeId: "n1",
          data: expect.stringContaining("CLI not found"),
        }),
      );
      expect(broadcasts).toContainEqual({
        type: "node_status",
        boardId: BOARD,
        nodeId: "n1",
        status: "idle",
      });
      expect(broadcasts).not.toContainEqual({
        type: "node_status",
        boardId: BOARD,
        nodeId: "n1",
        status: "running",
      });
      expect(spawnCalls).toHaveLength(0);
    });
  });
});
