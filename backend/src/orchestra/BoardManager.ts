import fs from "node:fs";
import path from "node:path";
import {
  createBoard as dbCreateBoard,
  deleteBoard as dbDeleteBoard,
  getBoard as dbGetBoard,
  listBoards as dbListBoards,
  saveBoardGraph as dbSaveBoardGraph,
} from "../db/index.js";
import type { PtyHub } from "../pty/PtyHub.js";
import type { BoardState, WorkflowEdge, WorkflowGraph, WorkflowNode } from "../types.js";

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
        this.ptyHub.setGraph(b.boardId, b.graph, b.graph.cwd || b.cwd);
      }
    }
  }

  private resolveCwd(cwd: string): string {
    const resolved = path.resolve(cwd);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new Error(`Not a valid directory: ${cwd}`);
    }
    return resolved;
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
    const resolved = this.resolveCwd(cwd);
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

  setGraph(boardId: string, graph: WorkflowGraph): BoardState {
    const board = this.boards.get(boardId);
    if (!board) throw new Error(`Board not found: ${boardId}`);
    const cwd = graph.cwd && graph.cwd.trim() ? this.resolveCwd(graph.cwd.trim()) : board.cwd;
    const graphWithCwd: WorkflowGraph = { ...graph, cwd };
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
    board.graph.nodes.push(newNode);

    // Persist via setGraph (saves to DB + re-syncs PtyHub)
    this.setGraph(boardId, board.graph);
    return newNode;
  }

  updateNode(
    boardId: string,
    nodeId: string,
    patch: Partial<Omit<WorkflowNode, "id">>,
  ): WorkflowNode {
    const { board, graph, node } = this.getNode(boardId, nodeId);

    if (patch.label !== undefined) node.label = patch.label;
    if (patch.promptId !== undefined) node.promptId = patch.promptId;
    if (patch.promptOverride !== undefined) node.promptOverride = patch.promptOverride;
    if (patch.canBeFinal !== undefined) node.canBeFinal = patch.canBeFinal;
    if (patch.position !== undefined) node.position = patch.position;

    // Persist via setGraph (saves to DB + triggers live finality/connection sync)
    this.setGraph(boardId, graph);

    // Return the updated node from the freshly saved graph
    const updated = this.boards.get(boardId)?.graph?.nodes.find((n) => n.id === nodeId);
    if (!updated) throw new Error(`Node vanished after update: ${nodeId}`);
    return updated;
  }

  deleteNode(boardId: string, nodeId: string): boolean {
    const board = this.boards.get(boardId);
    if (!board) throw new Error(`Board not found: ${boardId}`);
    if (!board.graph) throw new Error(`No graph loaded for board: ${boardId}`);

    const idx = board.graph.nodes.findIndex((n) => n.id === nodeId);
    if (idx === -1) return false;

    board.graph.nodes.splice(idx, 1);

    // Also remove any edges referencing this node
    board.graph.edges = board.graph.edges.filter(
      (e) => e.sourceNodeId !== nodeId && e.targetNodeId !== nodeId,
    );

    // Clear entryNodeId if it was the deleted node
    if (board.graph.entryNodeId === nodeId) {
      board.graph.entryNodeId = null;
    }

    // Persist via setGraph — PtyHub auto-kills the node's PTY if running
    this.setGraph(boardId, board.graph);
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
    board.graph.edges.push(newEdge);

    this.setGraph(boardId, board.graph);
    return newEdge;
  }

  deleteEdge(boardId: string, edgeId: string): boolean {
    const board = this.boards.get(boardId);
    if (!board || !board.graph) return false;

    const idx = board.graph.edges.findIndex((e) => e.id === edgeId);
    if (idx === -1) return false;

    board.graph.edges.splice(idx, 1);
    this.setGraph(boardId, board.graph);
    return true;
  }
}
