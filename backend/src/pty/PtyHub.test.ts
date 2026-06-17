import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { WorkflowGraph } from "../types.js";

// ── mocks ─────────────────────────────────────────────────────────────────────

interface FakePty {
  sessionId: string;
  writes: string[];
  _exit: ((e: { exitCode: number }) => void) | null;
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

vi.mock("node-pty", () => ({
  default: {
    spawn: (file: string, args: string[], opts: Record<string, unknown>) => {
      const sidIdx = args.indexOf("--session-id");
      const inst: FakePty = {
        sessionId: sidIdx >= 0 ? args[sidIdx + 1] : "",
        writes: [],
        _exit: null,
        onData() {},
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

function graphOf(opts: { edges: boolean; n1Final?: boolean }): WorkflowGraph {
  return {
    name: "Test",
    cwd: "/tmp",
    entryNodeId: "n1",
    nodes: [
      { id: "n1", label: "Architect", promptId: "p1", canBeFinal: opts.n1Final ?? true, position: { x: 0, y: 0 } },
      { id: "n2", label: "Developer", promptId: "p2", position: { x: 1, y: 0 } },
    ],
    edges: opts.edges ? [{ id: "e1", sourceNodeId: "n1", targetNodeId: "n2" }] : [],
  };
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
  return [...spawnCalls].reverse().find((c) => c.args.includes(sid));
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
});
