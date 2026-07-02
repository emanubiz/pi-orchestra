export type RuntimeKind = "pty" | "structured";

/** In-process orchestration hooks for structured runtimes (Codex, …). PTY
 *  runtimes use HTTP bridges (extensions/plugins/hooks) instead. */
export interface RuntimeOrchestrationHooks {
  /** Session ready — flush queued injects (POST /internal/ready equivalent). */
  onReady?: () => void;
  /** Turn accepted by the agent (POST /internal/turn-started equivalent). */
  onTurnStarted?: () => void;
  /** Turn finished (POST /internal/turn-ended equivalent). */
  onTurnEnded?: (handoffCalledThisTurn: boolean) => void;
  /** Deliver @@HANDOFF to a connected node (POST /internal/call-agent equivalent). */
  deliverHandoff?: (
    targetNodeId: string,
    message: string,
  ) => { ok: boolean; message?: string; error?: string };
  /** Advance linked Kanban card (POST /internal/card-status equivalent). */
  notifyCard?: (column: string) => void;
  /** Refresh the graph appendix before each inject (PTY bridges fetch via HTTP). */
  refreshAppendix?: () => string;
}

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
  orchestration?: RuntimeOrchestrationHooks;
  onOutput: (data: string) => void;
  onExit: (code: number | null) => void;
}

export interface INodeRuntime {
  readonly kind: RuntimeKind;
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
