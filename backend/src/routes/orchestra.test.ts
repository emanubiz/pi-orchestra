import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import { createOrchestraRoutes } from "./orchestra.js";
import { BoardManager } from "../orchestra/BoardManager.js";
import { checkAuth, routeRequiresAuth } from "../utils/security.js";
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

const sampleGraph: WorkflowGraph = {
  name: "CI flow",
  cwd: "/tmp",
  entryNodeId: "arch",
  nodes: [
    { id: "arch", label: "Architect", promptId: "p1", position: { x: 0, y: 0 } },
    { id: "dev", label: "Developer", promptId: "p2", position: { x: 100, y: 0 } },
  ],
  edges: [{ id: "e1", sourceNodeId: "arch", targetNodeId: "dev" }],
};

function makeFakePtyHub(): PtyHub & {
  _setRunning: (boardId: string, nodeId: string, running: boolean) => void;
} {
  const running = new Set<string>();
  let graph: WorkflowGraph | undefined;
  const ensure = vi.fn();
  const injectTask = vi.fn();
  const input = vi.fn();
  const kill = vi.fn();
  const killBoard = vi.fn();
  const setGraph = vi.fn((_boardId: string, g: WorkflowGraph) => {
    graph = g;
  });
  const waitForExit = vi.fn(() => Promise.resolve({ code: 0, timedOut: false }));

  return {
    _setRunning(boardId: string, nodeId: string, value: boolean) {
      const k = `${boardId}:${nodeId}`;
      if (value) running.add(k);
      else running.delete(k);
    },
    setGraph,
    ensure,
    injectTask,
    input,
    kill,
    killBoard,
    isNodeRunning: (boardId: string, nodeId: string) =>
      running.has(`${boardId}:${nodeId}`),
    getNodeStatuses: (boardId: string) => {
      if (!graph) return [];
      return graph.nodes.map((n) => {
        const isRunning = running.has(`${boardId}:${n.id}`);
        return {
          nodeId: n.id,
          label: n.label,
          status: isRunning ? ("running" as const) : ("idle" as const),
          startedAt: isRunning ? 1 : undefined,
        };
      });
    },
    getEdges: () => graph?.edges ?? [],
    waitForExit,
  } as unknown as PtyHub & {
    _setRunning: (boardId: string, nodeId: string, running: boolean) => void;
  };
}

async function buildApp() {
  const ptyHub = makeFakePtyHub();
  const manager = new BoardManager(ptyHub);
  const app = Fastify({ logger: false });
  app.addHook("preHandler", async (req, reply) => {
    const pathOnly = req.url.split("?")[0] ?? req.url;
    if (!routeRequiresAuth(pathOnly)) return;
    if (!checkAuth(req, reply)) return reply;
  });
  await app.register(createOrchestraRoutes(manager), { prefix: "/api/v1/orchestra" });
  return { app, manager, ptyHub };
}

describe("orchestra routes", () => {
  beforeEach(() => {
    mockBoards.clear();
    delete process.env.PINODES_ORCHESTRA_TOKEN;
  });

  it("creates and lists boards", async () => {
    const { app } = await buildApp();

    const create = await app.inject({
      method: "POST",
      url: "/api/v1/orchestra/boards",
      payload: { cwd: "/tmp", label: "Repo" },
    });
    expect(create.statusCode).toBe(200);
    const body = JSON.parse(create.body);
    expect(body).toMatchObject({ cwd: "/tmp", label: "Repo" });

    const list = await app.inject({ method: "GET", url: "/api/v1/orchestra/boards" });
    expect(list.statusCode).toBe(200);
    const boards = JSON.parse(list.body).boards as Array<{
      boardId: string;
      cwd: string;
      label: string;
    }>;
    expect(boards).toHaveLength(1);
    expect(boards[0].boardId).toBe(body.boardId);
  });

  it("rejects board creation without cwd or invalid cwd", async () => {
    const { app } = await buildApp();
    const missing = await app.inject({
      method: "POST",
      url: "/api/v1/orchestra/boards",
      payload: { label: "x" },
    });
    expect(missing.statusCode).toBe(400);

    const invalid = await app.inject({
      method: "POST",
      url: "/api/v1/orchestra/boards",
      payload: { cwd: "/does/not/exist" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(JSON.parse(invalid.body).error).toContain("Not a valid directory");
  });

  it("loads and returns a graph", async () => {
    const { app, ptyHub } = await buildApp();
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/orchestra/boards",
      payload: { cwd: "/tmp" },
    });
    const boardId = JSON.parse(create.body).boardId;

    const put = await app.inject({
      method: "PUT",
      url: `/api/v1/orchestra/boards/${boardId}/graph`,
      payload: sampleGraph,
    });
    expect(put.statusCode).toBe(200);
    expect(JSON.parse(put.body).nodeIds).toEqual(["arch", "dev"]);
    expect(ptyHub.setGraph).toHaveBeenCalled();

    const get = await app.inject({
      method: "GET",
      url: `/api/v1/orchestra/boards/${boardId}/graph`,
    });
    expect(get.statusCode).toBe(200);
    const graph = JSON.parse(get.body) as WorkflowGraph;
    expect(graph.name).toBe("CI flow");
    expect(graph.nodes).toHaveLength(2);
  });

  it("returns 404 for graph on unknown board", async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/orchestra/boards/no-such/graph",
    });
    expect(res.statusCode).toBe(404);
  });

  it("runs a node and reports the target id", async () => {
    const { app, ptyHub } = await buildApp();
    const boardId = JSON.parse(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/orchestra/boards",
          payload: { cwd: "/tmp" },
        })
      ).body,
    ).boardId;

    await app.inject({
      method: "PUT",
      url: `/api/v1/orchestra/boards/${boardId}/graph`,
      payload: sampleGraph,
    });

    const run = await app.inject({
      method: "POST",
      url: `/api/v1/orchestra/boards/${boardId}/run`,
      payload: { message: "build feature" },
    });
    expect(run.statusCode).toBe(200);
    const body = JSON.parse(run.body);
    expect(body.nodeId).toBe("arch");
    expect(ptyHub.ensure).toHaveBeenCalledWith(boardId, "arch", 80, 24);
    expect(ptyHub.injectTask).toHaveBeenCalledWith(boardId, "arch", "build feature");
  });

  it("rejects run without a message", async () => {
    const { app } = await buildApp();
    const boardId = JSON.parse(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/orchestra/boards",
          payload: { cwd: "/tmp" },
        })
      ).body,
    ).boardId;
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/orchestra/boards/${boardId}/run`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("stops a board and reports killed count", async () => {
    const { app, ptyHub } = await buildApp();
    const boardId = JSON.parse(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/orchestra/boards",
          payload: { cwd: "/tmp" },
        })
      ).body,
    ).boardId;

    await app.inject({
      method: "PUT",
      url: `/api/v1/orchestra/boards/${boardId}/graph`,
      payload: sampleGraph,
    });
    ptyHub._setRunning(boardId, "arch", true);
    ptyHub._setRunning(boardId, "dev", true);

    const stop = await app.inject({
      method: "POST",
      url: `/api/v1/orchestra/boards/${boardId}/stop`,
    });
    expect(stop.statusCode).toBe(200);
    expect(JSON.parse(stop.body)).toEqual({ ok: true, killed: 2 });
    expect(ptyHub.killBoard).toHaveBeenCalledWith(boardId);
  });

  it("controls a single node (stop, inject, input)", async () => {
    const { app, ptyHub } = await buildApp();
    const boardId = JSON.parse(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/orchestra/boards",
          payload: { cwd: "/tmp" },
        })
      ).body,
    ).boardId;

    await app.inject({
      method: "PUT",
      url: `/api/v1/orchestra/boards/${boardId}/graph`,
      payload: sampleGraph,
    });

    const stop = await app.inject({
      method: "POST",
      url: `/api/v1/orchestra/boards/${boardId}/nodes/arch/stop`,
    });
    expect(stop.statusCode).toBe(200);
    expect(ptyHub.kill).toHaveBeenCalledWith(boardId, "arch");

    const inject = await app.inject({
      method: "POST",
      url: `/api/v1/orchestra/boards/${boardId}/nodes/arch/inject`,
      payload: { message: "task" },
    });
    expect(inject.statusCode).toBe(200);
    expect(ptyHub.injectTask).toHaveBeenCalledWith(boardId, "arch", "task");

    const input = await app.inject({
      method: "POST",
      url: `/api/v1/orchestra/boards/${boardId}/nodes/arch/input`,
      payload: { data: "hello\r" },
    });
    expect(input.statusCode).toBe(200);
    expect(ptyHub.input).toHaveBeenCalledWith(boardId, "arch", "hello\r");
  });

  it("returns board status", async () => {
    const { app, ptyHub } = await buildApp();
    const boardId = JSON.parse(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/orchestra/boards",
          payload: { cwd: "/tmp" },
        })
      ).body,
    ).boardId;

    await app.inject({
      method: "PUT",
      url: `/api/v1/orchestra/boards/${boardId}/graph`,
      payload: sampleGraph,
    });

    const status = await app.inject({
      method: "GET",
      url: `/api/v1/orchestra/boards/${boardId}/status`,
    });
    expect(status.statusCode).toBe(200);
    const body = JSON.parse(status.body);
    expect(body.boardId).toBe(boardId);
    expect(body.nodes).toHaveLength(2);
    expect(body.edges).toHaveLength(1);
  });

  it("runs a one-shot flow", async () => {
    const { app, ptyHub } = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/orchestra/flows",
      payload: {
        name: "Deploy",
        cwd: "/tmp",
        graph: sampleGraph,
        message: "deploy app",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("running");
    expect(body.nodeId).toBe("arch");
    expect(ptyHub.setGraph).toHaveBeenCalled();
    expect(ptyHub.injectTask).toHaveBeenCalled();
  });

  it("can wait for a flow entry node to exit", async () => {
    const { app, ptyHub } = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/orchestra/flows",
      payload: {
        name: "Deploy",
        cwd: "/tmp",
        graph: sampleGraph,
        message: "deploy app",
        wait: true,
        waitTimeoutMs: 5000,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("done");
    expect(body.timedOut).toBe(false);
    expect(ptyHub.waitForExit).toHaveBeenCalledWith(expect.any(String), "arch", 5000);
  });

  it("deletes the temporary flow board after a completed wait", async () => {
    const { app, manager } = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/orchestra/flows",
      payload: {
        name: "Deploy",
        cwd: "/tmp",
        graph: sampleGraph,
        message: "deploy app",
        wait: true,
      },
    });
    const body = JSON.parse(res.body);
    expect(body.timedOut).toBe(false);
    // Completed flow → board auto-cleaned up.
    expect(manager.get(body.boardId)).toBeUndefined();
  });

  it("keeps the flow board when the wait times out", async () => {
    const { app, manager, ptyHub } = await buildApp();
    ptyHub.waitForExit = vi.fn(() =>
      Promise.resolve({ code: null, timedOut: true }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/orchestra/flows",
      payload: {
        name: "Deploy",
        cwd: "/tmp",
        graph: sampleGraph,
        message: "deploy app",
        wait: true,
        waitTimeoutMs: 10,
      },
    });
    const body = JSON.parse(res.body);
    expect(body.timedOut).toBe(true);
    expect(body.status).toBe("running");
    // Timed-out flow is still live → board preserved for inspection.
    expect(manager.get(body.boardId)).toBeDefined();
  });

  // ── granular node/edge CRUD ────────────────────────────────────────────────

  async function boardWithGraph(app: Awaited<ReturnType<typeof buildApp>>["app"]) {
    const boardId = JSON.parse(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/orchestra/boards",
          payload: { cwd: "/tmp" },
        })
      ).body,
    ).boardId;
    await app.inject({
      method: "PUT",
      url: `/api/v1/orchestra/boards/${boardId}/graph`,
      payload: sampleGraph,
    });
    return boardId;
  }

  it("adds, updates and deletes a node", async () => {
    const { app } = await buildApp();
    const boardId = await boardWithGraph(app);

    const add = await app.inject({
      method: "POST",
      url: `/api/v1/orchestra/boards/${boardId}/nodes`,
      payload: { label: "Reviewer", promptId: "p3", position: { x: 200, y: 0 } },
    });
    expect(add.statusCode).toBe(200);
    const nodeId = JSON.parse(add.body).node.id as string;
    expect(nodeId).toBeTruthy();

    const patch = await app.inject({
      method: "PATCH",
      url: `/api/v1/orchestra/boards/${boardId}/nodes/${nodeId}`,
      payload: { label: "Critic" },
    });
    expect(patch.statusCode).toBe(200);
    expect(JSON.parse(patch.body).node.label).toBe("Critic");

    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/orchestra/boards/${boardId}/nodes/${nodeId}`,
    });
    expect(del.statusCode).toBe(200);
    expect(JSON.parse(del.body)).toEqual({ ok: true });
  });

  it("validates node creation and 404s unknown nodes", async () => {
    const { app } = await buildApp();
    const boardId = await boardWithGraph(app);

    const missing = await app.inject({
      method: "POST",
      url: `/api/v1/orchestra/boards/${boardId}/nodes`,
      payload: { promptId: "p", position: { x: 0, y: 0 } },
    });
    expect(missing.statusCode).toBe(400);

    const badPos = await app.inject({
      method: "POST",
      url: `/api/v1/orchestra/boards/${boardId}/nodes`,
      payload: { label: "X", promptId: "p" },
    });
    expect(badPos.statusCode).toBe(400);

    const patch404 = await app.inject({
      method: "PATCH",
      url: `/api/v1/orchestra/boards/${boardId}/nodes/ghost`,
      payload: { label: "X" },
    });
    expect(patch404.statusCode).toBe(404);

    const del404 = await app.inject({
      method: "DELETE",
      url: `/api/v1/orchestra/boards/${boardId}/nodes/ghost`,
    });
    expect(del404.statusCode).toBe(404);
  });

  it("adds and deletes an edge, rejecting invalid ones", async () => {
    const { app } = await buildApp();
    const boardId = await boardWithGraph(app);

    const add = await app.inject({
      method: "POST",
      url: `/api/v1/orchestra/boards/${boardId}/edges`,
      payload: { sourceNodeId: "dev", targetNodeId: "arch" },
    });
    expect(add.statusCode).toBe(200);
    const edgeId = JSON.parse(add.body).edge.id as string;

    const selfLoop = await app.inject({
      method: "POST",
      url: `/api/v1/orchestra/boards/${boardId}/edges`,
      payload: { sourceNodeId: "arch", targetNodeId: "arch" },
    });
    expect(selfLoop.statusCode).toBe(400);
    expect(JSON.parse(selfLoop.body).error).toContain("Self-loop");

    const dangling = await app.inject({
      method: "POST",
      url: `/api/v1/orchestra/boards/${boardId}/edges`,
      payload: { sourceNodeId: "arch", targetNodeId: "ghost" },
    });
    expect(dangling.statusCode).toBe(400);

    const missing = await app.inject({
      method: "POST",
      url: `/api/v1/orchestra/boards/${boardId}/edges`,
      payload: { sourceNodeId: "arch" },
    });
    expect(missing.statusCode).toBe(400);

    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/orchestra/boards/${boardId}/edges/${edgeId}`,
    });
    expect(del.statusCode).toBe(200);

    const del404 = await app.inject({
      method: "DELETE",
      url: `/api/v1/orchestra/boards/${boardId}/edges/ghost`,
    });
    expect(del404.statusCode).toBe(404);
  });

  it("validates required flow fields", async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/orchestra/flows",
      payload: { name: "x" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects requests without token when auth is enabled", async () => {
    process.env.PINODES_ORCHESTRA_TOKEN = "secret";
    const { app } = await buildApp();

    const noToken = await app.inject({
      method: "GET",
      url: "/api/v1/orchestra/boards",
    });
    expect(noToken.statusCode).toBe(401);

    const badToken = await app.inject({
      method: "GET",
      url: "/api/v1/orchestra/boards",
      headers: { "X-PiNodes-Orchestra-Token": "wrong" },
    });
    expect(badToken.statusCode).toBe(401);

    const ok = await app.inject({
      method: "GET",
      url: "/api/v1/orchestra/boards",
      headers: { "X-PiNodes-Orchestra-Token": "secret" },
    });
    expect(ok.statusCode).toBe(200);

    const bearer = await app.inject({
      method: "GET",
      url: "/api/v1/orchestra/boards",
      headers: { Authorization: "Bearer secret" },
    });
    expect(bearer.statusCode).toBe(200);
  });
});
