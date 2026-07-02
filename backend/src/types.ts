export type NodeStatus = "idle" | "running" | "done" | "error";

/** Which agent runtime backs a node's PTY. Absent === "pi" (backward compat). */
export type NodeRuntime = "pi" | "hermes" | "claude" | "codex";

export interface WorkflowGraph {
  id?: string;
  name: string;
  cwd?: string;
  entryNodeId?: string | null;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export interface WorkflowNode {
  id: string;
  label: string;
  promptId: string;
  promptOverride?: string | null;
  /** Whether this node may end the chain. Undefined/null === true (can end).
   * When false, the agent is told it MUST hand off to a connected node. */
  canBeFinal?: boolean | null;
  /** Agent runtime backing this node. Undefined/absent === "pi" (default). */
  runtime?: NodeRuntime;
  /** Non-secret runtime parameters (model, toolset, flags). NEVER store secrets
   * here — runtimeConfig is persisted to SQLite and broadcast to the browser.
   * Credentials live in the runtime's own config (e.g. ~/.hermes/) or env. */
  runtimeConfig?: Record<string, unknown>;
  position: { x: number; y: number };
}

export interface WorkflowEdge {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
}

export interface SystemPromptRow {
  id: string;
  name: string;
  content: string;
  is_builtin: number;
  created_at: string;
  updated_at: string;
}

export interface BoardState {
  boardId: string;
  cwd: string;
  label: string;
  graph?: WorkflowGraph;
  createdAt: number;
}

export interface BoardRow {
  id: string;
  cwd: string;
  label: string;
  graph_data: string | null;
  created_at: string;
  updated_at: string;
}

export interface WsClientMessage {
  type: string;
  [key: string]: unknown;
}

export interface WsServerMessage {
  type: string;
  [key: string]: unknown;
}
