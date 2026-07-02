export type NodeStatus = "idle" | "running" | "done" | "error";

/** Which agent runtime backs a node's PTY. Absent === "pi" (backward compat). */
export type NodeRuntime = "pi" | "hermes" | "claude";

export interface SystemPrompt {
  id: string;
  name: string;
  content: string;
  is_builtin: number;
}

export interface WorkflowNodeData extends Record<string, unknown> {
  label: string;
  promptId: string;
  status: NodeStatus;
  promptOverride?: string;
  isEntry?: boolean;
  /** Which agent runtime backs this node. Undefined === "pi" (default). */
  runtime?: NodeRuntime;
  /** Non-secret runtime parameters (model, toolset, flags). */
  runtimeConfig?: Record<string, unknown>;
  /** Whether this node is allowed to end the chain. Undefined === true (can end).
   * When false, the agent is told it MUST hand off to a connected node. */
  canBeFinal?: boolean;
  error?: string;
}

export interface ChatLine {
  id: string;
  nodeId: string;
  kind: "user" | "agent" | "system" | "stream" | "tool" | "thinking";
  text: string;
  ts: number;
}

export interface WorkflowGraph {
  id?: string;
  name: string;
  cwd?: string;
  entryNodeId?: string | null;
  nodes: Array<{
    id: string;
    label: string;
    promptId: string;
    promptOverride?: string | null;
    canBeFinal?: boolean | null;
    runtime?: NodeRuntime;
    runtimeConfig?: Record<string, unknown>;
    position: { x: number; y: number };
  }>;
  edges: Array<{
    id: string;
    sourceNodeId: string;
    targetNodeId: string;
  }>;
}

export interface BoardSnapshot {
  nodes: Array<{
    id: string;
    type: string;
    position: { x: number; y: number };
    data: WorkflowNodeData;
  }>;
  edges: Array<{
    id: string;
    source: string;
    target: string;
  }>;
}

export interface Board {
  id: string;
  label: string;
  cwd: string;
  workflowName: string;
  workflowId: string | null;
  entryNodeId: string | null;
  snapshot: BoardSnapshot;
}

export interface SavedWorkflowListItem {
  id: string;
  name: string;
  updated_at: string;
}

export type TimelineEventType = "handoff" | "error";

export interface TimelineEntry {
  id: string;
  boardId: string;
  ts: number;
  type: TimelineEventType;
  nodeId: string;
  fromNodeId?: string;
  toNodeId?: string;
  summary: string;
}
