import { type IPty } from "node-pty";
import type { INodeRuntime, RuntimeSpawnConfig } from "./INodeRuntime.js";

/**
 * Gap between the bracketed-paste end marker and the submit `\r`, so the TUI
 * finishes ingesting the paste before Enter. Too short and Enter races the
 * paste: it gets absorbed into the input buffer instead of submitting, so the
 * handoff message lands in the prompt but is never sent. The window scales with
 * message length (a long handoff instruction takes longer to ingest) and each
 * runtime picks a floor via `injectSubmitBaseMs` — Hermes' Textual TUI needs
 * more headroom than pi's.
 */
const INJECT_SUBMIT_PER_CHAR_MS = 0.05; // ~50ms per 1000 chars
const INJECT_SUBMIT_MAX_MS = 1_200;

/**
 * Shared PTY lifecycle for all runtimes (pi, hermes, …).
 * Subclasses only need to implement `spawn()` — the rest is common.
 */
export abstract class PtyRuntime implements INodeRuntime {
  protected ptyInstance: IPty | null = null;
  protected _cols = 80;
  protected _rows = 24;
  protected _ready = false;
  /** Floor for the paste→submit gap (ms). Overridable per runtime. */
  protected injectSubmitBaseMs = 80;

  abstract spawn(config: RuntimeSpawnConfig): void;

  write(data: string): void {
    this.ptyInstance?.write(data);
  }

  /** Paste→submit delay: a per-runtime floor plus a length-scaled margin. */
  protected submitDelayMs(message: string): number {
    return Math.min(
      INJECT_SUBMIT_MAX_MS,
      this.injectSubmitBaseMs + Math.round(message.length * INJECT_SUBMIT_PER_CHAR_MS),
    );
  }

  inject(message: string, onSubmitSent?: () => void): void {
    if (!this.ptyInstance) return;
    // Bracketed paste keeps embedded newlines from submitting early.
    this.ptyInstance.write(`\x1b[200~${message}\x1b[201~`);
    setTimeout(() => {
      this.ptyInstance?.write("\r");
      // Fires after the submit byte is written so the caller can arm a closed-
      // loop delivery watch (confirm a turn started in the recipient, or
      // re-send `\r`). Best-effort: never throws even if the PTY died between
      // the paste and the submit.
      try {
        onSubmitSent?.();
      } catch {
        /* ignore — a watcher error must never break the submit path */
      }
    }, this.submitDelayMs(message));
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
