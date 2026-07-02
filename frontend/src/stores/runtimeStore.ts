import { create } from "zustand";
import type { ChatLine, NodeRuntime, NodeStatus, SystemPrompt, WorkflowGraph } from "../types";

function nodeKey(boardId: string, nodeId: string): string {
  return `${boardId}:${nodeId}`;
}

interface RuntimeState {
  connected: boolean;
  activeBoardId: string;
  nodeStatus: Record<string, NodeStatus>;
  chatByNode: Record<string, ChatLine[]>;
  streamBuffer: Record<string, string>;
  nodeError: Record<string, string>;
  /** `boardId:nodeId` → determinism watchdog enabled (default true when absent). */
  enforcement: Record<string, boolean>;
  selectedNodeId: string | null;
  /** Node whose terminal is expanded full-screen, or null. */
  overlayNodeId: string | null;
  prompts: SystemPrompt[];
  runPromptDraft: string;
  /** Whether the backend can spawn Hermes (`hermes` on PATH). null until known. */
  hermesAvailable: boolean | null;
  /** Whether the backend can spawn Claude Code (`claude` on PATH). null until known. */
  claudeAvailable: boolean | null;

  setConnected: (v: boolean) => void;
  setHermesAvailable: (v: boolean) => void;
  setClaudeAvailable: (v: boolean) => void;
  setEnforcement: (boardId: string, nodeId: string, enabled: boolean) => void;
  setActiveBoardId: (boardId: string) => void;
  setSelectedNodeId: (id: string | null) => void;
  setOverlayNodeId: (id: string | null) => void;
  setPrompts: (p: SystemPrompt[]) => void;
  setRunPromptDraft: (v: string) => void;
  setNodeStatus: (boardId: string, nodeId: string, status: NodeStatus) => void;
  setNodeError: (boardId: string, nodeId: string, message: string) => void;
  clearNodeError: (boardId: string, nodeId: string) => void;
  appendChat: (boardId: string, line: Omit<ChatLine, "id" | "ts">) => void;
  appendStream: (boardId: string, nodeId: string, text: string) => void;
  flushStream: (boardId: string, nodeId: string) => void;
  clearBoardRuntime: (boardId: string) => void;
}

export const useRuntimeStore = create<RuntimeState>((set, get) => ({
  connected: false,
  activeBoardId: "",
  nodeStatus: {},
  chatByNode: {},
  streamBuffer: {},
  nodeError: {},
  enforcement: {},
  selectedNodeId: null,
  overlayNodeId: null,
  prompts: [],
  runPromptDraft: "",
  hermesAvailable: null,
  claudeAvailable: null,

  setConnected: (v) => set({ connected: v }),
  setHermesAvailable: (v) => set({ hermesAvailable: v }),
  setClaudeAvailable: (v) => set({ claudeAvailable: v }),
  setEnforcement: (boardId, nodeId, enabled) =>
    set((s) => ({ enforcement: { ...s.enforcement, [nodeKey(boardId, nodeId)]: enabled } })),
  setActiveBoardId: (boardId) =>
    set({ activeBoardId: boardId, selectedNodeId: null, overlayNodeId: null }),
  setSelectedNodeId: (id) => set({ selectedNodeId: id }),
  setOverlayNodeId: (id) => set({ overlayNodeId: id }),
  setPrompts: (p) => set({ prompts: p }),
  setRunPromptDraft: (v) => set({ runPromptDraft: v }),

  setNodeStatus: (boardId, nodeId, status) =>
    set((s) => ({
      nodeStatus: { ...s.nodeStatus, [nodeKey(boardId, nodeId)]: status },
    })),

  setNodeError: (boardId, nodeId, message) =>
    set((s) => ({
      nodeError: { ...s.nodeError, [nodeKey(boardId, nodeId)]: message },
    })),

  clearNodeError: (boardId, nodeId) =>
    set((s) => {
      const next = { ...s.nodeError };
      delete next[nodeKey(boardId, nodeId)];
      return { nodeError: next };
    }),

  appendChat: (boardId, line) =>
    set((s) => {
      const key = nodeKey(boardId, line.nodeId);
      const entry: ChatLine = {
        ...line,
        id: crypto.randomUUID(),
        ts: Date.now(),
      };
      const prev = s.chatByNode[key] ?? [];
      return { chatByNode: { ...s.chatByNode, [key]: [...prev, entry] } };
    }),

  appendStream: (boardId, nodeId, text) => {
    const key = nodeKey(boardId, nodeId);
    const buf = (get().streamBuffer[key] ?? "") + text;
    set((s) => ({ streamBuffer: { ...s.streamBuffer, [key]: buf } }));
  },

  flushStream: (boardId, nodeId) =>
    set((s) => {
      const key = nodeKey(boardId, nodeId);
      const text = s.streamBuffer[key];
      if (!text) return s;
      const entry: ChatLine = {
        id: crypto.randomUUID(),
        nodeId,
        kind: "stream",
        text,
        ts: Date.now(),
      };
      const prev = s.chatByNode[key] ?? [];
      const next = { ...s.streamBuffer };
      delete next[key];
      return {
        streamBuffer: next,
        chatByNode: { ...s.chatByNode, [key]: [...prev, entry] },
      };
    }),

  clearBoardRuntime: (boardId) =>
    set((s) => {
      const prefix = `${boardId}:`;
      const nodeStatus = { ...s.nodeStatus };
      const chatByNode = { ...s.chatByNode };
      const streamBuffer = { ...s.streamBuffer };
      const nodeError = { ...s.nodeError };
      const enforcement = { ...s.enforcement };
      for (const k of Object.keys(nodeStatus)) {
        if (k.startsWith(prefix)) delete nodeStatus[k];
      }
      for (const k of Object.keys(chatByNode)) {
        if (k.startsWith(prefix)) delete chatByNode[k];
      }
      for (const k of Object.keys(streamBuffer)) {
        if (k.startsWith(prefix)) delete streamBuffer[k];
      }
      for (const k of Object.keys(nodeError)) {
        if (k.startsWith(prefix)) delete nodeError[k];
      }
      for (const k of Object.keys(enforcement)) {
        if (k.startsWith(prefix)) delete enforcement[k];
      }
      return { nodeStatus, chatByNode, streamBuffer, nodeError, enforcement };
    }),
}));

export function graphFromFlow(
  nodes: Array<{
    id: string;
    position: { x: number; y: number };
    data: {
      label: string;
      promptId: string;
      promptOverride?: string;
      canBeFinal?: boolean;
      runtime?: NodeRuntime;
      runtimeConfig?: Record<string, unknown>;
    };
  }>,
  edges: Array<{ id: string; source: string; target: string }>,
  name: string,
  id: string | null,
  cwd: string,
  entryNodeId: string | null,
): WorkflowGraph {
  return {
    id: id ?? undefined,
    name,
    cwd,
    entryNodeId,
    nodes: nodes.map((n) => ({
      id: n.id,
      label: n.data.label,
      promptId: n.data.promptId,
      promptOverride: n.data.promptOverride ?? null,
      canBeFinal: n.data.canBeFinal ?? null,
      runtime: n.data.runtime ?? undefined,
      runtimeConfig: n.data.runtimeConfig ?? undefined,
      position: n.position,
    })),
    edges: edges.map((e) => ({
      id: e.id,
      sourceNodeId: e.source,
      targetNodeId: e.target,
    })),
  };
}

