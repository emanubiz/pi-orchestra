import { beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { PiRuntime } from "./PiRuntime.js";
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

// Ensure the extension file check passes so the spawn path includes --extension.
// Configurable per-test so the resolvePiCommand() branch tests below can
// control which candidate paths "exist" without affecting the rest of the
// suite (default: everything exists, preserving prior behaviour).
const existsSyncMock = vi.hoisted(() => vi.fn((_p: string) => true));
vi.mock("node:fs", () => ({
  default: {
    existsSync: (p: string) => existsSyncMock(p),
    statSync: () => ({ isFile: () => true }),
  },
}));

// resolvePiCommand() falls back to findInPath() when no bundled cli.js is
// found; mocked separately so those branches don't depend on the real PATH.
const findInPathMock = vi.hoisted(() => vi.fn<(names: string | string[]) => string | undefined>());
vi.mock("./findInPath.js", () => ({
  findInPath: (names: string | string[]) => findInPathMock(names),
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
    label: "Architect",
    cwd: "/tmp/test",
    cols: 80,
    rows: 24,
    systemPrompt: "You are an architect.",
    appendix: "\n\n## Orchestration\nNo outgoing agents.\n",
    orchestraUrl: "http://localhost:3847",
    onOutput: vi.fn(),
    onExit: vi.fn(),
    ...overrides,
  };
}

describe("PiRuntime", () => {
  beforeEach(() => {
    mockSpawn.mockClear();
    fakePtys.length = 0;
    existsSyncMock.mockReset().mockReturnValue(true);
    findInPathMock.mockReset();
  });

  // ── spawn ──────────────────────────────────────────────────────────────────

  it("spawns pi with the correct command and arguments", () => {
    const rt = new PiRuntime();
    rt.spawn(spawnConfig());

    const spawnCall = lastSpawn()!;
    expect(spawnCall).toBeDefined();
    // toolset flag
    const toolsIdx = spawnCall.args.indexOf("--tools");
    expect(toolsIdx).toBeGreaterThanOrEqual(0);
    expect(spawnCall.args[toolsIdx + 1]).toBe("read,bash,edit,write,grep");
    // session-id (sanitised)
    const sidIdx = spawnCall.args.indexOf("--session-id");
    expect(sidIdx).toBeGreaterThanOrEqual(0);
    expect(spawnCall.args[sidIdx + 1]).toBe("b1-n1");
    // name
    const nameIdx = spawnCall.args.indexOf("--name");
    expect(nameIdx).toBeGreaterThanOrEqual(0);
    expect(spawnCall.args[nameIdx + 1]).toBe("Architect");
    // system-prompt
    const spIdx = spawnCall.args.indexOf("--system-prompt");
    expect(spIdx).toBeGreaterThanOrEqual(0);
    expect(spawnCall.args[spIdx + 1]).toBe("You are an architect.");
    // extension (fs mock says it exists)
    expect(spawnCall.args).toContain("--extension");
  });

  it("uses runtimeConfig.toolset to override the default --tools list", () => {
    const rt = new PiRuntime();
    rt.spawn(spawnConfig({ runtimeConfig: { toolset: "read,grep" } }));

    const spawnCall = lastSpawn()!;
    const toolsIdx = spawnCall.args.indexOf("--tools");
    expect(spawnCall.args[toolsIdx + 1]).toBe("read,grep");
  });

  it("falls back to the default toolset when runtimeConfig.toolset is blank or the wrong type", () => {
    const rt = new PiRuntime();
    rt.spawn(spawnConfig({ runtimeConfig: { toolset: "   " } }));
    let spawnCall = lastSpawn()!;
    let toolsIdx = spawnCall.args.indexOf("--tools");
    expect(spawnCall.args[toolsIdx + 1]).toBe("read,bash,edit,write,grep");

    const rt2 = new PiRuntime();
    rt2.spawn(spawnConfig({ runtimeConfig: { toolset: 42 } }));
    spawnCall = lastSpawn()!;
    toolsIdx = spawnCall.args.indexOf("--tools");
    expect(spawnCall.args[toolsIdx + 1]).toBe("read,bash,edit,write,grep");
  });

  it("sets the expected pty options (cwd, env, size)", () => {
    const oldToken = process.env.PINODES_ORCHESTRA_TOKEN;
    process.env.PINODES_ORCHESTRA_TOKEN = "test-token";
    try {
      const rt = new PiRuntime();
      rt.spawn(spawnConfig());

      const spawnCall = lastSpawn()!;
      expect(spawnCall.opts).toMatchObject({
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd: "/tmp/test",
      });
      const env = spawnCall.opts.env as Record<string, string>;
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

  // ── isRunning / isReady / size defaults ────────────────────────────────────

  it("is not running or ready before spawn", () => {
    const rt = new PiRuntime();
    expect(rt.isRunning()).toBe(false);
    expect(rt.isReady()).toBe(false);
    expect(rt.size()).toBeUndefined();
  });

  it("is running after spawn, but not ready until markReady", () => {
    const rt = new PiRuntime();
    rt.spawn(spawnConfig());
    expect(rt.isRunning()).toBe(true);
    expect(rt.isReady()).toBe(false);
  });

  it("is ready after markReady", () => {
    const rt = new PiRuntime();
    rt.spawn(spawnConfig());
    rt.markReady();
    expect(rt.isReady()).toBe(true);
    expect(rt.isRunning()).toBe(true);
  });

  // ── write ──────────────────────────────────────────────────────────────────

  it("write forwards data to the PTY", () => {
    const rt = new PiRuntime();
    rt.spawn(spawnConfig());

    rt.write("hello");
    expect(lastPty().writes).toEqual(["hello"]);

    rt.write("world");
    expect(lastPty().writes).toEqual(["hello", "world"]);
  });

  it("write is a no-op when not running", () => {
    const rt = new PiRuntime();
    rt.write("x");
    // no throw
  });

  // ── inject ─────────────────────────────────────────────────────────────────

  it("inject does a bracketed paste then submits after the paste→submit delay", () => {
    vi.useFakeTimers();
    const rt = new PiRuntime();
    rt.spawn(spawnConfig());

    rt.inject("do task"); // short → pi's 80ms floor, no length margin
    const pty = lastPty();
    // paste arrives immediately
    expect(pty.writes).toContain("\x1b[200~do task\x1b[201~");

    // submit follows after the delay (pi floor = 80ms)
    expect(pty.writes).not.toContain("\r");
    vi.advanceTimersByTime(80);
    expect(pty.writes).toContain("\r");
  });

  it("inject is a no-op when not running", () => {
    const rt = new PiRuntime();
    rt.inject("x");
    // no throw
  });

  // ── resize ─────────────────────────────────────────────────────────────────

  it("resize delegates to the PTY and updates reported size", () => {
    const rt = new PiRuntime();
    rt.spawn(spawnConfig());

    rt.resize(120, 40);
    expect(lastPty().resize).toHaveBeenCalledWith(120, 40);
    expect(rt.size()).toEqual({ cols: 120, rows: 40 });
  });

  it("resize is a no-op when not running", () => {
    const rt = new PiRuntime();
    rt.resize(100, 30);
    // no throw, size still undefined
    expect(rt.size()).toBeUndefined();
  });

  // ── kill ───────────────────────────────────────────────────────────────────

  it("kill terminates the PTY and clears running/ready state", () => {
    const rt = new PiRuntime();
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
    const rt = new PiRuntime();
    rt.spawn(spawnConfig({ onOutput }));

    emitData(lastPty(), "Hello from pi");
    expect(onOutput).toHaveBeenCalledWith("Hello from pi");
  });

  it("calls onExit when the PTY exits and cleans up state", () => {
    const onExit = vi.fn();
    const rt = new PiRuntime();
    rt.spawn(spawnConfig({ onExit }));
    rt.markReady();

    emitExit(lastPty(), 42);

    expect(onExit).toHaveBeenCalledWith(42);
    expect(rt.isRunning()).toBe(false);
    expect(rt.isReady()).toBe(false);
  });

  it("onExit handles null exit code", () => {
    const onExit = vi.fn();
    const rt = new PiRuntime();
    rt.spawn(spawnConfig({ onExit }));

    // Simulate exit with undefined exitCode (mapped to null in spawn).
    const inst = lastPty();
    expect(inst._onExit).toBeTypeOf("function");
    inst._onExit!({ exitCode: undefined as unknown as number });

    expect(onExit).toHaveBeenCalledWith(null);
  });

  it("markReady is a no-op when not running", () => {
    const rt = new PiRuntime();
    rt.markReady();
    expect(rt.isReady()).toBe(false);
  });

  it("spawn clears any previous state (kill + respawn)", () => {
    const rt = new PiRuntime();
    rt.spawn(spawnConfig());
    rt.markReady();
    const first = lastPty();

    rt.kill();
    rt.spawn(spawnConfig({ label: "Developer" }));

    expect(rt.isRunning()).toBe(true);
    expect(rt.isReady()).toBe(false);
    // fresh PTY
    expect(lastPty()).not.toBe(first);
    // stale exit from old PTY does not affect new state (handled by PtyHub)
  });
});

// resolvePiCommand() is private and runs once per `new PiRuntime()` (field
// initializer), so each branch is exercised indirectly through the resulting
// spawn() call (`this.cmd.file` / `this.cmd.baseArgs`).
describe("PiRuntime resolvePiCommand", () => {
  const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  beforeEach(() => {
    mockSpawn.mockClear();
    fakePtys.length = 0;
    existsSyncMock.mockReset().mockReturnValue(false);
    findInPathMock.mockReset();
    consoleErrorSpy.mockClear();
  });

  afterAll(() => {
    consoleErrorSpy.mockRestore();
  });

  it("uses the bundled node_modules cli.js when it exists, without touching PATH", () => {
    existsSyncMock.mockReturnValue(true); // both node_modules candidates "exist"

    const rt = new PiRuntime();
    rt.spawn(spawnConfig());

    expect(findInPathMock).not.toHaveBeenCalled();
    const call = lastSpawn()!;
    expect(call.file).toBe(process.execPath); // launched via `node <cli.js>`, no shell
    expect(call.args[0]).toMatch(/cli\.js$/);
  });

  it("falls back to a plain PATH binary when no bundled cli.js is found", () => {
    existsSyncMock.mockReturnValue(false); // neither node_modules candidate exists
    findInPathMock.mockReturnValue("/usr/local/bin/pi");

    const rt = new PiRuntime();
    rt.spawn(spawnConfig());

    const call = lastSpawn()!;
    expect(call.file).toBe("/usr/local/bin/pi");
    // No baseArgs prepended for a plain binary — first arg is the first real flag.
    expect(call.args[0]).toBe("--tools");
  });

  it("rewrites a Windows .cmd/.bat shim to its underlying cli.js and launches via node", () => {
    existsSyncMock.mockReset();
    const shimPath = "C:\\Users\\dev\\AppData\\Roaming\\npm\\pi.cmd";
    const cliFromShim = path.join(
      path.dirname(shimPath),
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "cli.js",
    );
    // Only the resolved cli.js path "exists" — the two node_modules candidates
    // (checked first) must report false so resolution falls through to PATH.
    existsSyncMock.mockImplementation((p: string) => p === cliFromShim);
    findInPathMock.mockReturnValue(shimPath);

    const rt = new PiRuntime();
    rt.spawn(spawnConfig());

    const call = lastSpawn()!;
    expect(call.file).toBe(process.execPath);
    expect(call.args[0]).toBe(cliFromShim);
  });

  it("uses the shim itself when its underlying cli.js cannot be located", () => {
    existsSyncMock.mockReturnValue(false); // node_modules candidates AND cliFromShim all absent
    const shimPath = "C:\\Users\\dev\\AppData\\Roaming\\npm\\pi.cmd";
    findInPathMock.mockReturnValue(shimPath);

    const rt = new PiRuntime();
    rt.spawn(spawnConfig());

    const call = lastSpawn()!;
    expect(call.file).toBe(shimPath);
    expect(call.args[0]).toBe("--tools");
  });

  it("logs an actionable error and falls back to a bare binary name when pi is nowhere to be found", () => {
    existsSyncMock.mockReturnValue(false);
    findInPathMock.mockReturnValue(undefined);

    const rt = new PiRuntime();
    rt.spawn(spawnConfig());

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("pi CLI not found"));
    const call = lastSpawn()!;
    const expectedFallback = process.platform === "win32" ? "pi.cmd" : "pi";
    expect(call.file).toBe(expectedFallback);
    expect(call.args[0]).toBe("--tools");
  });
});
