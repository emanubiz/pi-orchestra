import { describe, expect, it } from "vitest";
import {
  isStructuredRuntime,
  runtimeKind,
  runtimeSessionEndedLabel,
  runtimeStartingLabel,
} from "./runtimeKind";

describe("runtimeKind", () => {
  it("classifies codex as structured", () => {
    expect(isStructuredRuntime("codex")).toBe(true);
    expect(runtimeKind("codex")).toBe("structured");
  });

  it("classifies pi/hermes/claude as pty", () => {
    expect(runtimeKind("pi")).toBe("pty");
    expect(runtimeKind("hermes")).toBe("pty");
    expect(runtimeKind("claude")).toBe("pty");
  });

  it("provides runtime-specific labels", () => {
    expect(runtimeStartingLabel("codex")).toContain("codex session");
    expect(runtimeSessionEndedLabel("codex")).toContain("codex session ended");
  });
});
