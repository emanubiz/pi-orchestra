import fs from "node:fs";
import path from "node:path";
import type { WebSocket } from "@fastify/websocket";
import { ptyHub } from "../pty/PtyHub.js";
import type { WorkflowGraph } from "../types.js";

const clients = new Set<WebSocket>();

function broadcast(msg: Record<string, unknown>): void {
  const payload = JSON.stringify(msg);
  for (const client of clients) {
    if (client.readyState === 1) client.send(payload);
  }
}

ptyHub.setBroadcast(broadcast);

function resolveCwd(cwd: unknown): string {
  const raw = typeof cwd === "string" && cwd.trim() ? cwd.trim() : process.cwd();
  return path.resolve(raw);
}

export function attachWebSocket(ws: WebSocket): void {
  clients.add(ws);

  ws.on("close", () => clients.delete(ws));

  ws.on("message", (raw: Buffer | string) => {
    try {
      const text = typeof raw === "string" ? raw : raw.toString();
      const msg = JSON.parse(text) as Record<string, unknown>;
      handleMessage(ws, msg);
    } catch (err) {
      ws.send(
        JSON.stringify({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  });

  ws.send(JSON.stringify({ type: "connected" }));
}

function handleMessage(ws: WebSocket, msg: Record<string, unknown>): void {
  const boardId = (msg.boardId as string) || "default";
  const nodeId = msg.nodeId as string;

  switch (msg.type) {
    case "load_graph": {
      const graph = msg.graph as WorkflowGraph;
      const cwd = resolveCwd(msg.cwd ?? graph.cwd);
      if (!fs.existsSync(cwd)) {
        ws.send(JSON.stringify({ type: "error", boardId, message: `Folder not found: ${cwd}` }));
        break;
      }
      ptyHub.setGraph(boardId, graph, cwd);
      // Sync any per-node determinism-watchdog overrides so the card toggles
      // reflect them after a (re)connect. Nodes not listed use the default (on).
      for (const o of ptyHub.enforcementOverrides(boardId)) {
        ws.send(JSON.stringify({ type: "enforcement", boardId, nodeId: o.nodeId, enabled: o.enabled }));
      }
      break;
    }

    case "attach_node": {
      const cols = (msg.cols as number) || 80;
      const rows = (msg.rows as number) || 24;
      const spawnIfMissing = msg.spawn !== false; // mini terminals still spawn pi
      // Read-only mirrors pass resize:false so they boot a node without claiming
      // authority over the shared PTY's dimensions (the interactive panel owns those).
      const allowResize = msg.resize !== false;
      const buffer = ptyHub.ensure(boardId, nodeId, cols, rows, spawnIfMissing, allowResize);
      // Replay scrollback only to the requesting client, tagged with the PTY's
      // real size so read-only mirrors can render/scale it faithfully.
      const size = ptyHub.size(boardId, nodeId);
      ws.send(
        JSON.stringify({
          type: "pty_output",
          boardId,
          nodeId,
          data: buffer,
          replay: true,
          cols: size?.cols,
          rows: size?.rows,
        }),
      );
      // If pi already booted before this client attached (e.g. reopening the
      // panel), tell it so its "starting pi…" overlay clears immediately instead
      // of waiting for a session_start that already happened.
      if (ptyHub.isReady(boardId, nodeId)) {
        ws.send(JSON.stringify({ type: "node_ready", boardId, nodeId }));
      }
      break;
    }

    case "pty_input": {
      ptyHub.input(boardId, nodeId, msg.data as string);
      break;
    }

    case "inject_task": {
      ptyHub.injectTask(boardId, nodeId, msg.message as string);
      break;
    }

    case "track_kanban": {
      ptyHub.setKanbanTracked(boardId);
      break;
    }

    case "set_enforcement": {
      ptyHub.setEnforcement(boardId, nodeId, msg.enabled !== false);
      break;
    }

    case "pty_resize": {
      ptyHub.resize(boardId, nodeId, msg.cols as number, msg.rows as number);
      break;
    }

    case "restart_node": {
      const cols = (msg.cols as number) || 80;
      const rows = (msg.rows as number) || 24;
      ptyHub.restart(boardId, nodeId, cols, rows);
      ws.send(JSON.stringify({ type: "pty_output", boardId, nodeId, data: "", replay: true }));
      break;
    }

    case "abort_node": {
      ptyHub.kill(boardId, nodeId);
      break;
    }

    case "stop_board": {
      ptyHub.killBoard(boardId);
      break;
    }

    default:
      ws.send(JSON.stringify({ type: "error", message: `Unknown type: ${msg.type}` }));
  }
}
