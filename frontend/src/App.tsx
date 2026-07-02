import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Columns3, Network, PanelRight, Save, Square, Download, Upload } from "lucide-react";
import type { Node, Edge } from "@xyflow/react";
import { BoardTabs } from "./components/BoardTabs";
import { FlowCanvas, flowToSnapshot, type FlowCanvasHandle } from "./components/FlowCanvas";
import { TerminalPanel } from "./components/TerminalPanel";
import { TerminalOverlay } from "./components/TerminalOverlay";
import { KanbanBoard } from "./components/KanbanBoard";
import { PromptLibrary } from "./components/PromptLibrary";
import { AddAgentModal, type AddAgentChoice } from "./components/AddAgentModal";
import { WorkflowPicker } from "./components/WorkflowPicker";
import { NodeInspector } from "./components/NodeInspector";
import { TimelinePanel } from "./components/TimelinePanel";
import { SystemPromptModal } from "./components/SystemPromptModal";
import { useOrchestraWs } from "./hooks/useOrchestraWs";
import { useBoardStore } from "./stores/boardStore";
import { graphFromFlow, useRuntimeStore } from "./stores/runtimeStore";
import { apiFetch } from "./lib/api";
import { IS_EMBEDDED, EMBED_CWD } from "./lib/embed";
import type { WorkflowTemplate } from "./lib/workflowTemplates";
import type { SystemPrompt, WorkflowGraph, WorkflowNodeData } from "./types";

export function App() {
  const flowRef = useRef<FlowCanvasHandle | null>(null);
  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const overlayNodeId = useRuntimeStore((s) => s.overlayNodeId);
  const setOverlayNodeId = useRuntimeStore((s) => s.setOverlayNodeId);
  const [promptEditNodeId, setPromptEditNodeId] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [rightTab, setRightTab] = useState<"terminal" | "timeline" | "inspector">("terminal");
  const [view, setView] = useState<"agents" | "kanban">("agents");
  const [addAgentOpen, setAddAgentOpen] = useState(false);

  const boards = useBoardStore((s) => s.boards);
  const activeBoardId = useBoardStore((s) => s.activeBoardId);
  const activeBoard =
    boards.find((b) => b.id === activeBoardId) ?? boards[0] ?? {
      id: "",
      label: "repo",
      cwd: ".",
      workflowName: "Untitled",
      workflowId: null,
      entryNodeId: null,
      snapshot: { nodes: [], edges: [] },
    };
  const updateActiveBoard = useBoardStore((s) => s.updateActiveBoard);
  const updateBoardSnapshot = useBoardStore((s) => s.updateBoardSnapshot);
  const setActiveBoard = useBoardStore((s) => s.setActiveBoard);
  const setDefaultCwd = useBoardStore((s) => s.setDefaultCwd);
  const bindWorkspace = useBoardStore((s) => s.bindWorkspace);

  const boardNodeLabels = useMemo(() => {
    const labels: Record<string, string> = {};
    for (const n of activeBoard.snapshot.nodes) {
      labels[n.id] = n.data.label;
    }
    return labels;
  }, [activeBoard.snapshot.nodes]);

  const { send } = useOrchestraWs(activeBoard.id, boardNodeLabels);
  const connected = useRuntimeStore((s) => s.connected);
  const prompts = useRuntimeStore((s) => s.prompts);
  const setPrompts = useRuntimeStore((s) => s.setPrompts);
  const setActiveBoardId = useRuntimeStore((s) => s.setActiveBoardId);
  const clearBoardRuntime = useRuntimeStore((s) => s.clearBoardRuntime);
  const setHermesAvailable = useRuntimeStore((s) => s.setHermesAvailable);

  useEffect(() => {
    // Embedded host (VS Code) provides the workspace cwd directly: bind the
    // single board to it and skip the standalone defaultCwd discovery.
    if (IS_EMBEDDED && EMBED_CWD) {
      bindWorkspace(EMBED_CWD);
      return;
    }
    void apiFetch("/api/info")
      .then((r) => r.json())
      .then((data: { defaultCwd?: string; runtimes?: { hermes?: boolean } }) => {
        if (data.defaultCwd) setDefaultCwd(data.defaultCwd);
        if (typeof data.runtimes?.hermes === "boolean") {
          setHermesAvailable(data.runtimes.hermes);
        }
      })
      .catch((err) => {
        console.error("pinodes-orchestra: /api/info unreachable", err);
        /* backend offline — BoardTabs will use "." */
      });
  }, [setDefaultCwd, bindWorkspace, setHermesAvailable]);

  useEffect(() => {
    setActiveBoardId(activeBoard.id);
  }, [activeBoard.id, setActiveBoardId]);

  const loadPrompts = useCallback(async () => {
    const res = await apiFetch("/api/prompts");
    setPrompts((await res.json()) as SystemPrompt[]);
  }, [setPrompts]);

  useEffect(() => {
    void loadPrompts();
  }, [loadPrompts]);

  const pushGraphToBackend = useCallback(
    (nodes: Node<WorkflowNodeData>[], edges: Edge[]) => {
      const graph = graphFromFlow(
        nodes,
        edges,
        activeBoard.workflowName,
        activeBoard.workflowId,
        activeBoard.cwd,
        activeBoard.entryNodeId,
      );
      send({ type: "load_graph", graph, cwd: activeBoard.cwd });
      updateBoardSnapshot(activeBoard.id, flowToSnapshot(nodes, edges));
    },
    [activeBoard, send, updateBoardSnapshot],
  );

  const scheduleSync = useCallback(
    (nodes: Node<WorkflowNodeData>[], edges: Edge[]) => {
      if (syncTimer.current) clearTimeout(syncTimer.current);
      syncTimer.current = setTimeout(() => pushGraphToBackend(nodes, edges), 300);
    },
    [pushGraphToBackend],
  );

  const onGraphChange = useCallback(
    (nodes: Node<WorkflowNodeData>[], edges: Edge[]) => {
      updateBoardSnapshot(activeBoard.id, flowToSnapshot(nodes, edges));
      if (nodes.length === 0) return;
      scheduleSync(nodes, edges);
    },
    [activeBoard.id, scheduleSync, updateBoardSnapshot],
  );

  const handleBoardSwitch = useCallback(
    (boardId: string) => {
      const board = useBoardStore.getState().boards.find((b) => b.id === boardId);
      if (!board) return;
      setActiveBoard(boardId);
      setActiveBoardId(boardId);
      clearBoardRuntime(boardId);
    },
    [setActiveBoard, setActiveBoardId, clearBoardRuntime],
  );

  useEffect(() => {
    if (activeBoard.snapshot.nodes.length > 0) {
      const timer = setTimeout(() => {
        const nodes = flowRef.current?.getNodes() ?? [];
        const edges = flowRef.current?.getEdges() ?? [];
        if (nodes.length > 0) pushGraphToBackend(nodes, edges);
      }, 400);
      return () => clearTimeout(timer);
    }
  }, [activeBoard.id]); // sync on board mount

  const addNodeFromChoice = ({ prompt, runtime }: AddAgentChoice) => {
    const id = crypto.randomUUID();
    const existing = flowRef.current?.getNodes() ?? [];
    const node: Node<WorkflowNodeData> = {
      id,
      type: "agent",
      position: { x: 140 + existing.length * 48, y: 100 + existing.length * 36 },
      data: {
        label: prompt.name,
        promptId: prompt.id,
        status: "idle",
        isEntry: false,
        runtime,
      },
    };
    flowRef.current?.addNode(node);
    useRuntimeStore.getState().setSelectedNodeId(id);
    setAddAgentOpen(false);
    setTimeout(() => {
      const nodes = flowRef.current?.getNodes() ?? [];
      const edges = flowRef.current?.getEdges() ?? [];
      pushGraphToBackend(nodes, edges);
    }, 50);
  };

  const saveWorkflow = async () => {
    const nodes = flowRef.current?.getNodes() ?? [];
    const edges = flowRef.current?.getEdges() ?? [];
    const graph = graphFromFlow(
      nodes,
      edges,
      activeBoard.workflowName,
      activeBoard.workflowId,
      activeBoard.cwd,
      activeBoard.entryNodeId,
    );
    const res = await apiFetch("/api/workflows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(graph),
    });
    const saved = (await res.json()) as WorkflowGraph;
    updateActiveBoard({ workflowName: saved.name, workflowId: saved.id ?? null });
  };

  const loadWorkflow = (graph: WorkflowGraph) => {
    const nodes: Node<WorkflowNodeData>[] = graph.nodes.map((n) => ({
      id: n.id,
      type: "agent",
      position: n.position,
      data: {
        label: n.label,
        promptId: n.promptId,
        status: "idle" as const,
        promptOverride: n.promptOverride ?? undefined,
        runtime: n.runtime ?? undefined,
        runtimeConfig: n.runtimeConfig ?? undefined,
        isEntry: n.id === graph.entryNodeId,
        canBeFinal: n.canBeFinal ?? undefined,
      },
    }));
    const edges: Edge[] = graph.edges.map((e) => ({
      id: e.id,
      source: e.sourceNodeId,
      target: e.targetNodeId,
      animated: false,
      style: { stroke: "#52525b" },
    }));
    flowRef.current?.setGraph(nodes, edges);
    updateActiveBoard({
      workflowName: graph.name,
      workflowId: graph.id ?? null,
      entryNodeId: graph.entryNodeId ?? null,
      cwd: graph.cwd ?? activeBoard.cwd,
    });
    pushGraphToBackend(nodes, edges);
  };

  const exportWorkflow = () => {
    const nodes = flowRef.current?.getNodes() ?? [];
    const edges = flowRef.current?.getEdges() ?? [];
    const graph = graphFromFlow(
      nodes,
      edges,
      activeBoard.workflowName,
      activeBoard.workflowId,
      activeBoard.cwd,
      activeBoard.entryNodeId,
    );
    const blob = new Blob([JSON.stringify(graph, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${activeBoard.workflowName.replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "workflow"}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const importWorkflow = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const graph = JSON.parse(reader.result as string) as WorkflowGraph;
          if (!graph.nodes || !Array.isArray(graph.nodes)) {
            window.alert("Invalid workflow file: missing nodes array.");
            return;
          }
          loadWorkflow(graph);
        } catch {
          window.alert("Could not parse workflow file. Ensure it is valid JSON.");
        }
      };
      reader.readAsText(file);
    };
    input.click();
  };

  const loadTemplate = (tpl: WorkflowTemplate) => {
    loadWorkflow({ ...tpl.graph, cwd: activeBoard.cwd });
  };

  const runFromHere = (nodeId: string, message: string) => {
    send({ type: "attach_node", nodeId });
    send({ type: "inject_task", nodeId, message });
  };

  // Kanban → agents: open the linked board and feed the card into its entry node.
  const launchCard = (boardId: string, task: string) => {
    const board = useBoardStore.getState().boards.find((b) => b.id === boardId);
    const entry = board?.entryNodeId;
    if (!entry) {
      window.alert(
        "This board has no entry node. Open it, select a node and press 'Set entry', then try again.",
      );
      return;
    }
    // Mark the board Kanban-tracked first, so every node it spawns learns to
    // move the card; then open it and feed the task into the entry node.
    send({ type: "track_kanban", boardId });
    handleBoardSwitch(boardId);
    setView("agents");
    // Let the board mount and sync its graph to the backend, then start the flow.
    setTimeout(() => {
      send({ type: "inject_task", boardId, nodeId: entry, message: task });
    }, 1300);
  };

  const overlayNode = overlayNodeId ? flowRef.current?.getNode(overlayNodeId) : undefined;
  const promptEditNode = promptEditNodeId
    ? flowRef.current?.getNode(promptEditNodeId)
    : undefined;

  return (
    <div className="relative flex h-full flex-col">
      <header className="flex h-9 shrink-0 items-stretch border-b border-zinc-800 bg-zinc-950">
        {/* brand */}
        <div className="toolbar-segment px-3">
          <h1 className="text-[13px] font-semibold tracking-tight select-none whitespace-nowrap">
            <span className="text-zinc-200">PiNodes</span>
            <span className="text-zinc-500"> Orchestra</span>
          </h1>
        </div>

        {/* view */}
        <div className="toolbar-segment gap-0.5">
          {(
            [
              { id: "agents" as const, label: "Agents", icon: Network },
              { id: "kanban" as const, label: "Kanban", icon: Columns3 },
            ] as const
          ).map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setView(id)}
              title={label}
              className={`toolbar-btn gap-1 px-2 ${view === id ? "active" : ""}`}
            >
              <Icon size={14} strokeWidth={1.75} />
              <span className="text-[11px]">{label}</span>
            </button>
          ))}
        </div>

        {/* connection */}
        <div className="toolbar-segment">
          <span
            className={`flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded ${
              connected ? "text-emerald-400/90" : "text-red-400/90"
            }`}
            title={connected ? "Connected to backend" : "Backend unreachable"}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                connected ? "bg-emerald-400 live-dot" : "bg-red-400"
              }`}
            />
            {connected ? "live" : "offline"}
          </span>
        </div>

        {/* workflow — agents view only */}
        {view === "agents" && (
          <div className="toolbar-segment min-w-0">
            <input
              value={activeBoard.workflowName}
              onChange={(e) => updateActiveBoard({ workflowName: e.target.value })}
              className="h-6 w-32 rounded bg-zinc-900 border border-zinc-700/60 px-2 text-[11px] text-zinc-300 transition-colors focus:border-zinc-500 focus:outline-none"
              title="Workflow name"
            />
            <button
              type="button"
              onClick={() => void saveWorkflow()}
              className="toolbar-btn"
              title="Save workflow"
            >
              <Save size={14} strokeWidth={1.75} />
            </button>
            <button
              type="button"
              onClick={exportWorkflow}
              className="toolbar-btn"
              title="Export workflow as JSON"
            >
              <Download size={14} strokeWidth={1.75} />
            </button>
            <button
              type="button"
              onClick={importWorkflow}
              className="toolbar-btn"
              title="Import workflow from JSON"
            >
              <Upload size={14} strokeWidth={1.75} />
            </button>
            <WorkflowPicker
              cwd={activeBoard.cwd}
              currentId={activeBoard.workflowId}
              onLoad={loadWorkflow}
              compact
            />
          </div>
        )}

        {/* board context — agents view only */}
        {view === "agents" && (
          <div className="toolbar-segment min-w-0 max-w-[220px]">
            <span
              className="truncate text-[11px] text-zinc-500"
              title={activeBoard.cwd}
            >
              {activeBoard.label}
            </span>
          </div>
        )}

        <div className="flex-1" />

        {/* actions */}
        <div className="toolbar-segment gap-0.5 pr-2">
          {view === "agents" && (
            <button
              type="button"
              onClick={() => send({ type: "stop_board" })}
              className="toolbar-btn danger gap-1 px-2"
              title="Stop board"
            >
              <Square size={12} strokeWidth={1.75} fill="currentColor" />
              <span className="text-[11px]">Stop</span>
            </button>
          )}
          {view === "agents" && (
            <button
              type="button"
              onClick={() => setPanelOpen((v) => !v)}
              className={`toolbar-btn ${panelOpen ? "active" : ""}`}
              title={panelOpen ? "Hide panel" : "Show panel"}
            >
              <PanelRight size={14} strokeWidth={1.75} />
            </button>
          )}
        </div>
      </header>

      {view === "kanban" ? (
        <KanbanBoard
          onOpenBoard={(id) => {
            handleBoardSwitch(id);
            setView("agents");
          }}
          onLaunch={launchCard}
        />
      ) : (
      <div className="flex flex-1 min-h-0">
        {!IS_EMBEDDED && <BoardTabs onBoardSwitch={handleBoardSwitch} />}

        <div className="flex flex-1 flex-col min-w-0">
          <PromptLibrary onAddAgent={() => setAddAgentOpen(true)} />

          <div className="flex flex-1 min-h-0">
            <div className="flex-[2] min-w-0">
              <FlowCanvas
                key={activeBoard.id}
                boardId={activeBoard.id}
                entryNodeId={activeBoard.entryNodeId}
                initialSnapshot={activeBoard.snapshot}
                onGraphChange={onGraphChange}
                flowRef={flowRef}
                send={send}
                onExpand={setOverlayNodeId}
                onEditPrompt={setPromptEditNodeId}
                onAddAgent={() => setAddAgentOpen(true)}
                onLoadTemplate={loadTemplate}
              />
            </div>

            {panelOpen && (
            <div className="w-[360px] shrink-0 flex flex-col border-l border-white/5 min-h-0">
              <div className="flex border-b border-zinc-800 shrink-0">
                {(
                  [
                    { id: "terminal" as const, label: "Terminal" },
                    { id: "timeline" as const, label: "Timeline" },
                    { id: "inspector" as const, label: "Inspector" },
                  ] as const
                ).map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setRightTab(tab.id)}
                    className={`flex-1 py-1.5 text-[11px] font-medium transition-colors ${
                      rightTab === tab.id
                        ? "border-b border-zinc-400 text-zinc-200"
                        : "text-zinc-500 hover:text-zinc-300"
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              <div className="flex-1 min-h-0 flex flex-col">
                {rightTab === "terminal" && (
                  <TerminalPanel
                    boardId={activeBoard.id}
                    send={send}
                    getSelectedNode={() =>
                      flowRef.current?.getNode(useRuntimeStore.getState().selectedNodeId ?? "")
                    }
                  />
                )}
                {rightTab === "timeline" && (
                  <TimelinePanel
                    boardId={activeBoard.id}
                    onSelectNode={(nodeId) => useRuntimeStore.getState().setSelectedNodeId(nodeId)}
                  />
                )}
                {rightTab === "inspector" && (
                  <NodeInspector
                    boardId={activeBoard.id}
                    entryNodeId={activeBoard.entryNodeId}
                    onSetEntry={(nodeId) => {
                      updateActiveBoard({ entryNodeId: nodeId });
                      const nodes = flowRef.current?.getNodes() ?? [];
                      nodes.forEach((n) => {
                        flowRef.current?.updateNodeData(n.id, { isEntry: n.id === nodeId });
                      });
                      scheduleSync(flowRef.current?.getNodes() ?? [], flowRef.current?.getEdges() ?? []);
                    }}
                    onUpdateNode={(nodeId, patch) => {
                      flowRef.current?.updateNodeData(nodeId, patch);
                      scheduleSync(flowRef.current?.getNodes() ?? [], flowRef.current?.getEdges() ?? []);
                    }}
                    onRunFromHere={runFromHere}
                    getSelectedNode={() =>
                      flowRef.current?.getNode(useRuntimeStore.getState().selectedNodeId ?? "")
                    }
                  />
                )}
              </div>
            </div>
            )}
          </div>
        </div>
      </div>
      )}

      {overlayNodeId && (
        <TerminalOverlay
          boardId={activeBoard.id}
          nodeId={overlayNodeId}
          label={overlayNode?.data.label ?? "pi"}
          send={send}
          onClose={() => setOverlayNodeId(null)}
        />
      )}

      {addAgentOpen && (
        <AddAgentModal
          prompts={prompts}
          onClose={() => setAddAgentOpen(false)}
          onConfirm={addNodeFromChoice}
          onRefreshPrompts={() => void loadPrompts()}
        />
      )}

      {promptEditNodeId && promptEditNode && (
        <SystemPromptModal
          label={promptEditNode.data.label}
          data={promptEditNode.data}
          onSave={(promptOverride) => {
            flowRef.current?.updateNodeData(promptEditNodeId, { promptOverride });
            scheduleSync(
              flowRef.current?.getNodes() ?? [],
              flowRef.current?.getEdges() ?? [],
            );
          }}
          onClose={() => setPromptEditNodeId(null)}
        />
      )}
    </div>
  );
}
