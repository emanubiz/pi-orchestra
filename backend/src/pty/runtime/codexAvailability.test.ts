import { afterEach, describe, expect, it, vi } from "vitest";

const findInPathMock = vi.hoisted(() =>
  vi.fn<(names: string | string[]) => string | undefined>(),
);

vi.mock("./findInPath.js", () => ({
  findInPath: (names: string | string[]) => findInPathMock(names),
}));

import {
  isCodexRuntimeAvailable,
  resetCodexAvailabilityCache,
} from "./codexAvailability.js";

describe("isCodexRuntimeAvailable", () => {
  afterEach(() => {
    delete process.env.PINODES_ORCHESTRA_CODEX;
    resetCodexAvailabilityCache();
    findInPathMock.mockReset();
  });

  it("returns true when codex is on PATH (default)", () => {
    findInPathMock.mockReturnValue("/usr/local/bin/codex");
    expect(isCodexRuntimeAvailable()).toBe(true);
    expect(findInPathMock).toHaveBeenCalled();
  });

  it("returns false when codex is not on PATH", () => {
    findInPathMock.mockReturnValue(undefined);
    expect(isCodexRuntimeAvailable()).toBe(false);
  });

  it("PINODES_ORCHESTRA_CODEX=true forces on without PATH lookup", () => {
    process.env.PINODES_ORCHESTRA_CODEX = "true";
    findInPathMock.mockReturnValue(undefined);
    expect(isCodexRuntimeAvailable()).toBe(true);
    expect(findInPathMock).not.toHaveBeenCalled();
  });

  it("PINODES_ORCHESTRA_CODEX=false forces off even when on PATH", () => {
    process.env.PINODES_ORCHESTRA_CODEX = "false";
    findInPathMock.mockReturnValue("/usr/local/bin/codex");
    expect(isCodexRuntimeAvailable()).toBe(false);
    expect(findInPathMock).not.toHaveBeenCalled();
  });
});
