import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import { BoardManager, type BoardListItem } from "./BoardManager.js";
import type { PtyHub } from "../pty/PtyHub.js";
import type { BoardState, WorkflowGraph } from "../types.js";

const mockBoards = vi.hoisted(() => new Map<string, BoardState>());

vi.mock("../db/index.js", () => ({
  createBoard: vi.fn((id: string, cwd: string, label: string) => {
    const board: BoardState = {
      boardId: id,
      cwd,
      label,
      createdAt: Date.now(),
    };
    mockBoards.set(id, board);
    return board;
  }),
  listBoards: vi.fn(() => Array.from(mockBoards.values())),
  getBoard: vi.fn((id: string) => mockBoards.get(id)),
  deleteBoard: vi.fn((id: string) => {
    const had = mockBoards.has(id);
    mockBoards.delete(id);
    return had;
  }),
  saveBoardGraph: vi.fn((id: string, graph: WorkflowGraph) => {
    const board = mockBoards.get(id);
    if (!board) return undefined;
    const updated = { ...board, graph };
    mockBoards.set(id, updated);
    return updated;
  }),
}));

function makeFakePtyHub(
  overrides: Partial<{
    running: Set<string>;
    statuses: Array<{ nodeId: string; label: string; status: "idle" | "running"; startedAt?: number }>;
    edges: Array<{ id: string; sourceNodeId: string; targetNodeId: string }>;
  }> = {},
): PtyHub {
  const running = overrides.running ?? new Set<string>();
  const statuses = overrides.statuses ?? [];
  const edges = overrides.edges ?? [];
  return {
    setGraph: vi.fn(),
    ensure: vi.fn(),
    injectTask: vi.fn(),
    input: vi.fn(),
    kill: vi.fn(),
    killBoard: vi.fn(),
    isNodeRunning: vi.fn((boardId: string, nodeId: string) => running.has(`${boardId}:${nodeId}`)),
    getNodeStatuses: vi.fn(() => statuses),
    getEdges: vi.fn(() => edges),
  } as unknown as PtyHub;
}

const sampleGraph: WorkflowGraph = {
  name: "Test flow",
  cwd: "/tmp",
  entryNodeId: "n1",
  nodes: [
    { id: "n1", label: "Architect", promptId: "p1", position: { x: 0, y: 0 } },
    { id: "n2", label: "Developer", promptId: "p2", position: { x: 100, y: 0 } },
  ],
  edges: [{ id: "e1", sourceNodeId: "n1", targetNodeId: "n2" }],
};

describe("BoardManager", () => {
  beforeEach(() => {
    mockBoards.clear();
  });

  it("creates a board with a generated id", () => {
    const manager = new BoardManager(makeFakePtyHub());
    const board = manager.create("/tmp", "My board");
    expect(board.boardId).toBeTruthy();
    expect(board.cwd).toBe("/tmp");
    expect(board.label).toBe("My board");
    expect(manager.get(board.boardId)).toEqual(board);
  });

  it("falls back to folder name when label is omitted", () => {
    const manager = new BoardManager(makeFakePtyHub());
    const board = manager.create("/tmp");
    expect(board.label).toBe("tmp");
  });

  it("rejects an invalid cwd", () => {
    const manager = new BoardManager(makeFakePtyHub());
    expect(() => manager.create("/does/not/exist")).toThrow("Not a valid directory");
  });

  it("lists boards with node and running counts", () => {
    const ptyHub = makeFakePtyHub();
    const manager = new BoardManager(ptyHub);
    const b1 = manager.create("/tmp", "A");
    const b2 = manager.create("/tmp", "B");
    manager.setGraph(b1.boardId, sampleGraph);
    manager.setGraph(b2.boardId, { ...sampleGraph, nodes: [] });

    ptyHub.isNodeRunning = vi.fn(
      (boardId: string, nodeId: string) =>
        boardId === b1.boardId && nodeId === "n1",
    );

    const list = manager.list();
    expect(list.find((b) => b.boardId === b1.boardId)).toMatchObject({
      nodeCount: 2,
      runningCount: 1,
    });
    expect(list.find((b) => b.boardId === b2.boardId)).toMatchObject({
      nodeCount: 0,
      runningCount: 0,
    });
  });

  it("removes a board and kills its sessions", () => {
    const ptyHub = makeFakePtyHub();
    const manager = new BoardManager(ptyHub);
    const board = manager.create("/tmp");
    expect(manager.delete(board.boardId)).toBe(true);
    expect(manager.get(board.boardId)).toBeUndefined();
    expect(ptyHub.killBoard).toHaveBeenCalledWith(board.boardId);
  });

  it("returns false when deleting an unknown board", () => {
    const manager = new BoardManager(makeFakePtyHub());
    expect(manager.delete("unknown")).toBe(false);
  });

  it("loads a graph into ptyHub using the board cwd as fallback", () => {
    const ptyHub = makeFakePtyHub();
    const manager = new BoardManager(ptyHub);
    const board = manager.create("/tmp");
    manager.setGraph(board.boardId, { ...sampleGraph, cwd: undefined });

    expect(ptyHub.setGraph).toHaveBeenCalledWith(
      board.boardId,
      expect.objectContaining({ cwd: "/tmp" }),
      "/tmp",
    );
    expect(manager.getGraph(board.boardId)?.cwd).toBe("/tmp");
  });

  it("prefers graph cwd over board cwd and validates it", () => {
    const graphCwd = "/tmp/orchestra-test-graph";
    try {
      fs.mkdirSync(graphCwd, { recursive: true });
      const ptyHub = makeFakePtyHub();
      const manager = new BoardManager(ptyHub);
      const board = manager.create("/tmp");
      manager.setGraph(board.boardId, { ...sampleGraph, cwd: graphCwd });

      expect(ptyHub.setGraph).toHaveBeenCalledWith(
        board.boardId,
        expect.objectContaining({ cwd: graphCwd }),
        graphCwd,
      );
    } finally {
      fs.rmSync(graphCwd, { recursive: true, force: true });
    }
  });

  it("rejects graph cwd that does not exist", () => {
    const manager = new BoardManager(makeFakePtyHub());
    const board = manager.create("/tmp");
    expect(() =>
      manager.setGraph(board.boardId, { ...sampleGraph, cwd: "/not/real" }),
    ).toThrow("Not a valid directory");
  });

  it("runs the requested node", () => {
    const ptyHub = makeFakePtyHub();
    const manager = new BoardManager(ptyHub);
    const board = manager.create("/tmp");
    manager.setGraph(board.boardId, sampleGraph);

    const result = manager.run(board.boardId, "n2", "implement auth");
    expect(result.nodeId).toBe("n2");
    expect(ptyHub.ensure).toHaveBeenCalledWith(board.boardId, "n2", 80, 24);
    expect(ptyHub.injectTask).toHaveBeenCalledWith(board.boardId, "n2", "implement auth");
  });

  it("runs the entry node when nodeId is omitted", () => {
    const ptyHub = makeFakePtyHub();
    const manager = new BoardManager(ptyHub);
    const board = manager.create("/tmp");
    manager.setGraph(board.boardId, sampleGraph);

    const result = manager.run(board.boardId, undefined, "design");
    expect(result.nodeId).toBe("n1");
    expect(ptyHub.injectTask).toHaveBeenCalledWith(board.boardId, "n1", "design");
  });

  it("throws when running on a board with no graph", () => {
    const manager = new BoardManager(makeFakePtyHub());
    const board = manager.create("/tmp");
    expect(() => manager.run(board.boardId, undefined, "x")).toThrow("No graph loaded");
  });

  it("throws when target node is missing", () => {
    const manager = new BoardManager(makeFakePtyHub());
    const board = manager.create("/tmp");
    manager.setGraph(board.boardId, sampleGraph);
    expect(() => manager.run(board.boardId, "nope", "x")).toThrow("Node not found");
  });

  it("stops a board and reports how many nodes were running", () => {
    const ptyHub = makeFakePtyHub({
      statuses: [
        { nodeId: "n1", label: "A", status: "running", startedAt: 1 },
        { nodeId: "n2", label: "B", status: "idle" },
      ],
    });
    const manager = new BoardManager(ptyHub);
    const board = manager.create("/tmp");
    expect(manager.stop(board.boardId)).toEqual({ ok: true, killed: 1 });
    expect(ptyHub.killBoard).toHaveBeenCalledWith(board.boardId);
  });

  it("stops, injects and sends input to a single node", () => {
    const ptyHub = makeFakePtyHub();
    const manager = new BoardManager(ptyHub);
    const board = manager.create("/tmp");
    manager.setGraph(board.boardId, sampleGraph);

    expect(manager.stopNode(board.boardId, "n1")).toEqual({ ok: true });
    expect(ptyHub.kill).toHaveBeenCalledWith(board.boardId, "n1");

    expect(manager.injectNode(board.boardId, "n1", "hello")).toEqual({ ok: true });
    expect(ptyHub.ensure).toHaveBeenCalledWith(board.boardId, "n1", 80, 24);
    expect(ptyHub.injectTask).toHaveBeenCalledWith(board.boardId, "n1", "hello");

    expect(manager.inputNode(board.boardId, "n1", "x")).toEqual({ ok: true });
    expect(ptyHub.input).toHaveBeenCalledWith(board.boardId, "n1", "x");
  });

  it("throws when operating on an unknown node", () => {
    const manager = new BoardManager(makeFakePtyHub());
    const board = manager.create("/tmp");
    manager.setGraph(board.boardId, sampleGraph);
    expect(() => manager.stopNode(board.boardId, "nope")).toThrow("Node not found");
  });

  it("returns status with nodes and edges", () => {
    const ptyHub = makeFakePtyHub({
      statuses: [{ nodeId: "n1", label: "A", status: "running", startedAt: 42 }],
      edges: [{ id: "e1", sourceNodeId: "n1", targetNodeId: "n2" }],
    });
    const manager = new BoardManager(ptyHub);
    const board = manager.create("/tmp");
    manager.setGraph(board.boardId, sampleGraph);

    const status = manager.status(board.boardId);
    expect(status.nodes).toEqual([{ nodeId: "n1", label: "A", status: "running", startedAt: 42 }]);
    expect(status.edges).toEqual([{ id: "e1", sourceNodeId: "n1", targetNodeId: "n2" }]);
  });
});

describe("BoardManager granular CRUD", () => {
  beforeEach(() => {
    mockBoards.clear();
  });

  function seed() {
    const ptyHub = makeFakePtyHub();
    const manager = new BoardManager(ptyHub);
    const board = manager.create("/tmp");
    manager.setGraph(board.boardId, structuredClone(sampleGraph));
    return { ptyHub, manager, boardId: board.boardId };
  }

  // ── nodes ──────────────────────────────────────────────────────────────────

  it("addNode appends a node with a generated id and persists", () => {
    const { manager, ptyHub, boardId } = seed();
    const node = manager.addNode(boardId, {
      label: "Reviewer",
      promptId: "p3",
      position: { x: 200, y: 0 },
    });
    expect(node.id).toBeTruthy();
    expect(manager.getGraph(boardId)?.nodes).toHaveLength(3);
    expect(ptyHub.setGraph).toHaveBeenCalled();
  });

  it("addNode honours a caller-supplied id", () => {
    const { manager, boardId } = seed();
    const node = manager.addNode(boardId, {
      id: "custom",
      label: "X",
      promptId: "p3",
      position: { x: 0, y: 0 },
    });
    expect(node.id).toBe("custom");
  });

  it("addNode throws on an unknown board", () => {
    const manager = new BoardManager(makeFakePtyHub());
    expect(() =>
      manager.addNode("nope", { label: "X", promptId: "p", position: { x: 0, y: 0 } }),
    ).toThrow("Board not found");
  });

  it("updateNode mutates only the provided fields and returns the node", () => {
    const { manager, boardId } = seed();
    const updated = manager.updateNode(boardId, "n1", {
      label: "Renamed",
      canBeFinal: false,
    });
    expect(updated.label).toBe("Renamed");
    expect(updated.canBeFinal).toBe(false);
    // untouched field preserved
    expect(updated.promptId).toBe("p1");
    expect(manager.getGraph(boardId)?.nodes.find((n) => n.id === "n1")?.label).toBe("Renamed");
  });

  it("updateNode throws 'Node not found' for an unknown node", () => {
    const { manager, boardId } = seed();
    expect(() => manager.updateNode(boardId, "ghost", { label: "X" })).toThrow(
      "Node not found",
    );
  });

  it("deleteNode removes the node, orphan edges, and clears entryNodeId", () => {
    const { manager, boardId } = seed();
    expect(manager.deleteNode(boardId, "n1")).toBe(true);
    const graph = manager.getGraph(boardId);
    expect(graph?.nodes.map((n) => n.id)).toEqual(["n2"]);
    expect(graph?.edges).toHaveLength(0); // e1 referenced n1
    expect(graph?.entryNodeId).toBeNull(); // entry was n1
  });

  it("deleteNode returns false for an unknown node", () => {
    const { manager, boardId } = seed();
    expect(manager.deleteNode(boardId, "ghost")).toBe(false);
  });

  it("deleteNode throws on an unknown board", () => {
    const manager = new BoardManager(makeFakePtyHub());
    expect(() => manager.deleteNode("nope", "n1")).toThrow("Board not found");
  });

  // ── edges ──────────────────────────────────────────────────────────────────

  it("addEdge connects two existing nodes with a generated id", () => {
    const { manager, boardId } = seed();
    const edge = manager.addEdge(boardId, { sourceNodeId: "n2", targetNodeId: "n1" });
    expect(edge.id).toBeTruthy();
    expect(manager.getGraph(boardId)?.edges).toHaveLength(2);
  });

  it("addEdge rejects a self-loop", () => {
    const { manager, boardId } = seed();
    expect(() =>
      manager.addEdge(boardId, { sourceNodeId: "n1", targetNodeId: "n1" }),
    ).toThrow("Self-loop");
  });

  it("addEdge rejects edges to non-existent nodes", () => {
    const { manager, boardId } = seed();
    expect(() =>
      manager.addEdge(boardId, { sourceNodeId: "n1", targetNodeId: "ghost" }),
    ).toThrow("Target node not found");
    expect(() =>
      manager.addEdge(boardId, { sourceNodeId: "ghost", targetNodeId: "n1" }),
    ).toThrow("Source node not found");
  });

  it("deleteEdge removes the edge and returns true", () => {
    const { manager, boardId } = seed();
    expect(manager.deleteEdge(boardId, "e1")).toBe(true);
    expect(manager.getGraph(boardId)?.edges).toHaveLength(0);
  });

  it("deleteEdge returns false for an unknown edge or board", () => {
    const { manager, boardId } = seed();
    expect(manager.deleteEdge(boardId, "ghost")).toBe(false);
    expect(manager.deleteEdge("nope", "e1")).toBe(false);
  });
});
