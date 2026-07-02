import type { NodeRuntime } from "../types";

export type RuntimeKind = "pty" | "structured";

const STRUCTURED_RUNTIMES: ReadonlySet<NodeRuntime> = new Set(["codex"]);

export function isStructuredRuntime(runtime?: NodeRuntime | string | null): boolean {
  return runtime != null && STRUCTURED_RUNTIMES.has(runtime as NodeRuntime);
}

export function runtimeKind(runtime?: NodeRuntime | string | null): RuntimeKind {
  return isStructuredRuntime(runtime) ? "structured" : "pty";
}

export function runtimeStartingLabel(runtime?: string | null): string {
  const rt = runtime ?? "pi";
  if (rt === "codex") return "starting codex session…";
  return `starting ${rt}…`;
}

export function runtimeSessionEndedLabel(runtime?: string | null): string {
  const rt = runtime ?? "pi";
  if (rt === "codex") return "- codex session ended - use Restart -";
  return `- ${rt} session ended - use Restart -`;
}

export const STRUCTURED_INPUT_HINT =
  "Structured runtime — keyboard input is disabled. Use Run or inject to send tasks.";
