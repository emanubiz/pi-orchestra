import { describe, it, expect } from "vitest";
import { resolveSessionToken } from "./sessionToken.js";

describe("resolveSessionToken", () => {
  it("returns the configured token when present", () => {
    expect(resolveSessionToken("my-secret")).toBe("my-secret");
  });

  it("returns the configured token with surrounding whitespace trimmed", () => {
    expect(resolveSessionToken("  my-secret  ")).toBe("my-secret");
  });

  it("generates an ephemeral UUID when configured is undefined", () => {
    const token = resolveSessionToken(undefined);
    expect(token).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("generates an ephemeral UUID when configured is empty string", () => {
    const token = resolveSessionToken("");
    expect(token).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("generates an ephemeral UUID when configured is whitespace-only", () => {
    const token = resolveSessionToken("   ");
    expect(token).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("generates different tokens on successive calls when unconfigured", () => {
    const a = resolveSessionToken(undefined);
    const b = resolveSessionToken(undefined);
    expect(a).not.toBe(b);
  });
});
