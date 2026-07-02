import { afterEach, describe, expect, it, vi } from "vitest";

const findInPathMock = vi.hoisted(() =>
  vi.fn<(names: string | string[]) => string | undefined>(),
);

vi.mock("./findInPath.js", () => ({
  findInPath: (names: string | string[]) => findInPathMock(names),
}));

import {
  isClaudeRuntimeAvailable,
  resetClaudeAvailabilityCache,
} from "./claudeAvailability.js";

describe("isClaudeRuntimeAvailable", () => {
  afterEach(() => {
    delete process.env.PINODES_ORCHESTRA_CLAUDE;
    resetClaudeAvailabilityCache();
    findInPathMock.mockReset();
  });

  it("returns true when claude is on PATH (default)", () => {
    findInPathMock.mockReturnValue("/usr/local/bin/claude");
    expect(isClaudeRuntimeAvailable()).toBe(true);
    expect(findInPathMock).toHaveBeenCalled();
  });

  it("returns false when claude is not on PATH", () => {
    findInPathMock.mockReturnValue(undefined);
    expect(isClaudeRuntimeAvailable()).toBe(false);
  });

  it("PINODES_ORCHESTRA_CLAUDE=true forces on without PATH lookup", () => {
    process.env.PINODES_ORCHESTRA_CLAUDE = "true";
    findInPathMock.mockReturnValue(undefined);
    expect(isClaudeRuntimeAvailable()).toBe(true);
    expect(findInPathMock).not.toHaveBeenCalled();
  });

  it("PINODES_ORCHESTRA_CLAUDE=false forces off even when on PATH", () => {
    process.env.PINODES_ORCHESTRA_CLAUDE = "false";
    findInPathMock.mockReturnValue("/usr/local/bin/claude");
    expect(isClaudeRuntimeAvailable()).toBe(false);
    expect(findInPathMock).not.toHaveBeenCalled();
  });
});
