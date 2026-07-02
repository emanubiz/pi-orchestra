import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Panel,
  addEdge,
  useNodesState,
  useEdgesState,
  type Connection,
  type Node,
  type Edge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Plus, Workflow } from "lucide-react";
import { WORKFLOW_TEMPLATES } from "../lib/workflowTemplates";
import type { WorkflowTemplate } from "../lib/workflowTemplates";
import { AgentNode } from "./AgentNode";
import { useRuntimeStore } from "../stores/runtimeStore";
import { TerminalContext } from "../lib/termTheme";
import type { BoardSnapshot, WorkflowNodeData } from "../types";

const nodeTypes = { agent: AgentNode };

const IDLE_EDGE_STROKE = "#52525b";
const ACTIVE_EDGE_STROKE = "#34d399";

function edgeVisual(
  sourceId: string,
  boardId: string,
  nodeStatusMap: Record<string, string>,
): Pick<Edge, "animated" | "style"> {
  const active = nodeStatusMap[`${boardId}:${sourceId}`] === "running";
  return {
    animated: active,
    style: { stroke: active ? ACTIVE_EDGE_STROKE : IDLE_EDGE_STROKE },
  };
}

export interface FlowCanvasHandle {
  getNodes: () => Node<WorkflowNodeData>[];
  getEdges: () => Edge[];
  getNode: (id: string) => Node<WorkflowNodeData> | undefined;
  setGraph: (nodes: Node<WorkflowNodeData>[], edges: Edge[]) => void;
  addNode: (node: Node<WorkflowNodeData>) => void;
  updateNodeData: (nodeId: string, patch: Partial<WorkflowNodeData>) => void;
}

interface FlowCanvasProps {
  boardId: string;
  entryNodeId: string | null;
  initialSnapshot: BoardSnapshot;
  onGraphChange: (nodes: Node<WorkflowNodeData>[], edges: Edge[]) => void;
  flowRef: React.MutableRefObject<FlowCanvasHandle | null>;
  send: (msg: Record<string, unknown>) => void;
  onExpand: (nodeId: string) => void;
  onEditPrompt: (nodeId: string) => void;
  onAddAgent?: () => void;
  onLoadTemplate?: (template: WorkflowTemplate) => void;
}

function snapshotToFlow(
  snapshot: BoardSnapshot,
  entryNodeId: string | null,
): { nodes: Node<WorkflowNodeData>[]; edges: Edge[] } {
  const nodes: Node<WorkflowNodeData>[] = snapshot.nodes.map((n) => ({
    id: n.id,
    type: "agent",
    position: n.position,
    data: {
      ...n.data,
      status: n.data.status ?? "idle",
      isEntry: n.id === entryNodeId,
    },
  }));
  const edges: Edge[] = snapshot.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    animated: false,
    style: { stroke: IDLE_EDGE_STROKE },
  }));
  return { nodes, edges };
}

export function FlowCanvas({
  boardId,
  entryNodeId,
  initialSnapshot,
  onGraphChange,
  flowRef,
  send,
  onExpand,
  onEditPrompt,
  onAddAgent,
  onLoadTemplate,
}: FlowCanvasProps) {
  const initial = useMemo(
    () => snapshotToFlow(initialSnapshot, entryNodeId),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- remount via key on board switch
    [boardId],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState<Node<WorkflowNodeData>>(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initial.edges);
  const [pendingDelete, setPendingDelete] = useState<{ nodeId: string; label: string; running: boolean } | null>(null);
  const nodeStatusMap = useRuntimeStore((s) => s.nodeStatus);
  const nodeErrorMap = useRuntimeStore((s) => s.nodeError);
  const selectedNodeId = useRuntimeStore((s) => s.selectedNodeId);
  const setSelectedNodeId = useRuntimeStore((s) => s.setSelectedNodeId);

  useEffect(() => {
    flowRef.current = {
      getNodes: () => nodes,
      getEdges: () => edges,
      getNode: (id) => nodes.find((n) => n.id === id),
      setGraph: (n, e) => {
        setNodes(n);
        setEdges(e);
      },
      addNode: (node) => setNodes((nds) => [...nds, node]),
      updateNodeData: (nodeId, patch) => {
        setNodes((nds) =>
          nds.map((n) =>
            n.id === nodeId ? { ...n, data: { ...n.data, ...patch } } : n,
          ),
        );
      },
    };
  }, [nodes, edges, setNodes, setEdges, flowRef]);

  useEffect(() => {
    setEdges((eds) =>
      eds.map((e) => {
        const next = edgeVisual(e.source, boardId, nodeStatusMap);
        if (e.animated === next.animated && e.style?.stroke === next.style?.stroke) return e;
        return { ...e, ...next };
      }),
    );
  }, [nodeStatusMap, boardId, setEdges]);

  useEffect(() => {
    setNodes((nds) =>
      nds.map((n) => {
        const status = nodeStatusMap[`${boardId}:${n.id}`] ?? "idle";
        const error = nodeErrorMap[`${boardId}:${n.id}`];
        const isEntry = n.id === entryNodeId;
        const selected = n.id === selectedNodeId;
        // Skip rebuilding the node object when nothing relevant changed —
        // returning a new reference here would retrigger the graph-change effect.
        if (n.data.status === status && n.data.error === error && n.data.isEntry === isEntry && n.selected === selected) {
          return n;
        }
        return { ...n, data: { ...n.data, status, isEntry, error }, selected };
      }),
    );
  }, [nodeStatusMap, nodeErrorMap, boardId, entryNodeId, selectedNodeId, setNodes]);

  // Keep the latest callback in a ref so the effect below fires only when the
  // graph itself changes, not when the (unstable) callback identity changes.
  const onGraphChangeRef = useRef(onGraphChange);
  onGraphChangeRef.current = onGraphChange;

  useEffect(() => {
    onGraphChangeRef.current(nodes, edges);
  }, [nodes, edges]);

  const onConnect = useCallback(
    (conn: Connection) => {
      if (!conn.source) return;
      const visual = edgeVisual(conn.source, boardId, nodeStatusMap);
      setEdges((eds) =>
        addEdge({ ...conn, id: crypto.randomUUID(), ...visual }, eds),
      );
    },
    [boardId, nodeStatusMap, setEdges],
  );

  const doDeleteNode = useCallback(
    (nodeId: string) => {
      if (useRuntimeStore.getState().overlayNodeId === nodeId) {
        useRuntimeStore.getState().setOverlayNodeId(null);
      }
      setNodes((nds) => nds.filter((n) => n.id !== nodeId));
      setEdges((eds) =>
        eds.filter((ed) => ed.source !== nodeId && ed.target !== nodeId),
      );
      if (selectedNodeId === nodeId) setSelectedNodeId(null);
      setPendingDelete(null);
    },
    [setNodes, setEdges, selectedNodeId, setSelectedNodeId],
  );

  const onDeleteNode = useCallback(
    (nodeId: string) => {
      const node = nodes.find((n) => n.id === nodeId);
      const label = node?.data.label ?? nodeId;
      const running = nodeStatusMap[`${boardId}:${nodeId}`] === "running";
      setPendingDelete({ nodeId, label, running });
    },
    [nodes, nodeStatusMap, boardId],
  );

  // Flip canBeFinal. The graph-change effect above re-syncs to the backend, so a
  // live toggle reaches a running node (which then learns it may/ must end).
  const onToggleFinal = useCallback(
    (nodeId: string) => {
      setNodes((nds) =>
        nds.map((n) =>
          n.id === nodeId
            ? { ...n, data: { ...n.data, canBeFinal: n.data.canBeFinal === false } }
            : n,
        ),
      );
    },
    [setNodes],
  );

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.key === "Delete" || e.key === "Backspace") && selectedNodeId) {
        const t = e.target as HTMLElement;
        if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") return;
        // Never delete via keyboard while a terminal is expanded full-screen:
        // Backspace there belongs to the terminal, not the canvas.
        if (useRuntimeStore.getState().overlayNodeId) return;
        onDeleteNode(selectedNodeId);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedNodeId, onDeleteNode]);

  return (
    <TerminalContext.Provider
      value={{ boardId, send, onExpand, onDelete: onDeleteNode, onEditPrompt, onToggleFinal }}
    >
    <div className="relative h-full w-full">
      {pendingDelete && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="flex flex-col gap-3 rounded-lg border border-zinc-700/60 bg-zinc-900 p-5 shadow-xl w-[300px]">
            <p className="text-sm text-zinc-200">
              {pendingDelete.running
                ? <>Node <span className="font-semibold text-white">"{pendingDelete.label}"</span> is running. Delete it anyway?</>
                : <>Delete node <span className="font-semibold text-white">"{pendingDelete.label}"</span>?</>}
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="rounded px-3 py-1.5 text-xs text-zinc-300 hover:bg-white/5 transition-colors"
                onClick={() => setPendingDelete(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="rounded bg-red-600/80 px-3 py-1.5 text-xs text-white hover:bg-red-500 transition-colors"
                onClick={() => doDeleteNode(pendingDelete.nodeId)}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={(_, node) => setSelectedNodeId(node.id)}
        onPaneClick={() => setSelectedNodeId(null)}
        nodeTypes={nodeTypes}
        defaultEdgeOptions={{ animated: false, style: { stroke: IDLE_EDGE_STROKE } }}
        deleteKeyCode={null}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        {nodes.length === 0 && (
          <Panel position="top-center" className="mt-8 w-full max-w-2xl mx-auto px-4">
            <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/95 p-6 shadow-2xl shadow-black/40 backdrop-blur-md">
              <div className="text-center mb-5">
                <h2 className="text-sm font-semibold text-zinc-200">Start a workflow</h2>
                <p className="mt-1 text-xs text-zinc-500">Pick a template for instant setup, or add agents manually.</p>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 mb-5">
                {WORKFLOW_TEMPLATES.map((tpl) => (
                  <button
                    key={tpl.id}
                    type="button"
                    onClick={() => onLoadTemplate?.(tpl)}
                    className="group flex flex-col items-start gap-1.5 rounded-lg border border-white/[0.06] bg-white/[0.02] p-3 text-left transition-all hover:border-violet-500/30 hover:bg-violet-500/[0.06] active:scale-[0.98]"
                  >
                    <span className="text-lg leading-none">{tpl.icon}</span>
                    <span className="text-[11px] font-medium text-zinc-200 leading-tight group-hover:text-violet-200 transition-colors">
                      {tpl.name}
                    </span>
                    <span className="text-[10px] text-zinc-500 leading-snug line-clamp-2">
                      {tpl.description}
                    </span>
                    <span className="mt-auto inline-flex items-center gap-1 text-[9px] font-medium uppercase tracking-wider text-zinc-600 group-hover:text-violet-400/70 transition-colors">
                      <Workflow size={10} strokeWidth={2} />
                      {tpl.graph.nodes.length} nodes
                    </span>
                  </button>
                ))}
              </div>

              <div className="flex items-center justify-center gap-3">
                {onAddAgent && (
                  <button
                    type="button"
                    onClick={onAddAgent}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-xs font-medium text-zinc-200 transition-colors hover:bg-white/10 hover:border-white/20 active:scale-[0.98]"
                  >
                    <Plus size={14} strokeWidth={2} />
                    Add agent manually
                  </button>
                )}
              </div>
            </div>
          </Panel>
        )}
        <Background gap={26} size={1.5} color="#27272a" />
        <Controls className="!bg-zinc-900/90 !backdrop-blur-md [&>button]:!bg-transparent [&>button]:!text-zinc-300 [&>button:hover]:!bg-white/10 [&>button]:!border-white/5" />
        <MiniMap
          className="!bg-zinc-900/80 !backdrop-blur-md"
          maskColor="rgba(9, 9, 11, 0.6)"
          nodeColor={(n) => {
            const s = (n.data as WorkflowNodeData)?.status;
            if (s === "running") return "#34d399";
            if (s === "error") return "#f87171";
            return "#52525b";
          }}
        />
      </ReactFlow>
    </div>
    </TerminalContext.Provider>
  );
}

export function flowToSnapshot(
  nodes: Node<WorkflowNodeData>[],
  edges: Edge[],
): BoardSnapshot {
  return {
    nodes: nodes.map((n) => ({
      id: n.id,
      type: n.type ?? "agent",
      position: n.position,
      data: {
        label: n.data.label,
        promptId: n.data.promptId,
        status: n.data.status ?? "idle",
        promptOverride: n.data.promptOverride,
        runtime: n.data.runtime,
        isEntry: n.data.isEntry,
        canBeFinal: n.data.canBeFinal,
      },
    })),
    edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
  };
}
