import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";

const existsSyncMock = vi.hoisted(() => vi.fn((_p: string) => false));
const statSyncMock = vi.hoisted(() => vi.fn((_p: string): { isFile: () => boolean } => ({ isFile: () => true })));

vi.mock("node:fs", () => ({
  default: {
    existsSync: (p: string) => existsSyncMock(p),
    statSync: (p: string) => statSyncMock(p),
  },
}));

import { findInPath } from "./findInPath.js";

describe("findInPath", () => {
  const oldPath = process.env.PATH;

  beforeEach(() => {
    existsSyncMock.mockReset().mockReturnValue(false);
    statSyncMock.mockReset().mockReturnValue({ isFile: () => true });
  });

  afterEach(() => {
    process.env.PATH = oldPath;
  });

  it("finds a single name in one of several PATH directories", () => {
    process.env.PATH = ["/usr/bin", "/opt/bin", "/usr/local/bin"].join(
      path.delimiter,
    );
    existsSyncMock.mockImplementation((p: string) => p === "/opt/bin/pi");

    expect(findInPath("pi")).toBe("/opt/bin/pi");
  });

  it("tries each candidate name per directory before moving to the next dir", () => {
    process.env.PATH = ["/usr/bin", "/opt/bin"].join(path.delimiter);
    existsSyncMock.mockImplementation((p: string) => p === "/opt/bin/pi.cmd");

    expect(findInPath(["pi", "pi.cmd"])).toBe("/opt/bin/pi.cmd");
  });

  it("returns the first PATH dir's match, not a later one", () => {
    process.env.PATH = ["/usr/bin", "/opt/bin"].join(path.delimiter);
    existsSyncMock.mockImplementation((p: string) => p === "/usr/bin/pi" || p === "/opt/bin/pi");

    expect(findInPath("pi")).toBe("/usr/bin/pi");
  });

  it("skips a matching path that is not a regular file (e.g. a directory)", () => {
    process.env.PATH = ["/usr/bin", "/opt/bin"].join(path.delimiter);
    existsSyncMock.mockImplementation((p: string) => p === "/usr/bin/pi" || p === "/opt/bin/pi");
    statSyncMock.mockImplementation((p: string) => ({ isFile: () => p !== "/usr/bin/pi" }));

    expect(findInPath("pi")).toBe("/opt/bin/pi");
  });

  it("returns undefined when nothing matches", () => {
    process.env.PATH = ["/usr/bin", "/opt/bin"].join(path.delimiter);
    existsSyncMock.mockReturnValue(false);

    expect(findInPath("pi")).toBeUndefined();
  });

  it("returns undefined for an empty PATH", () => {
    process.env.PATH = "";
    expect(findInPath("pi")).toBeUndefined();
  });
});
