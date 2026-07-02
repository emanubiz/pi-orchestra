import pty from "node-pty";
import { findInPath } from "./findInPath.js";
import type { RuntimeSpawnConfig } from "./INodeRuntime.js";
import { PtyRuntime } from "./PtyRuntime.js";
import { resolveClaudeSettings } from "./resolveClaudeSettings.js";
import { CLAUDE_DEFAULT_TOOLSET, resolveToolset } from "./resolveToolset.js";

// On Windows the npm launcher is `claude.cmd`; `claude` with no extension
// does not exist, so spawning it verbatim fails with ENOENT.
const CLAUDE_BIN_NAMES =
  process.platform === "win32"
    ? ["claude.cmd", "claude.exe", "claude.bat", "claude"]
    : ["claude"];

/** Resolve the `claude` binary on PATH. */
function resolveClaudeCommand(): string {
  const bin = findInPath(CLAUDE_BIN_NAMES);
  if (bin) return bin;
  console.error(
    "pinodes-orchestra: claude CLI not found. Install Claude Code " +
      "(https://claude.com/claude-code) or ensure `claude` is on PATH.",
  );
  return "claude";
}

/**
 * Claude Code runtime — spawns interactive `claude` in a PTY.
 *
 * Differs from PiRuntime/HermesRuntime in:
 *  - `--append-system-prompt` carries the node's role (per-process, per-node).
 *  - Orchestration runs via lifecycle hooks passed inline with `--settings`
 *    (see resolveClaudeSettings) — nothing is written to `~/.claude`, no
 *    install step. The hook bridge (`claude-hooks/orchestra-hook.mjs`) parses
 *    the SAME `@@HANDOFF`/`@@CARD`/`@@DONE` text sentinels as pi and Hermes.
 *  - `--allowedTools` pre-allows the work toolset (Claude's own vocabulary,
 *    `Read,Edit,Write,Bash,…`) and `--permission-mode acceptEdits` keeps the
 *    session from blocking on a permission prompt — no human sits at a
 *    pipeline node.
 */
export class ClaudeRuntime extends PtyRuntime {
  private cmd = resolveClaudeCommand();
  // Claude Code's Ink TUI ingests a bracketed paste slower than pi's readline
  // — same headroom as Hermes' Textual TUI so Enter never races the paste.
  protected override injectSubmitBaseMs = 300;

  spawn(config: RuntimeSpawnConfig): void {
    const toolset = resolveToolset(config.runtimeConfig, CLAUDE_DEFAULT_TOOLSET);
    const args = [
      "--append-system-prompt",
      config.systemPrompt,
      "--settings",
      resolveClaudeSettings(),
      "--allowedTools",
      toolset,
      "--permission-mode",
      "acceptEdits",
    ];

    console.log("pinodes-orchestra: spawning claude", this.cmd);
    const term = pty.spawn(this.cmd, args, {
      name: "xterm-256color",
      cols: config.cols,
      rows: config.rows,
      cwd: config.cwd,
      env: {
        ...process.env,
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
