import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { auditToolCall } from "../src/audit.js";

const ORIGINAL_ENV = process.env;

describe("auditToolCall", () => {
  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.restoreAllMocks();
  });

  it("writes mutative tool calls to JSONL", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pinodes-audit-"));
    const auditPath = path.join(dir, "audit.jsonl");
    process.env = { ...ORIGINAL_ENV, PINODES_ORCHESTRA_MCP_AUDIT_LOG: auditPath };

    auditToolCall("orchestra_run_board", { boardId: "b1", message: "go" });

    const [line] = fs.readFileSync(auditPath, "utf8").trim().split("\n");
    const entry = JSON.parse(line);
    expect(entry).toMatchObject({
      actor: "mcp",
      tool: "orchestra_run_board",
      input: { boardId: "b1", message: "go" },
    });
    expect(Date.parse(entry.ts)).not.toBeNaN();
  });

  it("ignores read-only tools and never throws on write failure", () => {
    const append = vi.spyOn(fs, "appendFileSync").mockImplementation(() => {
      throw new Error("disk full");
    });

    expect(() => auditToolCall("orchestra_health", {})).not.toThrow();
    expect(append).not.toHaveBeenCalled();
    expect(() => auditToolCall("orchestra_stop_board", { boardId: "b1" })).not.toThrow();
  });
});
