import { ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { findFreePort, isPortFree } from "./port.js";
import { resolveSessionToken } from "./sessionToken.js";
import { workspaceInstanceDataDir } from "./workspaceDataDir.js";

export type BackendStatus = "stopped" | "starting" | "running" | "error";

/** Thrown when the required `pi` CLI is not installed. The modal is shown to the
 * user at the point of detection, so callers should swallow this quietly. */
export class PiNotFoundError extends Error {
  constructor() {
    super("pi CLI not found on PATH");
    this.name = "PiNotFoundError";
  }
}

const PI_INSTALL_CMD = "npm i -g @earendil-works/pi-coding-agent";
const PI_INSTALL_URL = "https://www.npmjs.com/package/@earendil-works/pi-coding-agent";

/**
 * Owns the pinodes-orchestra backend lifecycle for the extension.
 *
 * Strategy (per docs/roadmaps/EXTENSIONS_ROADMAP.md, Phase 2): never run node-pty /
 * better-sqlite3 in-process inside the extension host. Instead spawn the
 * existing Fastify backend (`backend/dist/index.js`) as a Node subprocess and
 * talk to it over localhost HTTP/WS, exactly like the standalone app.
 *
 * Each VS Code window gets its own backend on a dedicated port with an isolated
 * SQLite directory (see docs/MULTI_INSTANCE.md).
 */
export class BackendManager {
  private proc: ChildProcess | undefined;
  private _port = 0;
  private _status: BackendStatus = "stopped";
  private readonly output: vscode.OutputChannel;
  private readonly onDidChangeEmitter = new vscode.EventEmitter<BackendStatus>();

  /**
   * Auth token for this session. Uses the user-configured value when present;
   * otherwise generates an ephemeral random UUID so that every backend spawn
   * is protected even when the user has not set `pinodesOrchestra.token`.
   * The extension host is the trusted intermediary that knows this secret —
   * it passes it down to the backend process (env) and the webview (URL).
   */
  readonly sessionToken: string;

  /** Fires whenever the backend status changes (drives the control view). */
  readonly onDidChangeStatus = this.onDidChangeEmitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.output = vscode.window.createOutputChannel("PiNodes Orchestra");
    context.subscriptions.push(this.output, this.onDidChangeEmitter);

    const configured = vscode.workspace
      .getConfiguration("pinodesOrchestra")
      .get<string>("token", "")
      .trim();
    this.sessionToken = resolveSessionToken(configured);
  }

  get status(): BackendStatus {
    return this._status;
  }

  get port(): number {
    return this._port || this.configuredPort || 3847;
  }

  private get configuredPort(): number {
    return vscode.workspace.getConfiguration("pinodesOrchestra").get<number>("port", 0);
  }

  get baseUrl(): string {
    // 127.0.0.1 (not "localhost"): on Windows `localhost` can resolve to ::1
    // (IPv6) first, while the backend binds 0.0.0.0 (IPv4-only). The first
    // health-check fetch then hangs on ::1 until the 20s timeout, so the panel
    // fails on first open and only works after a retry. A literal IPv4 loopback
    // always reaches the listener.
    return `http://127.0.0.1:${this.port}`;
  }

  showLogs(): void {
    this.output.show(true);
  }

  private setStatus(status: BackendStatus): void {
    if (this._status === status) return;
    this._status = status;
    this.onDidChangeEmitter.fire(status);
  }

  /** Ensure this window's backend subprocess is running and healthy. */
  async ensureStarted(): Promise<void> {
    if (this._status === "running" && this.proc && (await this.isHealthy())) return;

    if (this.configuredPort > 0) {
      if (!(await isPortFree(this.configuredPort))) {
        this._port = this.configuredPort;
        if (await this.isHealthy()) {
          this.log(
            `Port ${this.configuredPort} is in use by another process; cannot start a dedicated backend. ` +
              "Free the port or set pinodesOrchestra.port to 0 for automatic allocation.",
          );
          this.setStatus("error");
          throw new Error(`Port ${this.configuredPort} is already in use.`);
        }
      }
      this._port = this.configuredPort;
    } else {
      this._port = await findFreePort(3847);
    }

    await this.ensurePi();
    await this.spawnBackend();
  }

  /** Locate the `pi` CLI on PATH (cross-platform). */
  private findPi(): string | undefined {
    const names = process.platform === "win32" ? ["pi.cmd", "pi.exe", "pi.bat", "pi"] : ["pi"];
    const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
    for (const dir of dirs) {
      for (const name of names) {
        const candidate = path.join(dir, name);
        try {
          if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
        } catch {
          /* unreadable PATH entry — skip */
        }
      }
    }
    return undefined;
  }

  /** Throw (after showing an actionable modal) if the `pi` CLI is missing. */
  private async ensurePi(): Promise<void> {
    const found = this.findPi();
    if (found) {
      this.log(`Found pi CLI: ${found}`);
      return;
    }
    this.setStatus("error");
    this.log("pi CLI not found on PATH — cannot start backend.");
    const INSTALL = "Install instructions";
    const pick = await vscode.window.showErrorMessage(
      "PiNodes Orchestra needs the pi coding agent CLI, but it isn't installed on your PATH.",
      {
        modal: true,
        detail:
          `Install it, then reopen PiNodes Orchestra:\n\n  ${PI_INSTALL_CMD}\n\n` +
          "After installing, restart VS Code so the updated PATH is picked up.",
      },
      INSTALL,
    );
    if (pick === INSTALL) {
      void vscode.env.openExternal(vscode.Uri.parse(PI_INSTALL_URL));
    }
    throw new PiNotFoundError();
  }

  private resolveEntry(): string {
    const configured = vscode.workspace
      .getConfiguration("pinodesOrchestra")
      .get<string>("backendEntry", "")
      .trim();
    if (configured) return configured;

    const bundled = path.join(this.bundledRoot, "backend", "dist", "index.js");
    if (fs.existsSync(bundled)) return bundled;

    return path.join(this.context.extensionPath, "..", "backend", "dist", "index.js");
  }

  private get bundledRoot(): string {
    return path.join(this.context.extensionPath, "server");
  }

  private workspaceCwd(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private instanceDataDir(): string {
    const workspaceKey = this.workspaceCwd() ?? "default";
    return workspaceInstanceDataDir(this.context.globalStorageUri.fsPath, workspaceKey);
  }

  /** Copy legacy flat globalStorage DB into the per-workspace folder once. */
  private migrateLegacyDb(dataDir: string): void {
    const legacyDb = path.join(this.context.globalStorageUri.fsPath, "pinodes-orchestra.db");
    const newDb = path.join(dataDir, "pinodes-orchestra.db");
    if (!fs.existsSync(legacyDb) || fs.existsSync(newDb)) return;
    try {
      fs.copyFileSync(legacyDb, newDb);
      this.log(`Migrated legacy database to ${dataDir}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`Legacy DB migration skipped: ${msg}`);
    }
  }

  private async spawnBackend(): Promise<void> {
    const entry = this.resolveEntry();
    if (!fs.existsSync(entry)) {
      this.setStatus("error");
      const msg = `Backend entry not found: ${entry}. Build it with \`npm run build\` in the pinodes-orchestra repo, or set "pinodesOrchestra.backendEntry".`;
      this.log(msg);
      throw new Error(msg);
    }

    const nodeCmd = vscode.workspace
      .getConfiguration("pinodesOrchestra")
      .get<string>("nodeCommand", "node");
    const cwd = this.workspaceCwd() ?? os.homedir();
    const dataDir = this.instanceDataDir();
    this.migrateLegacyDb(dataDir);

    this.setStatus("starting");
    this.log(`Starting backend: ${nodeCmd} ${entry}`);
    this.log(`  cwd:  ${cwd}`);
    this.log(`  port: ${this.port}`);
    this.log(`  data: ${dataDir}`);

    this.proc = spawn(nodeCmd, [entry], {
      cwd,
      env: {
        ...process.env,
        PORT: String(this.port),
        PINODES_ORCHESTRA_PARENT_PID: String(process.pid),
        PINODES_ORCHESTRA_DATA_DIR: dataDir,
        PINODES_ORCHESTRA_TOKEN: this.sessionToken,
      },
    });

    const pid = this.proc.pid;
    const killOnExit = () => {
      try {
        if (pid) process.kill(pid);
      } catch {
        /* already gone */
      }
    };
    process.once("exit", killOnExit);
    this.proc.once("exit", () => process.removeListener("exit", killOnExit));

    this.proc.stdout?.on("data", (d: Buffer) => this.output.append(d.toString()));
    this.proc.stderr?.on("data", (d: Buffer) => this.output.append(d.toString()));
    this.proc.on("exit", (code, signal) => {
      this.log(`Backend exited (code=${code}, signal=${signal})`);
      this.proc = undefined;
      this.setStatus("stopped");
    });
    this.proc.on("error", (err) => {
      this.log(`Failed to start backend: ${err.message}`);
      this.proc = undefined;
      this.setStatus("error");
    });

    await this.waitForHealth();
  }

  private async waitForHealth(timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let attempt = 0;
    while (Date.now() < deadline) {
      if (this._status === "stopped" || this._status === "error") {
        throw new Error("Backend process exited before becoming healthy. See PiNodes Orchestra logs.");
      }
      attempt++;
      if (await this.isHealthy()) {
        this.log(`Backend healthy on ${this.baseUrl} (after ${attempt} check${attempt === 1 ? "" : "s"})`);
        this.setStatus("running");
        return;
      }
      await delay(400);
    }
    this.setStatus("error");
    throw new Error(`Backend did not become healthy within ${timeoutMs / 1000}s. See PiNodes Orchestra logs.`);
  }

  async isHealthy(): Promise<boolean> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 1500);
    try {
      const res = await fetch(`${this.baseUrl}/api/health`, { signal: controller.signal });
      if (!res.ok) return false;
      const body = (await res.json()) as { ok?: boolean; name?: string };
      return body.ok === true && body.name === "pinodes-orchestra";
    } catch {
      return false;
    } finally {
      clearTimeout(t);
    }
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.ensureStarted();
  }

  async stop(): Promise<void> {
    const proc = this.proc;
    if (!proc) {
      this.setStatus("stopped");
      return;
    }
    this.log("Stopping backend…");
    await new Promise<void>((resolve) => {
      const onExit = () => resolve();
      proc.once("exit", onExit);
      proc.kill();
      setTimeout(() => {
        if (this.proc === proc) proc.kill("SIGKILL");
        resolve();
      }, 3000);
    });
    this.proc = undefined;
    this.setStatus("stopped");
  }

  private log(line: string): void {
    this.output.appendLine(`[pinodes-orchestra] ${line}`);
  }

  dispose(): void {
    void this.stop();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
