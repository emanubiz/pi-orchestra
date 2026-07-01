import { beforeEach, describe, expect, it, vi } from "vitest";
import { HermesRuntime } from "./HermesRuntime.js";
import type { RuntimeSpawnConfig } from "./INodeRuntime.js";

// ── mock node-pty ──────────────────────────────────────────────────────────

interface FakePty {
  writes: string[];
  _onData: ((d: string) => void) | null;
  _onExit: ((e: { exitCode: number }) => void) | null;
  onData: (cb: (d: string) => void) => void;
  onExit: (cb: (e: { exitCode: number }) => void) => void;
  write: (d: string) => void;
  resize: (c: number, r: number) => void;
  kill: () => void;
}

const fakePtys: FakePty[] = [];

function makeFakePty(): FakePty {
  const inst: FakePty = {
    writes: [],
    _onData: null,
    _onExit: null,
    onData(cb: (d: string) => void) {
      this._onData = cb;
    },
    onExit(cb: (e: { exitCode: number }) => void) {
      this._onExit = cb;
    },
    write(d: string) {
      this.writes.push(d);
    },
    resize: vi.fn(),
    kill: vi.fn(),
  };
  fakePtys.push(inst);
  return inst;
}

const mockSpawn = vi.fn((_file: string, _args: string[], _opts: Record<string, unknown>) =>
  makeFakePty(),
);

vi.mock("node-pty", () => ({
  default: {
    spawn: (_file: string, _args: string[], _opts: Record<string, unknown>) =>
      mockSpawn(_file, _args, _opts),
  },
}));

// The plugin auto-install shells out to `hermes plugins enable` — stub it so the
// unit test never touches the real filesystem/CLI.
vi.mock("./installHermesPlugin.js", () => ({
  ensureHermesPluginInstalled: vi.fn(),
}));

// Make findInPath succeed so the command resolves.
vi.mock("node:fs", () => ({
  default: {
    existsSync: () => true,
    statSync: () => ({ isFile: () => true }),
  },
}));

function lastSpawn(): { file: string; args: string[]; opts: Record<string, unknown> } | undefined {
  const call = mockSpawn.mock.calls.at(-1) as [string, string[], Record<string, unknown>] | undefined;
  if (!call) return undefined;
  return { file: call[0], args: call[1], opts: call[2] };
}

function lastPty(): FakePty {
  const pty = fakePtys.at(-1);
  if (!pty) throw new Error("no pty spawned");
  return pty;
}

function emitData(inst: FakePty, data: string): void {
  expect(inst._onData).toBeTypeOf("function");
  inst._onData!(data);
}

function emitExit(inst: FakePty, exitCode: number): void {
  expect(inst._onExit).toBeTypeOf("function");
  inst._onExit!({ exitCode });
}

// ── helpers ─────────────────────────────────────────────────────────────────

function spawnConfig(
  overrides: Partial<RuntimeSpawnConfig> = {},
): RuntimeSpawnConfig {
  return {
    boardId: "b1",
    nodeId: "n1",
    label: "Developer",
    cwd: "/tmp/test",
    cols: 80,
    rows: 24,
    systemPrompt: "You are a developer.",
    appendix: "\n\n## Orchestration\nNo outgoing agents.\n",
    orchestraUrl: "http://localhost:3847",
    onOutput: vi.fn(),
    onExit: vi.fn(),
    ...overrides,
  };
}

describe("HermesRuntime", () => {
  beforeEach(() => {
    mockSpawn.mockClear();
    fakePtys.length = 0;
  });

  // ── spawn ──────────────────────────────────────────────────────────────────

  it("spawns hermes chat --tui with Hermes-native toolsets and no --resume", () => {
    const rt = new HermesRuntime();
    rt.spawn(spawnConfig());

    const spawnCall = lastSpawn()!;
    expect(spawnCall).toBeDefined();
    expect(spawnCall.args[0]).toBe("chat");
    expect(spawnCall.args).toContain("--tui");
    const tsIdx = spawnCall.args.indexOf("-t");
    expect(tsIdx).toBeGreaterThanOrEqual(0);
    // Only the node's work toolset — handoffs are a text protocol (@@HANDOFF)
    // parsed by the plugin, not a tool, so there is no `orchestra` toolset.
    expect(spawnCall.args[tsIdx + 1]).toBe("file,terminal");
    expect(spawnCall.args[tsIdx + 1]).not.toContain("orchestra");
    // A synthetic session id never exists on first launch, so --resume must NOT
    // be passed (it would fail with "Session not found" and never reach ready).
    expect(spawnCall.args).not.toContain("--resume");
    expect(spawnCall.args).toContain("--source");
    expect(spawnCall.args).not.toContain("--system-prompt");
    expect(spawnCall.args).not.toContain("--extension");
  });

  it("uses runtimeConfig.toolset to override the default toolset list", () => {
    const rt = new HermesRuntime();
    rt.spawn(spawnConfig({ runtimeConfig: { toolset: "read,grep" } }));

    const spawnCall = lastSpawn()!;
    const tsIdx = spawnCall.args.indexOf("-t");
    // User override is passed through verbatim — nothing is appended.
    expect(spawnCall.args[tsIdx + 1]).toBe("read,grep");
  });

  it("falls back to the default toolset when runtimeConfig.toolset is blank or the wrong type", () => {
    const rt = new HermesRuntime();
    rt.spawn(spawnConfig({ runtimeConfig: { toolset: "" } }));
    let spawnCall = lastSpawn()!;
    let tsIdx = spawnCall.args.indexOf("-t");
    expect(spawnCall.args[tsIdx + 1]).toBe("file,terminal");

    const rt2 = new HermesRuntime();
    rt2.spawn(spawnConfig({ runtimeConfig: { toolset: ["read"] } }));
    spawnCall = lastSpawn()!;
    tsIdx = spawnCall.args.indexOf("-t");
    expect(spawnCall.args[tsIdx + 1]).toBe("file,terminal");
  });

  it("sets the expected env vars including HERMES_EPHEMERAL_SYSTEM_PROMPT", () => {
    const oldToken = process.env.PINODES_ORCHESTRA_TOKEN;
    process.env.PINODES_ORCHESTRA_TOKEN = "test-token";
    try {
      const rt = new HermesRuntime();
      rt.spawn(spawnConfig());

      const spawnCall = lastSpawn()!;
      const env = spawnCall.opts.env as Record<string, string>;
      expect(env.HERMES_EPHEMERAL_SYSTEM_PROMPT).toBe("You are a developer.");
      expect(env.PINODES_ORCHESTRA_URL).toBe("http://localhost:3847");
      expect(env.PINODES_ORCHESTRA_BOARD).toBe("b1");
      expect(env.PINODES_ORCHESTRA_NODE).toBe("n1");
      expect(env.PINODES_ORCHESTRA_TOKEN).toBe("test-token");
      expect(env.PINODES_ORCHESTRA_FALLBACK_APPENDIX).toContain("## Orchestration");
    } finally {
      if (oldToken === undefined) delete process.env.PINODES_ORCHESTRA_TOKEN;
      else process.env.PINODES_ORCHESTRA_TOKEN = oldToken;
    }
  });

  it("sets the expected pty options (cwd, size)", () => {
    const rt = new HermesRuntime();
    rt.spawn(spawnConfig({ cols: 120, rows: 40, cwd: "/home/project" }));

    const spawnCall = lastSpawn()!;
    expect(spawnCall.opts).toMatchObject({
      name: "xterm-256color",
      cols: 120,
      rows: 40,
      cwd: "/home/project",
    });
  });

  // ── state (inherited from PtyRuntime) ──────────────────────────────────────

  it("is not running or ready before spawn", () => {
    const rt = new HermesRuntime();
    expect(rt.isRunning()).toBe(false);
    expect(rt.isReady()).toBe(false);
    expect(rt.size()).toBeUndefined();
  });

  it("is running after spawn, not ready until markReady", () => {
    const rt = new HermesRuntime();
    rt.spawn(spawnConfig());
    expect(rt.isRunning()).toBe(true);
    expect(rt.isReady()).toBe(false);
  });

  it("is ready after markReady", () => {
    const rt = new HermesRuntime();
    rt.spawn(spawnConfig());
    rt.markReady();
    expect(rt.isReady()).toBe(true);
  });

  // ── write / inject / resize / kill (inherited from PtyRuntime) ─────────────

  it("write and inject forward to the PTY", () => {
    vi.useFakeTimers();
    const rt = new HermesRuntime();
    rt.spawn(spawnConfig());

    rt.write("typed");
    expect(lastPty().writes).toEqual(["typed"]);

    rt.inject("task");
    expect(lastPty().writes).toContain("\x1b[200~task\x1b[201~");
    vi.advanceTimersByTime(80);
    expect(lastPty().writes).toContain("\r");
  });

  it("resize delegates to the PTY and updates reported size", () => {
    const rt = new HermesRuntime();
    rt.spawn(spawnConfig());

    rt.resize(100, 30);
    expect(lastPty().resize).toHaveBeenCalledWith(100, 30);
    expect(rt.size()).toEqual({ cols: 100, rows: 30 });
  });

  it("kill terminates the PTY and clears state", () => {
    const rt = new HermesRuntime();
    rt.spawn(spawnConfig());
    rt.markReady();
    const pty = lastPty();

    rt.kill();
    expect(pty.kill).toHaveBeenCalledOnce();
    expect(rt.isRunning()).toBe(false);
    expect(rt.isReady()).toBe(false);
    expect(rt.size()).toBeUndefined();
  });

  // ── callbacks ──────────────────────────────────────────────────────────────

  it("calls onOutput when the PTY emits data", () => {
    const onOutput = vi.fn();
    const rt = new HermesRuntime();
    rt.spawn(spawnConfig({ onOutput }));

    emitData(lastPty(), "Hello from hermes");
    expect(onOutput).toHaveBeenCalledWith("Hello from hermes");
  });

  it("calls onExit when the PTY exits", () => {
    const onExit = vi.fn();
    const rt = new HermesRuntime();
    rt.spawn(spawnConfig({ onExit }));

    emitExit(lastPty(), 0);
    expect(onExit).toHaveBeenCalledWith(0);
    expect(rt.isRunning()).toBe(false);
  });

  it("spawn clears previous state (kill + respawn)", () => {
    const rt = new HermesRuntime();
    rt.spawn(spawnConfig());
    rt.markReady();
    const first = lastPty();

    rt.kill();
    rt.spawn(spawnConfig({ label: "QA" }));

    expect(rt.isRunning()).toBe(true);
    expect(rt.isReady()).toBe(false);
    expect(lastPty()).not.toBe(first);
  });
});
