import pty from "node-pty";
import { findInPath } from "./findInPath.js";
import { ensureHermesPluginInstalled } from "./installHermesPlugin.js";
import type { RuntimeSpawnConfig } from "./INodeRuntime.js";
import { PtyRuntime } from "./PtyRuntime.js";
import { HERMES_DEFAULT_TOOLSET, resolveToolset } from "./resolveToolset.js";

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
 * Hermes TUI runtime — spawns `hermes chat --tui` in a PTY.
 *
 * Differs from PiRuntime in:
 *  - Uses `HERMES_EPHEMERAL_SYSTEM_PROMPT` env var (per-process, per-node) instead of `--system-prompt`.
 *  - No `--extension` flag; orchestration runs via the orchestra plugin in
 *    `~/.hermes/plugins/orchestra/` (auto-installed by ensureHermesPluginInstalled).
 *  - `-t` / `--toolsets` on the `chat` subcommand (Hermes ≥0.17) carries only the
 *    node's work toolset (file,terminal by default). Handoffs are a TEXT protocol
 *    (`@@HANDOFF`, parsed by the plugin's transform_llm_output hook), NOT a tool —
 *    so there's no `orchestra` toolset to enable and nothing that breaks if the
 *    model's tool-calling misfires.
 */
export class HermesRuntime extends PtyRuntime {
  private cmd = resolveHermesCommand();

  spawn(config: RuntimeSpawnConfig): void {
    // Self-sufficiency: ship + enable the orchestra plugin in the user's Hermes
    // (idempotent, once per process) so handoffs work with no manual setup.
    ensureHermesPluginInstalled(this.cmd);

    // No `--resume`: each spawn starts a FRESH Hermes session. `--resume <id>`
    // only resumes a session that already exists, so passing a synthetic
    // board-node id on the first launch fails with "Session not found" and the
    // node never reaches ready — leaving injected tasks stuck in the queue.
    // Orchestration identity is carried by PINODES_ORCHESTRA_BOARD/NODE env
    // vars (read by the plugin), not by the Hermes session id, so a fresh
    // session per spawn matches pi's behaviour and loses nothing.
    //
    // `-t` carries only the node's WORK toolset (file,terminal by default, or a
    // user-supplied runtimeConfig.toolset). Orchestration is not a tool: the
    // plugin parses @@HANDOFF/@@CARD text out of the turn output, so there is no
    // `orchestra` toolset to enable and no dependency on Hermes tool-calling.
    const toolsets = resolveToolset(config.runtimeConfig, HERMES_DEFAULT_TOOLSET);
    const args = [
      "chat",
      "--tui",
      "-t",
      toolsets,
      "--source",
      "tool",
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
