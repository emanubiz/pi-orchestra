import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeRuntime } from "./ClaudeRuntime.js";
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

function argAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
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

describe("ClaudeRuntime", () => {
  beforeEach(() => {
    mockSpawn.mockClear();
    fakePtys.length = 0;
  });

  // ── spawn ──────────────────────────────────────────────────────────────────

  it("spawns claude with system prompt, inline hook settings and permission mode", () => {
    const rt = new ClaudeRuntime();
    rt.spawn(spawnConfig());

    const call = lastSpawn()!;
    expect(call).toBeDefined();
    expect(argAfter(call.args, "--append-system-prompt")).toBe("You are a developer.");
    expect(argAfter(call.args, "--permission-mode")).toBe("acceptEdits");

    // --settings is inline JSON wiring the orchestra hook bridge to the three
    // lifecycle events, with the script path and node binary absolute-quoted.
    const settings = JSON.parse(argAfter(call.args, "--settings")!);
    for (const event of ["SessionStart", "UserPromptSubmit", "Stop"]) {
      const cmd = settings.hooks[event][0].hooks[0];
      expect(cmd.type).toBe("command");
      expect(cmd.command).toContain("orchestra-hook.mjs");
      expect(cmd.command).toContain(JSON.stringify(process.execPath));
    }
  });

  it("uses the Claude default toolset and honours runtimeConfig.toolset", () => {
    const rt = new ClaudeRuntime();
    rt.spawn(spawnConfig());
    expect(argAfter(lastSpawn()!.args, "--allowedTools")).toBe(
      "Read,Edit,Write,Bash,Grep,Glob",
    );

    const rt2 = new ClaudeRuntime();
    rt2.spawn(spawnConfig({ runtimeConfig: { toolset: "Read,Grep" } }));
    expect(argAfter(lastSpawn()!.args, "--allowedTools")).toBe("Read,Grep");

    // Non-string toolset is ignored — untyped JSON never reaches argv raw.
    const rt3 = new ClaudeRuntime();
    rt3.spawn(spawnConfig({ runtimeConfig: { toolset: 42 } }));
    expect(argAfter(lastSpawn()!.args, "--allowedTools")).toBe(
      "Read,Edit,Write,Bash,Grep,Glob",
    );
  });

  it("passes the orchestra env contract (URL, board, node, fallback appendix, token)", () => {
    const old = process.env.PINODES_ORCHESTRA_TOKEN;
    process.env.PINODES_ORCHESTRA_TOKEN = "tok";
    try {
      const rt = new ClaudeRuntime();
      rt.spawn(spawnConfig());
      const env = lastSpawn()!.opts.env as Record<string, string>;
      expect(env.PINODES_ORCHESTRA_URL).toBe("http://localhost:3847");
      expect(env.PINODES_ORCHESTRA_BOARD).toBe("b1");
      expect(env.PINODES_ORCHESTRA_NODE).toBe("n1");
      expect(env.PINODES_ORCHESTRA_FALLBACK_APPENDIX).toContain("Orchestration");
      expect(env.PINODES_ORCHESTRA_TOKEN).toBe("tok");
    } finally {
      if (old === undefined) delete process.env.PINODES_ORCHESTRA_TOKEN;
      else process.env.PINODES_ORCHESTRA_TOKEN = old;
    }
  });

  it("sets pty options (cwd, size, xterm name)", () => {
    const rt = new ClaudeRuntime();
    rt.spawn(spawnConfig({ cols: 120, rows: 40 }));
    expect(lastSpawn()!.opts).toMatchObject({
      name: "xterm-256color",
      cols: 120,
      rows: 40,
      cwd: "/tmp/test",
    });
  });

  // ── shared PTY behaviour (inherited from PtyRuntime) ────────────────────────

  it("streams output and exit through the config callbacks", () => {
    const onOutput = vi.fn();
    const onExit = vi.fn();
    const rt = new ClaudeRuntime();
    rt.spawn(spawnConfig({ onOutput, onExit }));

    const pty = lastPty();
    pty._onData!("hello");
    expect(onOutput).toHaveBeenCalledWith("hello");

    pty._onExit!({ exitCode: 0 });
    expect(onExit).toHaveBeenCalledWith(0);
    expect(rt.isRunning()).toBe(false);
  });

  it("inject uses bracketed paste with the slower Ink-TUI submit delay", () => {
    vi.useFakeTimers();
    try {
      const rt = new ClaudeRuntime();
      rt.spawn(spawnConfig());
      const pty = lastPty();

      rt.inject("do the task");
      expect(pty.writes[pty.writes.length - 1]).toBe("\x1b[200~do the task\x1b[201~");

      // Base delay is 300ms (Ink TUI) — at 200ms the submit must NOT have fired.
      vi.advanceTimersByTime(200);
      expect(pty.writes).not.toContain("\r");
      vi.advanceTimersByTime(200);
      expect(pty.writes).toContain("\r");
    } finally {
      vi.useRealTimers();
    }
  });

  it("kill tears down and markReady/isReady round-trip", () => {
    const rt = new ClaudeRuntime();
    rt.spawn(spawnConfig());
    expect(rt.isReady()).toBe(false);
    rt.markReady();
    expect(rt.isReady()).toBe(true);
    rt.kill();
    expect(lastPty().kill).toHaveBeenCalled();
    expect(rt.isRunning()).toBe(false);
    expect(rt.isReady()).toBe(false);
  });
});
