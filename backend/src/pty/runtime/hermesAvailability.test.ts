import { afterEach, describe, expect, it, vi } from "vitest";

const findInPathMock = vi.hoisted(() =>
  vi.fn<(names: string | string[]) => string | undefined>(),
);

vi.mock("./findInPath.js", () => ({
  findInPath: (names: string | string[]) => findInPathMock(names),
}));

import {
  isHermesRuntimeAvailable,
  resetHermesAvailabilityCache,
} from "./hermesAvailability.js";

describe("isHermesRuntimeAvailable", () => {
  afterEach(() => {
    delete process.env.PINODES_ORCHESTRA_HERMES;
    resetHermesAvailabilityCache();
    findInPathMock.mockReset();
  });

  it("returns true when hermes is on PATH (default)", () => {
    findInPathMock.mockReturnValue("/usr/local/bin/hermes");
    expect(isHermesRuntimeAvailable()).toBe(true);
    expect(findInPathMock).toHaveBeenCalled();
  });

  it("returns false when hermes is not on PATH", () => {
    findInPathMock.mockReturnValue(undefined);
    expect(isHermesRuntimeAvailable()).toBe(false);
  });

  it("PINODES_ORCHESTRA_HERMES=true forces on without PATH lookup", () => {
    process.env.PINODES_ORCHESTRA_HERMES = "true";
    findInPathMock.mockReturnValue(undefined);
    expect(isHermesRuntimeAvailable()).toBe(true);
    expect(findInPathMock).not.toHaveBeenCalled();
  });

  it("PINODES_ORCHESTRA_HERMES=false forces off even when on PATH", () => {
    process.env.PINODES_ORCHESTRA_HERMES = "false";
    findInPathMock.mockReturnValue("/usr/local/bin/hermes");
    expect(isHermesRuntimeAvailable()).toBe(false);
    expect(findInPathMock).not.toHaveBeenCalled();
  });
});
