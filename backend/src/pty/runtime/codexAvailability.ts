import { findInPath } from "./findInPath.js";

const CODEX_BIN_NAMES =
  process.platform === "win32"
    ? ["codex.cmd", "codex.exe", "codex.bat", "codex"]
    : ["codex"];

let cached: boolean | undefined;

/** Clear cache (tests). */
export function resetCodexAvailabilityCache(): void {
  cached = undefined;
}

/**
 * Whether CodexRuntime may be used for nodes with `runtime: "codex"`.
 *
 * - Default: `codex` binary found on the **backend process** PATH.
 * - `PINODES_ORCHESTRA_CODEX=false` — force off (even if installed).
 * - `PINODES_ORCHESTRA_CODEX=true` — force on (tests / explicit opt-in without PATH).
 */
export function isCodexRuntimeAvailable(): boolean {
  if (process.env.PINODES_ORCHESTRA_CODEX === "false") return false;
  if (process.env.PINODES_ORCHESTRA_CODEX === "true") return true;

  if (cached === undefined) {
    cached = findInPath(CODEX_BIN_NAMES) !== undefined;
  }
  return cached;
}
