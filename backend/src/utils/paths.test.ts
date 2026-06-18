import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBoardCwd, resolveCwd } from "./paths.js";

describe("resolveBoardCwd", () => {
  it("uses graph cwd when it exists", () => {
    expect(resolveBoardCwd("/tmp", "/var")).toBe(path.resolve("/tmp"));
  });

  it("falls back to board cwd when graph cwd is stale", () => {
    expect(resolveBoardCwd("/path/does/not/exist-xyz", "/tmp")).toBe(path.resolve("/tmp"));
  });

  it("throws when both graph and board cwd are invalid", () => {
    expect(() => resolveBoardCwd("/missing-graph", "/missing-board")).toThrow(
      /Not a valid directory/,
    );
  });
});

describe("resolveCwd", () => {
  it("accepts a valid directory", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pinodes-cwd-"));
    expect(resolveCwd(dir)).toBe(path.resolve(dir));
  });
});
