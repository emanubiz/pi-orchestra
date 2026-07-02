import { findInPath } from "./findInPath.js";

const CLAUDE_BIN_NAMES =
  process.platform === "win32"
    ? ["claude.cmd", "claude.exe", "claude.bat", "claude"]
    : ["claude"];

let cached: boolean | undefined;

/** Clear cache (tests). */
export function resetClaudeAvailabilityCache(): void {
  cached = undefined;
}

/**
 * Whether ClaudeRuntime may be used for nodes with `runtime: "claude"`.
 *
 * - Default: `claude` binary found on the **backend process** PATH.
 * - `PINODES_ORCHESTRA_CLAUDE=false` — force off (even if installed).
 * - `PINODES_ORCHESTRA_CLAUDE=true` — force on (tests / explicit opt-in without PATH).
 */
export function isClaudeRuntimeAvailable(): boolean {
  if (process.env.PINODES_ORCHESTRA_CLAUDE === "false") return false;
  if (process.env.PINODES_ORCHESTRA_CLAUDE === "true") return true;

  if (cached === undefined) {
    cached = findInPath(CLAUDE_BIN_NAMES) !== undefined;
  }
  return cached;
}
