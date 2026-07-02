import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { findInPath } from "./findInPath.js";
import type { INodeRuntime, RuntimeSpawnConfig } from "./INodeRuntime.js";
import { isCodexRuntimeAvailable } from "./codexAvailability.js";
import {
  extractAssistantText,
  extractThreadId,
  formatCodexEvent,
  parseCodexJsonLine,
} from "./codexEventFormat.js";
import { parseCards, parseHandoffs } from "../../orchestra/sentinels.js";

const CODEX_BIN_NAMES =
  process.platform === "win32"
    ? ["codex.cmd", "codex.exe", "codex.bat", "codex"]
    : ["codex"];

type CodexSandbox = "read-only" | "workspace-write" | "danger-full-access";
type CodexApprovalMode = "untrusted" | "on-request" | "never";

type CodexRuntimeConfig = {
  model?: string;
  sandbox?: CodexSandbox;
  approvalMode?: CodexApprovalMode;
  profile?: string;
  resumeThreadId?: string;
};

function resolveCodexCommand(): string {
  const bin = findInPath(CODEX_BIN_NAMES);
  if (bin) return bin;
  return "codex";
}

function parseCodexConfig(runtimeConfig?: Record<string, unknown>): CodexRuntimeConfig {
  const cfg = runtimeConfig ?? {};
  const sandbox = cfg.sandbox;
  const approvalMode = cfg.approvalMode;
  return {
    model: typeof cfg.model === "string" ? cfg.model : undefined,
    sandbox:
      sandbox === "read-only" ||
      sandbox === "workspace-write" ||
      sandbox === "danger-full-access"
        ? sandbox
        : undefined,
    approvalMode:
      approvalMode === "untrusted" ||
      approvalMode === "on-request" ||
      approvalMode === "never"
        ? approvalMode
        : undefined,
    profile: typeof cfg.profile === "string" ? cfg.profile : undefined,
    resumeThreadId:
      typeof cfg.resumeThreadId === "string" ? cfg.resumeThreadId : undefined,
  };
}

function approvalFlag(mode: CodexApprovalMode | undefined): string[] {
  switch (mode) {
    case "never":
      return ["--ask-for-approval", "never"];
    case "on-request":
      return ["--ask-for-approval", "on-request"];
    case "untrusted":
      return ["--ask-for-approval", "untrusted"];
    default:
      return ["--ask-for-approval", "on-request"];
  }
}

function buildExecArgs(
  config: RuntimeSpawnConfig,
  codexCfg: CodexRuntimeConfig,
  threadId: string | undefined,
): { cmd: string; args: string[]; stdin: string } {
  const sandbox = codexCfg.sandbox ?? "workspace-write";
  const baseArgs = [
    "exec",
    "--json",
    "--sandbox",
    sandbox,
    ...approvalFlag(codexCfg.approvalMode),
    "-C",
    config.cwd,
  ];
  if (codexCfg.model) baseArgs.push("--model", codexCfg.model);
  if (codexCfg.profile) baseArgs.push("--profile", codexCfg.profile);
  if (config.systemPrompt.trim()) {
    baseArgs.push("--append-system-prompt", config.systemPrompt.trim());
  }

  const args = threadId
    ? [...baseArgs, "resume", threadId, "-"]
    : [...baseArgs, "-"];

  const appendix = config.orchestration?.refreshAppendix?.() ?? config.appendix;
  const stdinParts = [appendix.trim(), ""].filter(Boolean);
  // The inject message is appended by inject(); spawn-only path uses empty stdin.
  const stdin = stdinParts.join("\n\n");

  return { cmd: resolveCodexCommand(), args, stdin };
}

function buildTurnPrompt(appendix: string, message: string): string {
  const parts = [appendix.trim(), message.trim()].filter(Boolean);
  return parts.join("\n\n");
}

/**
 * Structured Codex runtime — one thread per node, one `codex exec --json` turn
 * per inject. Streams JSONL events as synthesized terminal output and parses
 * Orchestra sentinels in-process (no PTY, no external bridge).
 */
export class CodexRuntime implements INodeRuntime {
  readonly kind = "structured" as const;

  private config: RuntimeSpawnConfig | null = null;
  private codexCfg: CodexRuntimeConfig = {};
  private _ready = false;
  private _running = false;
  private _cols = 80;
  private _rows = 24;
  private threadId: string | undefined;
  private activeProc: ChildProcessWithoutNullStreams | null = null;
  private turnRunning = false;
  private pendingMessage: string | null = null;
  private lineBuffer = "";

  spawn(config: RuntimeSpawnConfig): void {
    this.config = config;
    this.codexCfg = parseCodexConfig(config.runtimeConfig);
    this._cols = config.cols;
    this._rows = config.rows;
    this._ready = false;
    this._running = true;
    this.threadId = this.codexCfg.resumeThreadId;
    this.turnRunning = false;
    this.pendingMessage = null;

    if (!isCodexRuntimeAvailable()) {
      config.onOutput(
        "\x1b[31m[codex] CLI not found on the backend PATH.\x1b[0m\n" +
          "Install Codex (https://developers.openai.com/codex) or set PINODES_ORCHESTRA_CODEX=true after installing.\n",
      );
      this._running = false;
      config.onExit(1);
      return;
    }

    config.onOutput("─ codex session ready ─\n");
    this._ready = true;
    config.orchestration?.onReady?.();
  }

  write(data: string): void {
    if (!this._running || !this.config) return;
    const trimmed = data.trim();
    if (!trimmed) return;
    if (this.turnRunning) {
      this.config.onOutput(
        "\x1b[33m[codex] Turn in progress — submit a follow-up via inject, not raw terminal input.\x1b[0m\n",
      );
      return;
    }
    this.config.onOutput(
      "\x1b[33m[codex] Keyboard input ignored — use Run or inject to send tasks.\x1b[0m\n",
    );
  }

  inject(message: string, onSubmitSent?: () => void): void {
    if (!this._running || !this.config) return;
    if (this.turnRunning) {
      this.pendingMessage = message;
      this.config.onOutput("\x1b[33m[codex] Queued follow-up for next turn.\x1b[0m\n");
      onSubmitSent?.();
      return;
    }
    this.startTurn(message, onSubmitSent);
  }

  private startTurn(message: string, onSubmitSent?: () => void): void {
    const config = this.config!;
    const appendix = config.orchestration?.refreshAppendix?.() ?? config.appendix;
    const prompt = buildTurnPrompt(appendix, message);
    const { cmd, args } = buildExecArgs(config, this.codexCfg, this.threadId);

    const proc = spawn(cmd, args, {
      cwd: config.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.activeProc = proc;
    this.turnRunning = true;
    this.lineBuffer = "";
    let assistantText = "";
    let handoffCalledThisTurn = false;
    let turnStartedSignalled = false;

    onSubmitSent?.();

    proc.stdin.write(prompt);
    proc.stdin.end();

    const signalTurnStarted = () => {
      if (turnStartedSignalled) return;
      turnStartedSignalled = true;
      config.orchestration?.onTurnStarted?.();
    };

    proc.stdout.on("data", (chunk: Buffer) => {
      this.lineBuffer += chunk.toString("utf8");
      const lines = this.lineBuffer.split("\n");
      this.lineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const event = parseCodexJsonLine(line);
        if (!event) continue;

        const tid = extractThreadId(event);
        if (tid) this.threadId = tid;

        if (event.type === "turn.started") signalTurnStarted();

        const formatted = formatCodexEvent(event);
        if (formatted) config.onOutput(formatted);

        assistantText = extractAssistantText(event, assistantText);
      }
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) config.onOutput(`\x1b[90m[codex stderr] ${text}\x1b[0m\n`);
    });

    proc.on("close", (code) => {
      this.activeProc = null;
      this.turnRunning = false;

      if (this.lineBuffer.trim()) {
        const event = parseCodexJsonLine(this.lineBuffer);
        if (event) {
          const formatted = formatCodexEvent(event);
          if (formatted) config.onOutput(formatted);
          assistantText = extractAssistantText(event, assistantText);
        }
        this.lineBuffer = "";
      }

      if (assistantText) {
        handoffCalledThisTurn = this.deliverSentinels(assistantText);
      }

      if (!turnStartedSignalled && code === 0) {
        signalTurnStarted();
      }

      config.orchestration?.onTurnEnded?.(handoffCalledThisTurn);

      const queued = this.pendingMessage;
      this.pendingMessage = null;
      if (queued) {
        setTimeout(() => this.startTurn(queued), 0);
      } else if (code !== 0 && code !== null) {
        config.onOutput(`\x1b[31m[codex] Turn exited with code ${code}\x1b[0m\n`);
      }
    });
  }

  private deliverSentinels(text: string): boolean {
    const config = this.config!;
    const hooks = config.orchestration;
    let handoffCalled = false;

    for (const column of parseCards(text)) {
      hooks?.notifyCard?.(column);
    }

    for (const handoff of parseHandoffs(text)) {
      const result = hooks?.deliverHandoff?.(handoff.recipient, handoff.message);
      if (result?.ok) handoffCalled = true;
      else if (result?.error) {
        config.onOutput(`\x1b[31m[handoff failed → ${handoff.recipient}] ${result.error}\x1b[0m\n`);
      }
    }

    return handoffCalled;
  }

  resize(cols: number, rows: number): void {
    if (cols > 0) this._cols = cols;
    if (rows > 0) this._rows = rows;
  }

  kill(): void {
    this.pendingMessage = null;
    if (this.activeProc) {
      this.activeProc.kill();
      this.activeProc = null;
    }
    this.turnRunning = false;
    this._running = false;
    this._ready = false;
  }

  markReady(): void {
    this._ready = true;
  }

  isRunning(): boolean {
    return this._running;
  }

  isReady(): boolean {
    return this._ready;
  }

  size(): { cols: number; rows: number } | undefined {
    return this._running ? { cols: this._cols, rows: this._rows } : undefined;
  }
}
