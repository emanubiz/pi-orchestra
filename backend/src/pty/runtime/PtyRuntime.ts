import { type IPty } from "node-pty";
import type { INodeRuntime, RuntimeSpawnConfig } from "./INodeRuntime.js";

/** Gap between bracketed paste and submit (\r), so the TUI can process the paste. */
const INJECT_SUBMIT_MS = 80;

/**
 * Shared PTY lifecycle for all runtimes (pi, hermes, …).
 * Subclasses only need to implement `spawn()` — the rest is common.
 */
export abstract class PtyRuntime implements INodeRuntime {
  protected ptyInstance: IPty | null = null;
  protected _cols = 80;
  protected _rows = 24;
  protected _ready = false;

  abstract spawn(config: RuntimeSpawnConfig): void;

  write(data: string): void {
    this.ptyInstance?.write(data);
  }

  inject(message: string): void {
    if (!this.ptyInstance) return;
    // Bracketed paste keeps embedded newlines from submitting early.
    this.ptyInstance.write(`\x1b[200~${message}\x1b[201~`);
    setTimeout(() => this.ptyInstance?.write("\r"), INJECT_SUBMIT_MS);
  }

  resize(cols: number, rows: number): void {
    if (!this.ptyInstance || !cols || !rows) return;
    this._cols = cols;
    this._rows = rows;
    this.ptyInstance.resize(cols, rows);
  }

  kill(): void {
    if (!this.ptyInstance) return;
    this.ptyInstance.kill();
    this.ptyInstance = null;
    this._ready = false;
  }

  markReady(): void {
    if (!this.ptyInstance) return;
    this._ready = true;
  }

  isRunning(): boolean {
    return this.ptyInstance !== null;
  }

  isReady(): boolean {
    return this._ready;
  }

  size(): { cols: number; rows: number } | undefined {
    return this.ptyInstance ? { cols: this._cols, rows: this._rows } : undefined;
  }
}
