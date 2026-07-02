import { describe, expect, it } from "vitest";
import { assertPathAllowed, loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("uses safe defaults", () => {
    const config = loadConfig({});
    expect(config.baseUrl).toBe("http://127.0.0.1:3847");
    expect(config.token).toBeNull();
    expect(config.allowedRoots).toEqual([]);
    expect(config.mode).toBe("safe");
  });

  it("normalizes URL, roots, mode and timeout", () => {
    const config = loadConfig({
      PINODES_ORCHESTRA_URL: "http://localhost:3847///",
      PINODES_ORCHESTRA_TOKEN: "tok",
      PINODES_ORCHESTRA_ALLOWED_ROOTS: "/tmp,/home/emanu/Scrivania/Workspace",
      PINODES_ORCHESTRA_MCP_MODE: "full",
      PINODES_ORCHESTRA_TIMEOUT_MS: "5000",
    });
    expect(config.baseUrl).toBe("http://localhost:3847");
    expect(config.token).toBe("tok");
    expect(config.allowedRoots).toContain("/tmp");
    expect(config.mode).toBe("full");
    expect(config.timeoutMs).toBe(5000);
  });
});

describe("assertPathAllowed", () => {
  it("allows any path when no roots are configured", () => {
    const config = loadConfig({});
    expect(assertPathAllowed("/etc", config)).toBe("/etc");
  });

  it("allows paths under configured roots", () => {
    const config = loadConfig({ PINODES_ORCHESTRA_ALLOWED_ROOTS: "/workspace" });
    expect(assertPathAllowed("/workspace/project", config)).toBe("/workspace/project");
  });

  it("rejects paths outside configured roots", () => {
    const config = loadConfig({ PINODES_ORCHESTRA_ALLOWED_ROOTS: "/workspace" });
    expect(() => assertPathAllowed("/etc", config)).toThrow(/outside PINODES_ORCHESTRA_ALLOWED_ROOTS/);
  });
});
