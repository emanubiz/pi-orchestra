import type { FastifyInstance } from "fastify";
import { BoardManager } from "../orchestra/BoardManager.js";
import { ptyHub } from "../pty/PtyHub.js";
import type { WorkflowEdge, WorkflowGraph, WorkflowNode } from "../types.js";

function checkAuth(req: { headers: Record<string, string | string[] | undefined> }, reply: {
  code: (code: number) => { send: (payload: unknown) => void };
}): boolean {
  const token = process.env.PINODES_ORCHESTRA_TOKEN;
  if (!token) return true;
  const header = req.headers["x-pinodes-orchestra-token"];
  const auth = req.headers.authorization;
  const bearer = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : undefined;
  const provided = typeof header === "string" ? header : bearer;
  if (provided !== token) {
    reply.code(401).send({ error: "Unauthorized" });
    return false;
  }
  return true;
}

export function createOrchestraRoutes(boardManager: BoardManager) {
  return async function orchestraRoutes(app: FastifyInstance): Promise<void> {
    app.addHook("preHandler", async (req, reply) => {
      if (!checkAuth(req, reply)) {
        return reply;
      }
    });

    app.post<{ Body: { cwd: string; label?: string } }>(
      "/boards",
      async (req, reply) => {
        const cwd = req.body.cwd;
        if (!cwd || typeof cwd !== "string") {
          return reply.code(400).send({ error: "cwd is required" });
        }
        try {
          const board = boardManager.create(cwd, req.body.label);
          return { boardId: board.boardId, cwd: board.cwd, label: board.label };
        } catch (err) {
          return reply
            .code(400)
            .send({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    );

    app.get("/boards", async () => ({ boards: boardManager.list() }));

    app.delete<{ Params: { boardId: string } }>(
      "/boards/:boardId",
      async (req, reply) => {
        const ok = boardManager.delete(req.params.boardId);
        if (!ok) return reply.code(404).send({ error: "Board not found" });
        return { ok: true };
      },
    );

    app.put<{ Params: { boardId: string }; Body: WorkflowGraph }>(
      "/boards/:boardId/graph",
      async (req, reply) => {
        const board = boardManager.get(req.params.boardId);
        if (!board) return reply.code(404).send({ error: "Board not found" });
        try {
          boardManager.setGraph(req.params.boardId, req.body);
          return {
            ok: true,
            nodeIds: req.body.nodes.map((n) => n.id),
          };
        } catch (err) {
          return reply
            .code(400)
            .send({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    );

    app.get<{ Params: { boardId: string } }>(
      "/boards/:boardId/graph",
      async (req, reply) => {
        const graph = boardManager.getGraph(req.params.boardId);
        if (!graph) return reply.code(404).send({ error: "Graph not found" });
        return graph;
      },
    );

    app.post<{
      Params: { boardId: string };
      Body: { nodeId?: string; message: string };
    }>("/boards/:boardId/run", async (req, reply) => {
      const board = boardManager.get(req.params.boardId);
      if (!board) return reply.code(404).send({ error: "Board not found" });
      const message = req.body.message;
      if (!message || typeof message !== "string") {
        return reply.code(400).send({ error: "message is required" });
      }
      try {
        const { nodeId } = boardManager.run(
          req.params.boardId,
          req.body.nodeId,
          message,
        );
        return { ok: true, boardId: req.params.boardId, nodeId };
      } catch (err) {
        return reply
          .code(400)
          .send({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    app.post<{ Params: { boardId: string } }>(
      "/boards/:boardId/stop",
      async (req, reply) => {
        const result = boardManager.stop(req.params.boardId);
        if (!result.ok) return reply.code(404).send({ error: "Board not found" });
        return { ok: true, killed: result.killed };
      },
    );

    app.get<{ Params: { boardId: string } }>(
      "/boards/:boardId/status",
      async (req, reply) => {
        try {
          return boardManager.status(req.params.boardId);
        } catch (err) {
          return reply
            .code(404)
            .send({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    );

    app.post<{
      Params: { boardId: string; nodeId: string };
    }>("/boards/:boardId/nodes/:nodeId/stop", async (req, reply) => {
      try {
        boardManager.stopNode(req.params.boardId, req.params.nodeId);
        return { ok: true };
      } catch (err) {
        return reply
          .code(400)
          .send({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    app.post<{
      Params: { boardId: string; nodeId: string };
      Body: { message: string };
    }>("/boards/:boardId/nodes/:nodeId/inject", async (req, reply) => {
      const message = req.body.message;
      if (!message || typeof message !== "string") {
        return reply.code(400).send({ error: "message is required" });
      }
      try {
        boardManager.injectNode(req.params.boardId, req.params.nodeId, message);
        return { ok: true };
      } catch (err) {
        return reply
          .code(400)
          .send({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    app.post<{
      Params: { boardId: string; nodeId: string };
      Body: { data: string };
    }>("/boards/:boardId/nodes/:nodeId/input", async (req, reply) => {
      const data = req.body.data;
      if (typeof data !== "string") {
        return reply.code(400).send({ error: "data is required" });
      }
      try {
        boardManager.inputNode(req.params.boardId, req.params.nodeId, data);
        return { ok: true };
      } catch (err) {
        return reply
          .code(400)
          .send({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // ── Granular CRUD: nodes ────────────────────────────────────────────────

    app.post<{
      Params: { boardId: string };
      Body: {
        id?: string;
        label: string;
        promptId: string;
        promptOverride?: string | null;
        canBeFinal?: boolean | null;
        position: { x: number; y: number };
      };
    }>("/boards/:boardId/nodes", async (req, reply) => {
      const { id, label, promptId, promptOverride, canBeFinal, position } = req.body;
      if (!label || typeof label !== "string") {
        return reply.code(400).send({ error: "label is required" });
      }
      if (!promptId || typeof promptId !== "string") {
        return reply.code(400).send({ error: "promptId is required" });
      }
      if (!position || typeof position.x !== "number" || typeof position.y !== "number") {
        return reply.code(400).send({ error: "position { x, y } is required" });
      }
      try {
        const node = boardManager.addNode(req.params.boardId, {
          id,
          label,
          promptId,
          promptOverride: promptOverride ?? null,
          canBeFinal: canBeFinal ?? null,
          position,
        });
        return { ok: true, node };
      } catch (err) {
        return reply
          .code(400)
          .send({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    app.patch<{
      Params: { boardId: string; nodeId: string };
      Body: Partial<{
        label: string;
        promptId: string;
        promptOverride: string | null;
        canBeFinal: boolean;
        position: { x: number; y: number };
      }>;
    }>("/boards/:boardId/nodes/:nodeId", async (req, reply) => {
      try {
        const node = boardManager.updateNode(
          req.params.boardId,
          req.params.nodeId,
          req.body,
        );
        return { ok: true, node };
      } catch (err) {
        return reply
          .code(err instanceof Error && err.message.startsWith("Node not found")
            ? 404
            : 400)
          .send({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    app.delete<{ Params: { boardId: string; nodeId: string } }>(
      "/boards/:boardId/nodes/:nodeId",
      async (req, reply) => {
        try {
          const ok = boardManager.deleteNode(req.params.boardId, req.params.nodeId);
          if (!ok) return reply.code(404).send({ error: "Node not found" });
          return { ok: true };
        } catch (err) {
          return reply
            .code(404)
            .send({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    );

    // ── Granular CRUD: edges ────────────────────────────────────────────────

    app.post<{
      Params: { boardId: string };
      Body: { id?: string; sourceNodeId: string; targetNodeId: string };
    }>("/boards/:boardId/edges", async (req, reply) => {
      const { id, sourceNodeId, targetNodeId } = req.body;
      if (!sourceNodeId || typeof sourceNodeId !== "string") {
        return reply.code(400).send({ error: "sourceNodeId is required" });
      }
      if (!targetNodeId || typeof targetNodeId !== "string") {
        return reply.code(400).send({ error: "targetNodeId is required" });
      }
      try {
        const edge = boardManager.addEdge(req.params.boardId, {
          id,
          sourceNodeId,
          targetNodeId,
        });
        return { ok: true, edge };
      } catch (err) {
        return reply
          .code(400)
          .send({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    app.delete<{ Params: { boardId: string; edgeId: string } }>(
      "/boards/:boardId/edges/:edgeId",
      async (req, reply) => {
        const ok = boardManager.deleteEdge(req.params.boardId, req.params.edgeId);
        if (!ok) return reply.code(404).send({ error: "Edge not found" });
        return { ok: true };
      },
    );

    app.post<{
      Body: {
        name: string;
        cwd: string;
        entryNodeId?: string;
        graph: WorkflowGraph;
        message: string;
        wait?: boolean;
        waitTimeoutMs?: number;
      };
    }>("/flows", async (req, reply) => {
      const { name, cwd, graph, message } = req.body;
      if (!name || typeof name !== "string") {
        return reply.code(400).send({ error: "name is required" });
      }
      if (!cwd || typeof cwd !== "string") {
        return reply.code(400).send({ error: "cwd is required" });
      }
      if (!graph || typeof graph !== "object" || !graph.nodes) {
        return reply.code(400).send({ error: "graph is required" });
      }
      if (!message || typeof message !== "string") {
        return reply.code(400).send({ error: "message is required" });
      }

      let board;
      try {
        board = boardManager.create(cwd, name);
      } catch (err) {
        return reply
          .code(400)
          .send({ error: err instanceof Error ? err.message : String(err) });
      }

      const loadedGraph: WorkflowGraph = {
        ...graph,
        name,
        cwd,
        entryNodeId: req.body.entryNodeId ?? graph.entryNodeId,
      };
      try {
        boardManager.setGraph(board.boardId, loadedGraph);
      } catch (err) {
        boardManager.delete(board.boardId);
        return reply
          .code(400)
          .send({ error: err instanceof Error ? err.message : String(err) });
      }

      const { nodeId } = boardManager.run(
        board.boardId,
        loadedGraph.entryNodeId ?? undefined,
        message,
      );

      if (req.body.wait) {
        const result = await boardManager.waitForExit(
          board.boardId,
          nodeId,
          req.body.waitTimeoutMs ?? 120_000,
        );

        // Flow completed → auto-cleanup the temporary board.
        // On timeout the flow is still running and the caller may want to
        // poll status or interact with the board (it outlives the request).
        if (!result.timedOut) {
          boardManager.delete(board.boardId);
        }

        return {
          ok: true,
          boardId: board.boardId,
          flowId: board.boardId,
          status: result.timedOut ? "running" : "done",
          nodeId,
          timedOut: result.timedOut,
        };
      }

      return {
        ok: true,
        boardId: board.boardId,
        flowId: board.boardId,
        status: "running",
        nodeId,
      };
    });
  };
}

const defaultBoardManager = new BoardManager(ptyHub);
export const orchestraRoutes = createOrchestraRoutes(defaultBoardManager);
