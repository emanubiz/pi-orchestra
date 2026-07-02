import type { FastifyInstance } from "fastify";
import { BoardManager } from "../orchestra/BoardManager.js";
import { ptyHub } from "../pty/PtyHub.js";
import type { NodeRuntime, WorkflowEdge, WorkflowGraph, WorkflowNode } from "../types.js";

const VALID_RUNTIMES: ReadonlySet<string> = new Set(["pi", "hermes", "claude"]);

/** Clamp `waitTimeoutMs` to something sane: a non-number/NaN falls back to the
 *  default, and the value is bounded so a typo can neither make the wait
 *  fire instantly (0/negative) nor pin the HTTP request open for days. */
const WAIT_TIMEOUT_DEFAULT_MS = 120_000;
const WAIT_TIMEOUT_MIN_MS = 1_000;
const WAIT_TIMEOUT_MAX_MS = 3_600_000; // 1h
function clampWaitTimeout(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : WAIT_TIMEOUT_DEFAULT_MS;
  return Math.min(WAIT_TIMEOUT_MAX_MS, Math.max(WAIT_TIMEOUT_MIN_MS, n));
}

/** Runtime-level validation for the node fields whose TypeScript types don't
 *  survive the wire. Returns an error string (→ 400) or null when valid.
 *  `partial` relaxes required-field checks for PATCH bodies. */
function validateNodeFields(
  body: Record<string, unknown>,
  partial: boolean,
): string | null {
  const { label, promptId, promptOverride, canBeFinal, runtime, runtimeConfig, position } = body;
  if (label !== undefined || !partial) {
    if (!label || typeof label !== "string") return "label is required";
  }
  if (promptId !== undefined || !partial) {
    if (!promptId || typeof promptId !== "string") return "promptId is required";
  }
  if (position !== undefined || !partial) {
    const p = position as { x?: unknown; y?: unknown } | undefined;
    if (!p || typeof p.x !== "number" || typeof p.y !== "number") {
      return "position { x, y } is required";
    }
  }
  if (promptOverride !== undefined && promptOverride !== null && typeof promptOverride !== "string") {
    return "promptOverride must be a string or null";
  }
  if (canBeFinal !== undefined && canBeFinal !== null && typeof canBeFinal !== "boolean") {
    return "canBeFinal must be a boolean";
  }
  if (runtime !== undefined && !VALID_RUNTIMES.has(runtime as string)) {
    return `runtime must be one of: ${[...VALID_RUNTIMES].join(", ")}`;
  }
  if (
    runtimeConfig !== undefined &&
    (typeof runtimeConfig !== "object" || runtimeConfig === null || Array.isArray(runtimeConfig))
  ) {
    return "runtimeConfig must be an object";
  }
  return null;
}

export function createOrchestraRoutes(boardManager: BoardManager) {
  return async function orchestraRoutes(app: FastifyInstance): Promise<void> {
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
    }>("/boards/:boardId/nodes/:nodeId/restart", async (req, reply) => {
      try {
        boardManager.restartNode(req.params.boardId, req.params.nodeId);
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
        runtime?: NodeRuntime;
        runtimeConfig?: Record<string, unknown>;
        position: { x: number; y: number };
      };
    }>("/boards/:boardId/nodes", async (req, reply) => {
      const { id, label, promptId, promptOverride, canBeFinal, runtime, runtimeConfig, position } =
        req.body;
      const invalid = validateNodeFields(req.body as Record<string, unknown>, false);
      if (invalid) return reply.code(400).send({ error: invalid });
      try {
        const node = boardManager.addNode(req.params.boardId, {
          id,
          label,
          promptId,
          promptOverride: promptOverride ?? null,
          canBeFinal: canBeFinal ?? null,
          ...(runtime !== undefined ? { runtime } : {}),
          ...(runtimeConfig !== undefined ? { runtimeConfig } : {}),
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
        runtime: NodeRuntime;
        runtimeConfig: Record<string, unknown>;
        position: { x: number; y: number };
      }>;
    }>("/boards/:boardId/nodes/:nodeId", async (req, reply) => {
      const invalid = validateNodeFields(req.body as Record<string, unknown>, true);
      if (invalid) return reply.code(400).send({ error: invalid });
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

      // A run failure (e.g. no entryNodeId and none provided) must clean up the
      // board this request created — otherwise every bad /flows call leaks a
      // persisted temporary board.
      let nodeId: string;
      try {
        ({ nodeId } = boardManager.run(
          board.boardId,
          loadedGraph.entryNodeId ?? undefined,
          message,
        ));
      } catch (err) {
        boardManager.delete(board.boardId);
        return reply
          .code(400)
          .send({ error: err instanceof Error ? err.message : String(err) });
      }

      if (req.body.wait) {
        const result = await boardManager.waitForExit(
          board.boardId,
          nodeId,
          clampWaitTimeout(req.body.waitTimeoutMs),
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
