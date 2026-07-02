import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleEvent,
  hasExplicitDone,
  lastAssistantTextFromTranscript,
  parseCards,
  parseHandoffs,
} from "./orchestra-hook.mjs";

/** fetch mock that records calls and answers ok with an optional JSON body. */
function makeFetch(jsonByPath = {}) {
  const calls = [];
  const impl = vi.fn(async (url, opts = {}) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: opts.method ?? "GET", body: opts.body ? JSON.parse(opts.body) : undefined });
    return {
      ok: true,
      json: async () => jsonByPath[path] ?? {},
    };
  });
  return { impl, calls };
}

const callsTo = (calls, path) => calls.filter((c) => c.path === path);

describe("sentinel parsing (same contract as call-agent.ts)", () => {
  it("parses one and many @@HANDOFF blocks", () => {
    const one = parseHandoffs("Done.\n@@HANDOFF:developer-1\nImplement the API.\n@@END");
    expect(one).toEqual([{ recipient: "developer-1", message: "Implement the API." }]);

    const many = parseHandoffs(
      "@@HANDOFF:dev-1\ntask A\n@@END\nprose\n@@HANDOFF:qa-1\ntask B\n@@END",
    );
    expect(many.map((h) => h.recipient)).toEqual(["dev-1", "qa-1"]);
  });

  it("ignores empty recipients/messages and returns [] on plain prose", () => {
    expect(parseHandoffs("no sentinels here")).toEqual([]);
    expect(parseHandoffs("@@HANDOFF:dev-1\n   \n@@END")).toEqual([]);
  });

  it("parses @@CARD columns", () => {
    expect(parseCards("moving on @@CARD:in_progress rest")).toEqual(["in_progress"]);
    expect(parseCards("@@CARD:test\n@@CARD:done")).toEqual(["test", "done"]);
  });

  it("hasExplicitDone only matches @@DONE alone on the last non-empty line", () => {
    expect(hasExplicitDone("All finished.\n@@DONE\n")).toBe(true);
    expect(hasExplicitDone("I would say @@DONE if I were done")).toBe(false);
    expect(hasExplicitDone("@@DONE\nbut then more text")).toBe(false);
  });
});

describe("transcript parsing", () => {
  const entry = (type, role, content) =>
    JSON.stringify({ type, message: { role, content } });

  it("returns the LAST assistant text (the loop's final answer)", () => {
    const jsonl = [
      entry("user", "user", "do the thing"),
      entry("assistant", "assistant", [{ type: "text", text: "thinking…" }]),
      entry("assistant", "assistant", [
        { type: "text", text: "Done. " },
        { type: "text", text: "@@DONE" },
      ]),
    ].join("\n");
    expect(lastAssistantTextFromTranscript(jsonl)).toBe("Done. @@DONE");
  });

  it("skips malformed lines and assistant entries with no text (tool-only)", () => {
    const jsonl = [
      entry("assistant", "assistant", [{ type: "text", text: "real answer" }]),
      "{not json",
      entry("assistant", "assistant", [{ type: "tool_use", name: "Bash" }]),
    ].join("\n");
    expect(lastAssistantTextFromTranscript(jsonl)).toBe("real answer");
  });

  it("supports plain string content", () => {
    const jsonl = entry("assistant", "assistant", "string body");
    expect(lastAssistantTextFromTranscript(jsonl)).toBe("string body");
  });

  it("returns empty string on an empty/unparseable transcript", () => {
    expect(lastAssistantTextFromTranscript("")).toBe("");
  });
});

describe("handleEvent", () => {
  beforeEach(() => {
    process.env.PINODES_ORCHESTRA_BOARD = "board-1";
    process.env.PINODES_ORCHESTRA_NODE = "node-a";
  });

  it("SessionStart → POST /internal/ready", async () => {
    const { impl, calls } = makeFetch();
    await handleEvent({ hook_event_name: "SessionStart" }, { fetch: impl });
    expect(callsTo(calls, "/internal/ready")).toHaveLength(1);
  });

  it("UserPromptSubmit → turn-started + additionalContext from orchestra-context", async () => {
    const { impl, calls } = makeFetch({
      "/internal/orchestra-context": { appendix: "## Recipients\n- dev-1" },
    });
    const out = await handleEvent(
      { hook_event_name: "UserPromptSubmit", prompt: "task" },
      { fetch: impl },
    );
    expect(callsTo(calls, "/internal/turn-started")).toHaveLength(1);
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "## Recipients\n- dev-1",
      },
    });
  });

  it("UserPromptSubmit fails open when the backend is unreachable", async () => {
    const impl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const out = await handleEvent(
      { hook_event_name: "UserPromptSubmit", prompt: "task" },
      { fetch: impl },
    );
    expect(out).toBeNull(); // no output, no throw — the agent proceeds
  });

  it("Stop → delivers handoffs + cards from the transcript, then turn-ended(true)", async () => {
    const { impl, calls } = makeFetch();
    const transcript = [
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "@@CARD:review\nHanding off.\n@@HANDOFF:qa-1\nVerify it.\n@@END" },
          ],
        },
      }),
    ].join("\n");

    await handleEvent(
      { hook_event_name: "Stop", transcript_path: "/fake/transcript.jsonl" },
      { fetch: impl, readFile: () => transcript },
    );

    const handoffs = callsTo(calls, "/internal/call-agent");
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0].body).toEqual({
      boardId: "board-1",
      fromNodeId: "node-a",
      targetNodeId: "qa-1",
      message: "Verify it.",
    });
    expect(callsTo(calls, "/internal/card-status")[0].body.column).toBe("review");

    const ended = callsTo(calls, "/internal/turn-ended");
    expect(ended).toHaveLength(1);
    expect(ended[0].body.handoffCalledThisTurn).toBe(true);
  });

  it("Stop with no handoff reports handoffCalledThisTurn=false", async () => {
    const { impl, calls } = makeFetch();
    await handleEvent(
      { hook_event_name: "Stop", transcript_path: "/fake" },
      {
        fetch: impl,
        readFile: () =>
          JSON.stringify({
            type: "assistant",
            message: { role: "assistant", content: [{ type: "text", text: "just prose" }] },
          }),
      },
    );
    expect(callsTo(calls, "/internal/call-agent")).toHaveLength(0);
    expect(callsTo(calls, "/internal/turn-ended")[0].body.handoffCalledThisTurn).toBe(false);
  });

  it("Stop still posts turn-ended when the transcript is unreadable", async () => {
    const { impl, calls } = makeFetch();
    await handleEvent(
      { hook_event_name: "Stop", transcript_path: "/gone" },
      {
        fetch: impl,
        readFile: () => {
          throw new Error("ENOENT");
        },
      },
    );
    expect(callsTo(calls, "/internal/turn-ended")).toHaveLength(1);
  });

  it("unknown events are a no-op", async () => {
    const { impl, calls } = makeFetch();
    const out = await handleEvent({ hook_event_name: "PreToolUse" }, { fetch: impl });
    expect(out).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
