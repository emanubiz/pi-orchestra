export interface RuntimeSpawnConfig {
  boardId: string;
  nodeId: string;
  label: string;
  cwd: string;
  cols: number;
  rows: number;
  systemPrompt: string;
  appendix: string;
  orchestraUrl: string;
  runtimeConfig?: Record<string, unknown>;
  onOutput: (data: string) => void;
  onExit: (code: number | null) => void;
}

export interface INodeRuntime {
  spawn(config: RuntimeSpawnConfig): void;
  write(data: string): void;
  /** Bracketed-paste inject + settle + submit. `onSubmitSent` fires right
   *  after the submit `\r` is written, so the caller can arm a closed-loop
   *  delivery watch (confirm the recipient started a turn; re-send `\r` if not). */
  inject(message: string, onSubmitSent?: () => void): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  /** External ready signal (agent's extension reported session_start). */
  markReady(): void;
  isRunning(): boolean;
  isReady(): boolean;
  /** Current PTY dimensions, or undefined if not running. */
  size(): { cols: number; rows: number } | undefined;
}
