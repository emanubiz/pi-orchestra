import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The extension keeps per-loop state in module scope (loopCtx, confirmAttempts),
 * so every test resets modules and re-imports to start clean. Intent is enforced
 * at `agent_end` (the agent finished its whole response), not mid-loop.
 */

type Handler = (payload: unknown) => unknown | Promise<unknown>;

interface OrchestraContext {
  appendix: string;
  canBeFinal: boolean;
  outgoing: Array<{ id: string; handle: string; label: string }>;
  kanban: boolean;
  enforce?: boolean;
}

function createMockPi() {
  const handlers: Record<string, Handler[]> = {};
  const sendUserMessage = vi.fn();
  return {
    on: vi.fn((event: string, cb: Handler) => {
      (handlers[event] ??= []).push(cb);
    }),
    sendUserMessage,
    async _emit(event: string, payload: unknown): Promise<unknown[]> {
      const out: unknown[] = [];
      for (const cb of handlers[event] ?? []) out.push(await cb(payload));
      return out;
    },
  };
}

function jsonRes(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response;
}

function assistantMessage(content: string) {
  return { role: "assistant", content };
}

// Controllable backend behaviour for the fetch stub.
let ctxResponse: OrchestraContext | null = null;
let callAgentOk = true;

function installFetch(): ReturnType<typeof vi.fn> {
  const f = vi.fn(async (url: string) => {
    if (url.includes("/internal/orchestra-context")) {
      return ctxResponse === null ? jsonRes({}, false) : jsonRes(ctxResponse, true);
    }
    if (url.includes("/internal/call-agent")) return jsonRes({ ok: callAgentOk });
    return jsonRes({ ok: true }); // ready, card-status, handoff-failed
  });
  vi.stubGlobal("fetch", f);
  return f as unknown as ReturnType<typeof vi.fn>;
}

async function loadExtension() {
  vi.resetModules();
  const { default: handoffExtension } = await import("./call-agent.js");
  return handoffExtension;
}

function bodyOf(call: unknown[]): Record<string, unknown> {
  return JSON.parse((call[1] as { body: string }).body);
}

function callsTo(fetchMock: ReturnType<typeof vi.fn>, fragment: string): unknown[][] {
  return fetchMock.mock.calls.filter((c) => String(c[0]).includes(fragment));
}

const ctxNonFinal: OrchestraContext = {
  appendix: "\n\n## Orchestration\nHand off downstream.\n",
  canBeFinal: false,
  outgoing: [
    { id: "id-dev", handle: "developer-1", label: "Developer" },
    { id: "id-qa", handle: "qa-1", label: "QA" },
  ],
  kanban: false,
  enforce: true,
};
const ctxFinalOutgoing: OrchestraContext = { ...ctxNonFinal, canBeFinal: true };
const ctxLeaf: OrchestraContext = {
  appendix: "\n\n## Orchestration\nNo outgoing.\n",
  canBeFinal: true,
  outgoing: [],
  kanban: false,
  enforce: true,
};

/** Drive a full loop: before_agent_start (sets ctx) then agent_end (final text). */
async function runLoop(pi: ReturnType<typeof createMockPi>, finalText: string, prompt = "task") {
  await pi._emit("before_agent_start", { prompt, systemPrompt: "ROLE" });
  await pi._emit("agent_end", { messages: [assistantMessage(finalText)] });
}

describe("handoffExtension", () => {
  beforeEach(() => {
    process.env.PINODES_ORCHESTRA_URL = "http://localhost:3847";
    process.env.PINODES_ORCHESTRA_BOARD = "board-1";
    process.env.PINODES_ORCHESTRA_NODE = "node-a";
    process.env.PINODES_ORCHESTRA_MAX_STEER_RETRIES = "2";
    delete process.env.PINODES_ORCHESTRA_FALLBACK_APPENDIX;
    ctxResponse = null;
    callAgentOk = true;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.PINODES_ORCHESTRA_URL;
    delete process.env.PINODES_ORCHESTRA_BOARD;
    delete process.env.PINODES_ORCHESTRA_NODE;
    delete process.env.PINODES_ORCHESTRA_MAX_STEER_RETRIES;
    delete process.env.PINODES_ORCHESTRA_FALLBACK_APPENDIX;
  });

  // ── delivery (at agent_end) ──────────────────────────────────────────────────

  it("delivers a handoff block to the target node", async () => {
    ctxResponse = ctxNonFinal;
    const pi = createMockPi();
    const fetchMock = installFetch();
    (await loadExtension())(pi as never);

    await runLoop(pi, "Plan done.\n@@HANDOFF:developer-1\nImplement the auth module.\n@@END");

    const calls = callsTo(fetchMock, "/internal/call-agent");
    expect(calls).toHaveLength(1);
    expect(bodyOf(calls[0])).toEqual({
      boardId: "board-1",
      fromNodeId: "node-a",
      targetNodeId: "developer-1",
      message: "Implement the auth module.",
    });
  });

  it("delivers a fan-out of multiple handoffs", async () => {
    ctxResponse = ctxNonFinal;
    const pi = createMockPi();
    const fetchMock = installFetch();
    (await loadExtension())(pi as never);

    await runLoop(pi, "@@HANDOFF:developer-1\nBranch A.\n@@END\n\n@@HANDOFF:qa-1\nBranch B.\n@@END");

    const calls = callsTo(fetchMock, "/internal/call-agent");
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => bodyOf(c).targetNodeId).sort()).toEqual(["developer-1", "qa-1"]);
  });

  it("dedups identical handoff blocks within one loop", async () => {
    ctxResponse = ctxNonFinal;
    const pi = createMockPi();
    const fetchMock = installFetch();
    (await loadExtension())(pi as never);

    await runLoop(pi, "@@HANDOFF:dev\nGo.\n@@END\n@@HANDOFF:dev\nGo.\n@@END");
    expect(callsTo(fetchMock, "/internal/call-agent")).toHaveLength(1);
  });

  it("reports card moves to /internal/card-status", async () => {
    ctxResponse = ctxLeaf;
    const pi = createMockPi();
    const fetchMock = installFetch();
    (await loadExtension())(pi as never);

    await runLoop(pi, "Ready for review.\n@@CARD:review\n@@DONE");

    const calls = callsTo(fetchMock, "/internal/card-status");
    expect(calls).toHaveLength(1);
    expect(bodyOf(calls[0])).toEqual({ boardId: "board-1", column: "review" });
  });

  it("ignores a loop with no assistant message", async () => {
    ctxResponse = ctxNonFinal;
    const pi = createMockPi();
    const fetchMock = installFetch();
    (await loadExtension())(pi as never);

    await pi._emit("before_agent_start", { prompt: "task", systemPrompt: "ROLE" });
    await pi._emit("agent_end", { messages: [{ role: "user", content: "@@HANDOFF:x\ny\n@@END" }] });

    expect(callsTo(fetchMock, "/internal/call-agent")).toHaveLength(0);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("extracts text from array content", async () => {
    ctxResponse = ctxNonFinal;
    const pi = createMockPi();
    const fetchMock = installFetch();
    (await loadExtension())(pi as never);

    await pi._emit("before_agent_start", { prompt: "task", systemPrompt: "ROLE" });
    await pi._emit("agent_end", {
      messages: [{ role: "assistant", content: [{ type: "text", text: "@@HANDOFF:dev\nGo.\n@@END" }] }],
    });

    const calls = callsTo(fetchMock, "/internal/call-agent");
    expect(calls).toHaveLength(1);
    expect(bodyOf(calls[0]).message).toBe("Go.");
  });

  it("does not retry a deterministic rejection (ok:false)", async () => {
    ctxResponse = ctxNonFinal;
    callAgentOk = false;
    const pi = createMockPi();
    const fetchMock = installFetch();
    (await loadExtension())(pi as never);

    await runLoop(pi, "@@HANDOFF:nope\nGo.\n@@END");
    expect(callsTo(fetchMock, "/internal/call-agent")).toHaveLength(1);
  });

  it("retries a network error with backoff, then succeeds", async () => {
    ctxResponse = ctxNonFinal;
    const pi = createMockPi();
    let attempts = 0;
    const f = vi.fn(async (url: string) => {
      if (url.includes("/internal/orchestra-context")) return jsonRes(ctxNonFinal, true);
      if (url.includes("/internal/call-agent")) {
        attempts += 1;
        if (attempts < 3) throw new Error("network down");
        return jsonRes({ ok: true });
      }
      return jsonRes({ ok: true });
    });
    vi.stubGlobal("fetch", f);
    (await loadExtension())(pi as never);

    await runLoop(pi, "@@HANDOFF:dev\nGo.\n@@END");
    expect(attempts).toBe(3);
  });

  // ── before_agent_start: per-loop system prompt ───────────────────────────────

  it("appends the fetched appendix to the system prompt each loop", async () => {
    ctxResponse = ctxNonFinal;
    const pi = createMockPi();
    installFetch();
    (await loadExtension())(pi as never);

    const [result] = (await pi._emit("before_agent_start", {
      prompt: "do the task",
      systemPrompt: "ROLE PROMPT",
    })) as Array<{ systemPrompt: string }>;

    expect(result.systemPrompt).toContain("ROLE PROMPT");
    expect(result.systemPrompt).toContain("## Orchestration");
  });

  it("falls back to the baked appendix when the context fetch fails", async () => {
    ctxResponse = null;
    process.env.PINODES_ORCHESTRA_FALLBACK_APPENDIX = "\n\nBAKED FALLBACK";
    const pi = createMockPi();
    installFetch();
    (await loadExtension())(pi as never);

    const [result] = (await pi._emit("before_agent_start", {
      prompt: "do the task",
      systemPrompt: "ROLE",
    })) as Array<{ systemPrompt: string }>;

    expect(result.systemPrompt).toBe("ROLE\n\n<!--orchestra:appendix-->\n\nBAKED FALLBACK<!--/orchestra:appendix-->");
  });

  it("does not accumulate the appendix across loops", async () => {
    ctxResponse = ctxNonFinal;
    const pi = createMockPi();
    installFetch();
    (await loadExtension())(pi as never);

    const [r1] = (await pi._emit("before_agent_start", {
      prompt: "task",
      systemPrompt: "ROLE",
    })) as Array<{ systemPrompt: string }>;
    const [r2] = (await pi._emit("before_agent_start", {
      prompt: "task 2",
      systemPrompt: r1.systemPrompt,
    })) as Array<{ systemPrompt: string }>;

    expect(r2.systemPrompt.split("## Orchestration").length - 1).toBe(1);
    expect(r2.systemPrompt.startsWith("ROLE")).toBe(true);
  });

  // ── session_start: ready marker ─────────────────────────────────────────────

  it("reports ready on session_start", async () => {
    const pi = createMockPi();
    const fetchMock = installFetch();
    (await loadExtension())(pi as never);

    await pi._emit("session_start", {});
    const calls = callsTo(fetchMock, "/internal/ready");
    expect(calls).toHaveLength(1);
    expect(bodyOf(calls[0])).toEqual({ boardId: "board-1", nodeId: "node-a" });
  });

  // ── intent watchdog (at agent_end) ───────────────────────────────────────────

  it("does not ask when the node handed off", async () => {
    ctxResponse = ctxNonFinal;
    const pi = createMockPi();
    installFetch();
    (await loadExtension())(pi as never);

    await runLoop(pi, "@@HANDOFF:developer-1\nImplement.\n@@END");
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("does not ask a final node that explicitly said @@DONE", async () => {
    ctxResponse = ctxFinalOutgoing;
    const pi = createMockPi();
    installFetch();
    (await loadExtension())(pi as never);

    await runLoop(pi, "Reviewed, all good.\n@@DONE");
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("does not ask a pure leaf node that ends silently", async () => {
    ctxResponse = ctxLeaf;
    const pi = createMockPi();
    installFetch();
    (await loadExtension())(pi as never);

    await runLoop(pi, "Finished the standalone task.");
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("asks a final-with-outgoing node that ended ambiguously", async () => {
    ctxResponse = ctxFinalOutgoing;
    const pi = createMockPi();
    installFetch();
    (await loadExtension())(pi as never);

    await runLoop(pi, "I think that covers it.");
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    const [text] = pi.sendUserMessage.mock.calls[0];
    expect(text).toContain("@@DONE");
    expect(text).toContain("developer-1");
  });

  it("asks a non-final node that emitted no handoff", async () => {
    ctxResponse = ctxNonFinal;
    const pi = createMockPi();
    installFetch();
    (await loadExtension())(pi as never);

    await runLoop(pi, "I'm finished.");
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    const [text] = pi.sendUserMessage.mock.calls[0];
    expect(text).toContain("developer-1");
    expect(text).toContain("qa-1");
  });

  it("rejects @@DONE from a non-final node (asks it to hand off)", async () => {
    ctxResponse = ctxNonFinal;
    const pi = createMockPi();
    installFetch();
    (await loadExtension())(pi as never);

    await runLoop(pi, "All done here.\n@@DONE");
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    const [text] = pi.sendUserMessage.mock.calls[0];
    expect(text).toContain("NON-TERMINAL");
  });

  it("escalates to handoff-failed after the confirm cap (non-final)", async () => {
    ctxResponse = ctxNonFinal;
    const pi = createMockPi();
    const fetchMock = installFetch();
    (await loadExtension())(pi as never);

    await runLoop(pi, "nope", "task"); // ask 1
    await runLoop(pi, "still nope", "[orchestra:confirm] hand off"); // ask 2
    await runLoop(pi, "really nope", "[orchestra:confirm] hand off"); // cap → fail

    expect(pi.sendUserMessage).toHaveBeenCalledTimes(2);
    const failCalls = callsTo(fetchMock, "/internal/handoff-failed");
    expect(failCalls).toHaveLength(1);
    expect(bodyOf(failCalls[0])).toMatchObject({
      boardId: "board-1",
      nodeId: "node-a",
      reason: "no-handoff-after-retries",
    });
  });

  it("resets the confirm counter for a genuine new task", async () => {
    ctxResponse = ctxNonFinal;
    const pi = createMockPi();
    installFetch();
    (await loadExtension())(pi as never);

    await runLoop(pi, "nope", "task"); // ask 1
    await runLoop(pi, "nope again", "brand new task"); // counter reset → ask 1 again
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(2); // never escalated
  });

  it("does not enforce when the context is unavailable", async () => {
    ctxResponse = null;
    const pi = createMockPi();
    installFetch();
    (await loadExtension())(pi as never);

    await runLoop(pi, "no handoff here");
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("does not enforce when the watchdog is disabled for the node (free chat)", async () => {
    ctxResponse = { ...ctxNonFinal, enforce: false };
    const pi = createMockPi();
    installFetch();
    (await loadExtension())(pi as never);

    await runLoop(pi, "just chatting, no handoff");
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("still delivers handoffs even when the watchdog is disabled", async () => {
    ctxResponse = { ...ctxNonFinal, enforce: false };
    const pi = createMockPi();
    const fetchMock = installFetch();
    (await loadExtension())(pi as never);

    await runLoop(pi, "@@HANDOFF:developer-1\nGo.\n@@END");
    expect(callsTo(fetchMock, "/internal/call-agent")).toHaveLength(1);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });
});
