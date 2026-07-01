import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pty from "node-pty";
import { findInPath } from "./findInPath.js";
import type { RuntimeSpawnConfig } from "./INodeRuntime.js";
import { PtyRuntime } from "./PtyRuntime.js";
import { resolveToolset } from "./resolveToolset.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, "../../../pi-extensions/call-agent.ts");

// On Windows the `pi` launcher is `pi.cmd` (npm shim); `pi` with no extension
// does not exist, so spawning it verbatim fails with ENOENT.
const PI_BIN_NAMES =
  process.platform === "win32" ? ["pi.cmd", "pi.exe", "pi.bat", "pi"] : ["pi"];

/** Resolve the `pi` CLI entry, falling back to the binary on PATH. */
function resolvePiCommand(): { file: string; baseArgs: string[] } {
  const candidates = [
    path.resolve(
      __dirname,
      "../../../../node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
    ),
    path.resolve(
      process.cwd(),
      "node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
    ),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return { file: process.execPath, baseArgs: [c] };
  }
  const piBin = findInPath(PI_BIN_NAMES);
  if (piBin) {
    // On Windows `pi` on PATH is the npm batch shim `pi.cmd`. Spawning it forces
    // node-pty through cmd.exe, which treats the first CRLF inside our multiline
    // `--system-prompt` as end-of-command: it truncates the line and drops every
    // argument after it — including `--extension …call-agent.ts`. pi then boots
    // as a plain session with no orchestration extension and the nodes never see
    // each other. Resolve the cli.js the shim itself runs and launch it with node
    // directly (no shell), so args pass verbatim exactly like on Linux.
    if (/\.(cmd|bat)$/i.test(piBin)) {
      const cliFromShim = path.join(
        path.dirname(piBin),
        "node_modules",
        "@earendil-works",
        "pi-coding-agent",
        "dist",
        "cli.js",
      );
      if (fs.existsSync(cliFromShim)) {
        return { file: process.execPath, baseArgs: [cliFromShim] };
      }
    }
    return { file: piBin, baseArgs: [] };
  }
  console.error(
    "pinodes-orchestra: pi CLI not found. Install `@earendil-works/pi-coding-agent` globally (npm i -g) " +
      "or run `npm install` in the `backend` folder.",
  );
  return { file: PI_BIN_NAMES[0], baseArgs: [] };
}

export class PiRuntime extends PtyRuntime {
  private cmd = resolvePiCommand();

  spawn(config: RuntimeSpawnConfig): void {
    const hasExtension = fs.existsSync(EXTENSION_PATH);
    const systemPrompt = (
      hasExtension ? config.systemPrompt : config.systemPrompt + config.appendix
    ).trim();

    const args = [
      ...this.cmd.baseArgs,
      "--tools",
      resolveToolset(config.runtimeConfig),
      "--session-id",
      `${config.boardId}-${config.nodeId}`.replace(/[^a-zA-Z0-9-]/g, ""),
      "--name",
      config.label || "pi",
      "--system-prompt",
      systemPrompt,
    ];
    if (hasExtension) args.push("--extension", EXTENSION_PATH);

    console.log("pinodes-orchestra: spawning pi", this.cmd.file, args);
    const term = pty.spawn(this.cmd.file, args, {
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
