import { describe, expect, it } from "vitest";
import { hasExplicitDone, parseCards, parseHandoffs } from "./sentinels.js";

describe("sentinels (shared Orchestra contract)", () => {
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
