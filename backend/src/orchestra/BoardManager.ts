import {
  createBoard as dbCreateBoard,
  deleteBoard as dbDeleteBoard,
  getBoard as dbGetBoard,
  listBoards as dbListBoards,
  saveBoardGraph as dbSaveBoardGraph,
} from "../db/index.js";
import type { PtyHub } from "../pty/PtyHub.js";
import type { BoardState, WorkflowEdge, WorkflowGraph, WorkflowNode } from "../types.js";
import { resolveBoardCwd, resolveCwd } from "../utils/paths.js";

export interface BoardListItem {
  boardId: string;
  cwd: string;
  label: string;
  nodeCount: number;
  runningCount: number;
}

export class BoardManager {
  private boards = new Map<string, BoardState>();

  constructor(private ptyHub: PtyHub) {
    // Re-hydrate boards from SQLite and replay their graphs into PtyHub so
    // status, handles and handoff resolution work immediately after restart.
    for (const b of dbListBoards()) {
      this.boards.set(b.boardId, b);
      if (b.graph) {
        try {
          const cwd = resolveBoardCwd(b.graph.cwd, b.cwd);
          this.ptyHub.setGraph(b.boardId, b.graph, cwd);
        } catch (err) {
          console.log(
            "pinodes-orchestra: skip board rehydrate, cwd invalid:",
            b.boardId,
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    }
  }

  private getNode(boardId: string, nodeId: string) {
    const board = this.boards.get(boardId);
    if (!board) throw new Error(`Board not found: ${boardId}`);
    const graph = board.graph;
    if (!graph) throw new Error(`No graph loaded for board: ${boardId}`);
    const node = graph.nodes.find((n) => n.id === nodeId);
    if (!node) throw new Error(`Node not found in graph: ${nodeId}`);
    return { board, graph, node };
  }

  create(cwd: string, label?: string): BoardState {
    const resolved = resolveCwd(cwd);
    const finalLabel = label ?? cwd.split("/").filter(Boolean).pop() ?? "board";
    const boardId = crypto.randomUUID();
    const board = dbCreateBoard(boardId, resolved, finalLabel);
    this.boards.set(board.boardId, board);
    return board;
  }

  list(): BoardListItem[] {
    return [...this.boards.values()].map((b) => ({
      boardId: b.boardId,
      cwd: b.cwd,
      label: b.label,
      nodeCount: b.graph?.nodes.length ?? 0,
      runningCount: (b.graph?.nodes ?? []).filter((n) =>
        this.ptyHub.isNodeRunning(b.boardId, n.id),
      ).length,
    }));
  }

  get(boardId: string): BoardState | undefined {
    return this.boards.get(boardId);
  }

  delete(boardId: string): boolean {
    if (!this.boards.has(boardId)) return false;
    this.ptyHub.killBoard(boardId);
    dbDeleteBoard(boardId);
    this.boards.delete(boardId);
    return true;
  }

  /**
   * Reject a contradictory graph before it is persisted. Every CRUD path funnels
   * through setGraph, so this single chokepoint covers them all (PUT /graph and
   * /flows included — not just the granular edge endpoint). Rules:
   *   - an edge may not be a self-loop (a node handing off to itself);
   *   - an edge may not reference a node absent from the graph;
   *   - a node marked non-final (canBeFinal === false) with no outgoing edges can
   *     neither end the chain nor hand off — the agent could never satisfy its rule.
   */
  private validateGraph(graph: WorkflowGraph): void {
    const nodeIds = new Set(graph.nodes.map((n) => n.id));
    const outCount = new Map<string, number>();
    for (const e of graph.edges) {
      if (e.sourceNodeId === e.targetNodeId) {
        throw new Error(`Self-loop edges are not allowed (node "${e.sourceNodeId}").`);
      }
      if (!nodeIds.has(e.sourceNodeId)) {
        throw new Error(`Edge source node not found in graph: ${e.sourceNodeId}`);
      }
      if (!nodeIds.has(e.targetNodeId)) {
        throw new Error(`Edge target node not found in graph: ${e.targetNodeId}`);
      }
      outCount.set(e.sourceNodeId, (outCount.get(e.sourceNodeId) ?? 0) + 1);
    }
    for (const n of graph.nodes) {
      if (n.canBeFinal === false && (outCount.get(n.id) ?? 0) === 0) {
        throw new Error(
          `Node "${n.label}" is marked non-final (canBeFinal=false) but has no ` +
            `outgoing edges — it can neither end the chain nor hand off. Connect it ` +
            `to at least one downstream node, or set canBeFinal=true.`,
        );
      }
    }
  }

  setGraph(boardId: string, graph: WorkflowGraph): BoardState {
    const board = this.boards.get(boardId);
    if (!board) throw new Error(`Board not found: ${boardId}`);
    const cwd = graph.cwd && graph.cwd.trim() ? resolveCwd(graph.cwd.trim()) : board.cwd;
    const graphWithCwd: WorkflowGraph = { ...graph, cwd };
    this.validateGraph(graphWithCwd); // throws before any persistence side effect
    const saved = dbSaveBoardGraph(boardId, graphWithCwd);
    if (!saved) throw new Error(`Failed to save graph for board: ${boardId}`);
    this.boards.set(boardId, saved);
    this.ptyHub.setGraph(boardId, graphWithCwd, cwd);
    return saved;
  }

  getGraph(boardId: string): WorkflowGraph | undefined {
    return this.boards.get(boardId)?.graph;
  }

  /**
   * Inject a message into a node. If `nodeId` is omitted, the board's entry
   * node is used. The target node must exist in the loaded graph.
   */
  run(boardId: string, nodeId: string | undefined, message: string): { nodeId: string } {
    const board = this.boards.get(boardId);
    if (!board) throw new Error(`Board not found: ${boardId}`);
    const graph = board.graph;
    if (!graph) throw new Error(`No graph loaded for board: ${boardId}`);
    const targetId = nodeId ?? graph.entryNodeId ?? undefined;
    if (!targetId) {
      throw new Error(`No target node specified and board has no entryNodeId`);
    }
    const node = graph.nodes.find((n) => n.id === targetId);
    if (!node) throw new Error(`Node not found in graph: ${targetId}`);

    this.ptyHub.ensure(boardId, targetId, 80, 24);
    this.ptyHub.injectTask(boardId, targetId, message);
    return { nodeId: targetId };
  }

  stop(boardId: string): { ok: boolean; killed: number } {
    if (!this.boards.has(boardId)) return { ok: false, killed: 0 };
    const killed = this.ptyHub
      .getNodeStatuses(boardId)
      .filter((n) => n.status === "running").length;
    this.ptyHub.killBoard(boardId);
    return { ok: true, killed };
  }

  stopNode(boardId: string, nodeId: string): { ok: boolean } {
    this.getNode(boardId, nodeId);
    this.ptyHub.kill(boardId, nodeId);
    return { ok: true };
  }

  /** Kill and respawn a node's session (REST parity with the WS `restart_node`). */
  restartNode(boardId: string, nodeId: string): { ok: boolean } {
    this.getNode(boardId, nodeId);
    this.ptyHub.restart(boardId, nodeId, 80, 24);
    return { ok: true };
  }

  injectNode(boardId: string, nodeId: string, message: string): { ok: boolean } {
    this.getNode(boardId, nodeId);
    this.ptyHub.ensure(boardId, nodeId, 80, 24);
    this.ptyHub.injectTask(boardId, nodeId, message);
    return { ok: true };
  }

  inputNode(boardId: string, nodeId: string, data: string): { ok: boolean } {
    this.getNode(boardId, nodeId);
    this.ptyHub.input(boardId, nodeId, data);
    return { ok: true };
  }

  status(boardId: string) {
    const board = this.boards.get(boardId);
    if (!board) throw new Error(`Board not found: ${boardId}`);
    return {
      boardId,
      cwd: board.cwd,
      label: board.label,
      nodes: this.ptyHub.getNodeStatuses(boardId),
      edges: this.ptyHub.getEdges(boardId),
    };
  }

  waitForExit(
    boardId: string,
    nodeId: string,
    timeoutMs?: number,
  ): Promise<{ code: number | null; timedOut: boolean }> {
    return this.ptyHub.waitForExit(boardId, nodeId, timeoutMs);
  }

  // ── Granular CRUD: nodes ──────────────────────────────────────────────────

  addNode(
    boardId: string,
    node: Omit<WorkflowNode, "id"> & { id?: string },
  ): WorkflowNode {
    const board = this.boards.get(boardId);
    if (!board) throw new Error(`Board not found: ${boardId}`);
    if (!board.graph) throw new Error(`No graph loaded for board: ${boardId}`);

    const nodeId = node.id ?? crypto.randomUUID();
    const newNode: WorkflowNode = { ...node, id: nodeId };

    // Build the next graph immutably so a validation failure in setGraph never
    // leaves the in-memory graph half-mutated.
    const nextGraph: WorkflowGraph = {
      ...board.graph,
      nodes: [...board.graph.nodes, newNode],
    };
    this.setGraph(boardId, nextGraph);
    return newNode;
  }

  updateNode(
    boardId: string,
    nodeId: string,
    patch: Partial<Omit<WorkflowNode, "id">>,
  ): WorkflowNode {
    const { graph, node } = this.getNode(boardId, nodeId);

    const updatedNode: WorkflowNode = { ...node };
    if (patch.label !== undefined) updatedNode.label = patch.label;
    if (patch.promptId !== undefined) updatedNode.promptId = patch.promptId;
    if (patch.promptOverride !== undefined) updatedNode.promptOverride = patch.promptOverride;
    if (patch.canBeFinal !== undefined) updatedNode.canBeFinal = patch.canBeFinal;
    if (patch.runtime !== undefined) updatedNode.runtime = patch.runtime;
    if (patch.runtimeConfig !== undefined) updatedNode.runtimeConfig = patch.runtimeConfig;
    if (patch.position !== undefined) updatedNode.position = patch.position;

    const nextGraph: WorkflowGraph = {
      ...graph,
      nodes: graph.nodes.map((n) => (n.id === nodeId ? updatedNode : n)),
    };
    this.setGraph(boardId, nextGraph);

    // Return the updated node from the freshly saved graph
    const updated = this.boards.get(boardId)?.graph?.nodes.find((n) => n.id === nodeId);
    if (!updated) throw new Error(`Node vanished after update: ${nodeId}`);
    return updated;
  }

  deleteNode(boardId: string, nodeId: string): boolean {
    const board = this.boards.get(boardId);
    if (!board) throw new Error(`Board not found: ${boardId}`);
    if (!board.graph) throw new Error(`No graph loaded for board: ${boardId}`);

    if (!board.graph.nodes.some((n) => n.id === nodeId)) return false;

    const nextGraph: WorkflowGraph = {
      ...board.graph,
      nodes: board.graph.nodes.filter((n) => n.id !== nodeId),
      // Drop any edges referencing the removed node.
      edges: board.graph.edges.filter(
        (e) => e.sourceNodeId !== nodeId && e.targetNodeId !== nodeId,
      ),
      // Clear entryNodeId if it pointed at the removed node.
      entryNodeId: board.graph.entryNodeId === nodeId ? null : board.graph.entryNodeId,
    };
    // Persist via setGraph — PtyHub auto-kills the node's PTY if running.
    this.setGraph(boardId, nextGraph);
    return true;
  }

  // ── Granular CRUD: edges ──────────────────────────────────────────────────

  addEdge(
    boardId: string,
    edge: Omit<WorkflowEdge, "id"> & { id?: string },
  ): WorkflowEdge {
    const board = this.boards.get(boardId);
    if (!board) throw new Error(`Board not found: ${boardId}`);
    if (!board.graph) throw new Error(`No graph loaded for board: ${boardId}`);

    const { sourceNodeId, targetNodeId } = edge;

    if (sourceNodeId === targetNodeId) {
      throw new Error("Self-loop edges are not allowed");
    }

    const nodeIds = new Set(board.graph.nodes.map((n) => n.id));
    if (!nodeIds.has(sourceNodeId)) {
      throw new Error(`Source node not found in graph: ${sourceNodeId}`);
    }
    if (!nodeIds.has(targetNodeId)) {
      throw new Error(`Target node not found in graph: ${targetNodeId}`);
    }

    const edgeId = edge.id ?? crypto.randomUUID();
    const newEdge: WorkflowEdge = { ...edge, id: edgeId };
    const nextGraph: WorkflowGraph = {
      ...board.graph,
      edges: [...board.graph.edges, newEdge],
    };
    this.setGraph(boardId, nextGraph);
    return newEdge;
  }

  deleteEdge(boardId: string, edgeId: string): boolean {
    const board = this.boards.get(boardId);
    if (!board || !board.graph) return false;

    if (!board.graph.edges.some((e) => e.id === edgeId)) return false;

    const nextGraph: WorkflowGraph = {
      ...board.graph,
      edges: board.graph.edges.filter((e) => e.id !== edgeId),
    };
    this.setGraph(boardId, nextGraph);
    return true;
  }
}
