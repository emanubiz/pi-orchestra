import { findInPath } from "./findInPath.js";

const HERMES_BIN_NAMES =
  process.platform === "win32"
    ? ["hermes.cmd", "hermes.exe", "hermes.bat", "hermes"]
    : ["hermes"];

let cached: boolean | undefined;

/** Clear cache (tests). */
export function resetHermesAvailabilityCache(): void {
  cached = undefined;
}

/**
 * Whether HermesRuntime may be used for nodes with `runtime: "hermes"`.
 *
 * - Default: `hermes` binary found on the **backend process** PATH.
 * - `PINODES_ORCHESTRA_HERMES=false` — force off (even if installed).
 * - `PINODES_ORCHESTRA_HERMES=true` — force on (tests / explicit opt-in without PATH).
 */
export function isHermesRuntimeAvailable(): boolean {
  if (process.env.PINODES_ORCHESTRA_HERMES === "false") return false;
  if (process.env.PINODES_ORCHESTRA_HERMES === "true") return true;

  if (cached === undefined) {
    cached = findInPath(HERMES_BIN_NAMES) !== undefined;
  }
  return cached;
}
