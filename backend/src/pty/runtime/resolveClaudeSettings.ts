import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Bundled hook bridge — outside `src/` (shipped as-is, like pi-extensions).
 *  Resolves correctly from src (dev/tsx), dist (build) and the VSIX server/
 *  layout: all keep `claude-hooks/` three levels up from this module. */
const HOOK_SCRIPT = path.resolve(__dirname, "../../../claude-hooks/orchestra-hook.mjs");

/** Hook timeout (seconds). Generous vs the script's own 5s network timeout so
 *  the script always finishes (and fails open) before Claude kills it. */
const HOOK_TIMEOUT_S = 15;

/**
 * The `--settings` payload wiring the orchestra hook bridge to the three
 * lifecycle events. Returned as a JSON *string* — `claude --settings` accepts
 * either a file path or inline JSON, and inline means no temp file, nothing
 * written to `~/.claude`, nothing to clean up.
 *
 * The hook command uses this process's own node binary (`process.execPath`),
 * not `node` from PATH — inside the VSIX-bundled backend there may be no
 * `node` on PATH at all.
 */
export function resolveClaudeSettings(): string {
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(HOOK_SCRIPT)}`;
  const hook = [{ hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_S }] }];
  return JSON.stringify({
    hooks: {
      SessionStart: hook,
      UserPromptSubmit: hook,
      Stop: hook,
    },
  });
}
