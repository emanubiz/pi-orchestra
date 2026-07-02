import { describe, expect, it } from "vitest";
import {
  extractAssistantText,
  extractThreadId,
  formatCodexEvent,
  parseCodexJsonLine,
} from "./codexEventFormat.js";

describe("codexEventFormat", () => {
  it("parses JSONL lines", () => {
    expect(parseCodexJsonLine('{"type":"turn.started"}')).toEqual({ type: "turn.started" });
    expect(parseCodexJsonLine("")).toBeNull();
    expect(parseCodexJsonLine("not-json")).toBeNull();
  });

  it("extracts thread id", () => {
    expect(
      extractThreadId({ type: "thread.started", thread_id: "t-1" }),
    ).toBe("t-1");
  });

  it("formats command and agent_message events", () => {
    expect(
      formatCodexEvent({
        type: "item.started",
        item: { type: "command_execution", command: "npm test" },
      }),
    ).toContain("npm test");

    expect(
      formatCodexEvent({
        type: "item.completed",
        item: { type: "agent_message", text: "hello" },
      }),
    ).toBe("hello\n");
  });

  it("extracts assistant text from completed agent_message", () => {
    const event = {
      type: "item.completed",
      item: { type: "agent_message", text: "final answer" },
    };
    expect(extractAssistantText(event, "")).toBe("final answer");
  });
});
