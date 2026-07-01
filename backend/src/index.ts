import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPrompt,
  deletePrompt,
  deleteWorkflow,
  getWorkflow,
  listPrompts,
  listWorkflows,
  saveWorkflow,
  updatePrompt,
} from "./db/index.js";
import { ptyHub } from "./pty/PtyHub.js";
import { isHermesRuntimeAvailable } from "./pty/runtime/hermesAvailability.js";
import { orchestraRoutes } from "./routes/orchestra.js";

import type { WorkflowGraph } from "./types.js";
import {
  buildAllowedOrigins,
  checkAuth,
  routeRequiresAuth,
  validateWebSocketHandshake,
} from "./utils/security.js";
import { attachWebSocket } from "./ws/handler.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const PORT = Number(process.env.PORT ?? 3847);
const HOST = process.env.PINODES_ORCHESTRA_HOST ?? "127.0.0.1";
const ALLOWED_ORIGINS = buildAllowedOrigins(PORT);

// When launched by a host (e.g. the VS Code extension) that sets its own PID
// here, watch it: if that parent process disappears, exit so we never linger
// as an orphan holding the port. Standalone runs don't set this and are unaffected.
const PARENT_PID = Number(process.env.PINODES_ORCHESTRA_PARENT_PID ?? 0);
if (PARENT_PID > 0) {
  setInterval(() => {
    try {
      process.kill(PARENT_PID, 0); // signal 0 = liveness probe, doesn't kill
    } catch {
      process.exit(0); // parent gone
    }
  }, 2000).unref();
}

const app = Fastify({ logger: true });

await app.register(cors, {
  origin: (origin, cb) => {
    // No Origin = same-origin navigation or non-browser tools.
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.has(origin)) return cb(null, true);
    cb(null, false);
  },
});
await app.register(websocket);

app.addHook("preHandler", async (req, reply) => {
  const pathOnly = req.url.split("?")[0] ?? req.url;
  if (!routeRequiresAuth(pathOnly)) return;
  if (!checkAuth(req, reply)) return reply;
});

app.get("/api/health", async () => ({
  ok: true,
  name: "pinodes-orchestra",
  version: "0.1.0",
  port: PORT,
  runtimes: {
    hermes: isHermesRuntimeAvailable(),
  },
}));

/** Server info for clients that need a sensible default cwd (browser has no process.cwd). */
app.get("/api/info", async () => ({
  ok: true,
  name: "pinodes-orchestra",
  version: "0.1.0",
  port: PORT,
  defaultCwd: process.cwd(),
  wsPath: "/ws",
  runtimes: {
    hermes: isHermesRuntimeAvailable(),
  },
}));

// Called by the call_agent extension running inside a node's pi terminal.
app.post<{
  Body: {
    boardId: string;
    fromNodeId: string;
    targetNodeId: string;
    message: string;
    taskId?: string;
  };
}>("/internal/call-agent", async (req) => {
  const { boardId, fromNodeId, targetNodeId, message, taskId } = req.body;
  return ptyHub.deliverCall(boardId, fromNodeId, targetNodeId, message, taskId);
});

// Called by the extension when an agent advances the linked Kanban card.
app.post<{ Body: { boardId: string; column: string } }>(
  "/internal/card-status",
  async (req) => {
    const { boardId, column } = req.body;
    ptyHub.notify({ type: "card_status", boardId, column });
    return { ok: true };
  },
);

// Per-turn orchestration context, pulled by the extension's before_agent_start
// to refresh the system-prompt appendix (recipients, finality, kanban) and to
// give the determinism watchdog its source of truth for valid handoff targets.
app.get<{ Querystring: { boardId?: string; nodeId?: string } }>(
  "/internal/orchestra-context",
  async (req, reply) => {
    const { boardId, nodeId } = req.query;
    if (!boardId || !nodeId) {
      return reply.code(400).send({ error: "boardId and nodeId are required" });
    }
    const ctx = ptyHub.orchestraContext(boardId, nodeId);
    if (!ctx) return reply.code(404).send({ error: "Unknown board or node" });
    return { boardId, nodeId, ...ctx };
  },
);

// Ready marker: the extension's session_start fires this so queued injects flush
// immediately instead of waiting on a guessed timer.
app.post<{ Body: { boardId: string; nodeId: string } }>(
  "/internal/ready",
  async (req) => {
    const { boardId, nodeId } = req.body;
    ptyHub.markReady(boardId, nodeId);
    return { ok: true };
  },
);

// Closed-loop submit confirmation (plan B): the agent began a turn, which
// proves an injected task's paste+submit actually reached the model. Both
// runtimes POST this once per turn (pi: before_agent_start; Hermes: pre_llm_call
// — the plugin guards against double-signalling within a turn). PtyHub disarms
// the submit watch and marks the node busy so a mid-turn inject parks its watch.
app.post<{ Body: { boardId: string; nodeId: string } }>(
  "/internal/turn-started",
  async (req) => {
    const { boardId, nodeId } = req.body;
    return ptyHub.handleTurnStarted(boardId, nodeId);
  },
);

// Hermes post_llm_call hook: the agent finished a turn. Delegates to PtyHub,
// which owns the retry state and nudge/error logic (see handleTurnEnded) —
// this is the Hermes equivalent of pi's client-side explicit-intent watchdog.
app.post<{
  Body: { boardId: string; nodeId: string; handoffCalledThisTurn: boolean };
}>("/internal/turn-ended", async (req) => {
  const { boardId, nodeId, handoffCalledThisTurn } = req.body;
  return ptyHub.handleTurnEnded(boardId, nodeId, handoffCalledThisTurn);
});

// The determinism watchdog gave up after retries — surface it on the node card.
app.post<{
  Body: { boardId: string; nodeId: string; reason: string; recipients?: string };
}>("/internal/handoff-failed", async (req) => {
  const { boardId, nodeId, reason, recipients } = req.body;
  ptyHub.notify({
    type: "node_status",
    boardId,
    nodeId,
    status: "error",
    message:
      `Handoff not completed after retries (${reason}). ` +
      `Expected recipient(s): ${recipients ?? "(none connected)"}.`,
  });
  return { ok: true };
});

app.post<{ Body: { path: string } }>("/api/validate-path", async (req, reply) => {
  const resolved = path.resolve(req.body.path);
  if (!fs.existsSync(resolved)) {
    return reply.code(404).send({ ok: false, path: resolved, error: "Path not found" });
  }
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    return reply.code(400).send({ ok: false, path: resolved, error: "Not a directory" });
  }
  return { ok: true, path: resolved };
});

app.get("/api/prompts", async () => listPrompts());

app.post<{ Body: { name: string; content: string } }>(
  "/api/prompts",
  async (req) => {
    const id = crypto.randomUUID();
    return createPrompt(id, req.body.name, req.body.content);
  },
);

app.put<{ Params: { id: string }; Body: { name: string; content: string } }>(
  "/api/prompts/:id",
  async (req, reply) => {
    const row = updatePrompt(req.params.id, req.body.name, req.body.content);
    if (!row) return reply.code(404).send({ error: "Not found" });
    return row;
  },
);

app.delete<{ Params: { id: string } }>("/api/prompts/:id", async (req, reply) => {
  if (!deletePrompt(req.params.id)) return reply.code(400).send({ error: "Cannot delete" });
  return { ok: true };
});

app.get("/api/workflows", async () => listWorkflows());

app.get<{ Params: { id: string } }>("/api/workflows/:id", async (req, reply) => {
  const wf = getWorkflow(req.params.id);
  if (!wf) return reply.code(404).send({ error: "Not found" });
  return wf;
});

app.post<{ Body: WorkflowGraph }>("/api/workflows", async (req) => saveWorkflow(req.body));

app.delete<{ Params: { id: string } }>("/api/workflows/:id", async (req, reply) => {
  if (!deleteWorkflow(req.params.id)) return reply.code(404).send({ error: "Not found" });
  return { ok: true };
});

// Programmatic orchestration API for host integrations (VSCode, Hermes, OpenClaw, CI).
await app.register(orchestraRoutes, { prefix: "/api/v1/orchestra" });

app.register(async (f) => {
  f.get("/ws", { websocket: true }, (socket, req) => {
    const handshake = validateWebSocketHandshake(req, ALLOWED_ORIGINS);
    if (!handshake.ok) {
      socket.close(handshake.code, handshake.reason);
      return;
    }
    attachWebSocket(socket);
  });
});

const frontendDist = path.join(ROOT, "frontend", "dist");
try {
  await app.register(fastifyStatic, { root: frontendDist, prefix: "/" });
  app.setNotFoundHandler((_req, reply) => {
    reply.sendFile("index.html", frontendDist);
  });
} catch {
  // frontend not built yet
}

try {
  await app.listen({ port: PORT, host: HOST });
} catch (err) {
  console.error(
    `pinodes-orchestra: failed to start on ${HOST}:${PORT} — ${err instanceof Error ? err.message : String(err)}`,
  );
  console.error(
    "Is another process using the port? Try: lsof -i :" + PORT + " or set PORT=… in env.",
  );
  process.exit(1);
}
const listenLabel = HOST === "0.0.0.0" ? "localhost" : HOST;
console.log(`pinodes-orchestra backend http://${listenLabel}:${PORT}`);
