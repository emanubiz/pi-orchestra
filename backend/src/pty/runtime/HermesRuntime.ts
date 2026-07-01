import pty from "node-pty";
import { findInPath } from "./findInPath.js";
import type { RuntimeSpawnConfig } from "./INodeRuntime.js";
import { PtyRuntime } from "./PtyRuntime.js";
import { resolveToolset } from "./resolveToolset.js";

/** Resolve the `hermes` binary on PATH. */
function resolveHermesCommand(): string {
  const hermesBin = findInPath("hermes");
  if (hermesBin) return hermesBin;
  console.error(
    "pinodes-orchestra: hermes CLI not found. Install Hermes (https://github.com/nous/hermes) " +
      "or ensure `hermes` is on PATH.",
  );
  return "hermes";
}

/**
 * Hermes TUI runtime — spawns `hermes --tui` in a PTY.
 *
 * Differs from PiRuntime in:
 *  - Uses `HERMES_EPHEMERAL_SYSTEM_PROMPT` env var (per-process, per-node) instead of `--system-prompt`.
 *  - No `--extension` flag; orchestration hooks run via a plugin in `~/.hermes/plugins/orchestra/`.
 *  - `--toolsets` instead of `--tools`.
 */
export class HermesRuntime extends PtyRuntime {
  private cmd = resolveHermesCommand();

  spawn(config: RuntimeSpawnConfig): void {
    const args = [
      "--tui",
      "--toolsets",
      resolveToolset(config.runtimeConfig),
      "--session-id",
      `${config.boardId}-${config.nodeId}`.replace(/[^a-zA-Z0-9-]/g, ""),
      "--name",
      config.label || "hermes",
    ];

    console.log("pinodes-orchestra: spawning hermes", this.cmd, args);
    const term = pty.spawn(this.cmd, args, {
      name: "xterm-256color",
      cols: config.cols,
      rows: config.rows,
      cwd: config.cwd,
      env: {
        ...process.env,
        HERMES_EPHEMERAL_SYSTEM_PROMPT: config.systemPrompt,
        PINODES_ORCHESTRA_URL: config.orchestraUrl,
        PINODES_ORCHESTRA_BOARD: config.boardId,
        PINODES_ORCHESTRA_NODE: config.nodeId,
        PINODES_ORCHESTRA_FALLBACK_APPENDIX: config.appendix,
        ...(process.env.PINODES_ORCHESTRA_TOKEN
          ? { PINODES_ORCHESTRA_TOKEN: process.env.PINODES_ORCHESTRA_TOKEN }
          : {}),
      } as Record<string, string>,
    });

    this.ptyInstance = term;
    this._cols = config.cols;
    this._rows = config.rows;
    this._ready = false;

    term.onData((data) => config.onOutput(data));

    term.onExit(({ exitCode }) => {
      this.ptyInstance = null;
      this._ready = false;
      config.onExit(exitCode ?? null);
    });
  }
}
