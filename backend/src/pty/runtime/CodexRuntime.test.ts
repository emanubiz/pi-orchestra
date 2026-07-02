import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeSpawnConfig } from "./INodeRuntime.js";

const spawnMock = vi.hoisted(() =>
  vi.fn<
    (
      cmd: string,
      args: string[],
      opts: { cwd: string; env: NodeJS.ProcessEnv; stdio: string[] },
    ) => FakeChild
  >(),
);

interface FakeChild extends EventEmitter {
  stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = { write: vi.fn(), end: vi.fn() };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

vi.mock("node:child_process", () => ({
  spawn: (...args: Parameters<typeof spawnMock>) => spawnMock(...args),
}));

vi.mock("./codexAvailability.js", () => ({
  isCodexRuntimeAvailable: vi.fn(() => true),
}));

vi.mock("./findInPath.js", () => ({
  findInPath: vi.fn(() => "/usr/local/bin/codex"),
}));

import { CodexRuntime } from "./CodexRuntime.js";
import { isCodexRuntimeAvailable } from "./codexAvailability.js";

function baseConfig(overrides: Partial<RuntimeSpawnConfig> = {}): RuntimeSpawnConfig {
  return {
    boardId: "b1",
    nodeId: "n1",
    label: "dev",
    cwd: "/repo",
    cols: 80,
    rows: 24,
    systemPrompt: "You are a developer.",
    appendix: "Recipients: qa",
    orchestraUrl: "http://localhost:3847",
    onOutput: vi.fn(),
    onExit: vi.fn(),
    ...overrides,
  };
}

describe("CodexRuntime", () => {
  beforeEach(() => {
    vi.mocked(isCodexRuntimeAvailable).mockReturnValue(true);
    spawnMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("spawn marks structured session ready and calls onReady", () => {
    const onReady = vi.fn();
    const config = baseConfig({ orchestration: { onReady } });
    const rt = new CodexRuntime();
    expect(rt.kind).toBe("structured");

    rt.spawn(config);

    expect(rt.isRunning()).toBe(true);
    expect(rt.isReady()).toBe(true);
    expect(onReady).toHaveBeenCalled();
    expect(config.onOutput).toHaveBeenCalledWith(expect.stringContaining("codex session ready"));
  });

  it("spawn fails clearly when codex is unavailable", () => {
    vi.mocked(isCodexRuntimeAvailable).mockReturnValue(false);
    const config = baseConfig();
    const rt = new CodexRuntime();
    rt.spawn(config);

    expect(rt.isRunning()).toBe(false);
    expect(config.onOutput).toHaveBeenCalledWith(expect.stringContaining("CLI not found"));
    expect(config.onExit).toHaveBeenCalledWith(1);
  });

  it("inject spawns codex exec --json and streams assistant output", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const onTurnStarted = vi.fn();
    const onTurnEnded = vi.fn();
    const config = baseConfig({
      orchestration: { onTurnStarted, onTurnEnded },
    });
    const rt = new CodexRuntime();
    rt.spawn(config);

    rt.inject("Implement the API");

    expect(spawnMock).toHaveBeenCalledWith(
      "/usr/local/bin/codex",
      expect.arrayContaining(["exec", "--json", "--sandbox", "workspace-write", "-"]),
      expect.objectContaining({ cwd: "/repo" }),
    );
    expect(child.stdin.write).toHaveBeenCalledWith(expect.stringContaining("Implement the API"));

    child.stdout.emit(
      "data",
      Buffer.from(
        [
          '{"type":"thread.started","thread_id":"thread-abc"}',
          '{"type":"turn.started"}',
          '{"type":"item.completed","item":{"id":"1","type":"agent_message","text":"Done.\\n"}}',
          '{"type":"turn.completed"}',
        ].join("\n") + "\n",
      ),
    );

    await new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      child.emit("close", 0, null);
    });

    expect(onTurnStarted).toHaveBeenCalled();
    expect(onTurnEnded).toHaveBeenCalledWith(false);
    expect(config.onOutput).toHaveBeenCalledWith(expect.stringContaining("Done."));
  });

  it("delivers handoffs from final assistant text", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const deliverHandoff = vi.fn(() => ({ ok: true }));
    const onTurnEnded = vi.fn();
    const config = baseConfig({
      orchestration: { deliverHandoff, onTurnEnded },
    });
    const rt = new CodexRuntime();
    rt.spawn(config);
    rt.inject("hand off");

    child.stdout.emit(
      "data",
      Buffer.from(
        [
          '{"type":"turn.started"}',
          '{"type":"item.completed","item":{"type":"agent_message","text":"@@HANDOFF:qa-1\\nReview this.\\n@@END"}}',
          '{"type":"turn.completed"}',
        ].join("\n") + "\n",
      ),
    );
    await new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      child.emit("close", 0, null);
    });

    expect(deliverHandoff).toHaveBeenCalledWith("qa-1", "Review this.");
    expect(onTurnEnded).toHaveBeenCalledWith(true);
  });

  it("kill cancels active turn process", () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const rt = new CodexRuntime();
    rt.spawn(baseConfig());
    rt.inject("work");
    rt.kill();

    expect(child.kill).toHaveBeenCalled();
    expect(rt.isRunning()).toBe(false);
  });

  it("write ignores keyboard input (structured runtime uses inject only)", () => {
    const config = baseConfig();
    const rt = new CodexRuntime();
    rt.spawn(config);
    rt.write("typed from keyboard\n");

    expect(spawnMock).not.toHaveBeenCalled();
    expect(config.onOutput).toHaveBeenCalledWith(
      expect.stringContaining("Keyboard input ignored"),
    );
  });

  it("resize is a no-op but size() returns last dimensions", () => {
    const rt = new CodexRuntime();
    rt.spawn(baseConfig({ cols: 100, rows: 40 }));
    rt.resize(120, 50);
    expect(rt.size()).toEqual({ cols: 120, rows: 50 });
  });
});
