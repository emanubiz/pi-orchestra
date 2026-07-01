#!/usr/bin/env node

/**
 * pinodes-orchestra CLI — wraps the programmatic REST API.
 *
 * Usage:
 *   pinodes-orchestra <command> [args...]
 *
 * Environment:
 *   PINODES_ORCHESTRA_URL    Backend URL (default http://localhost:3847)
 *   PINODES_ORCHESTRA_TOKEN  Optional auth token
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ── Config ────────────────────────────────────────────────────────────────────

const BASE_URL = (
  process.env.PINODES_ORCHESTRA_URL ?? "http://localhost:3847"
).replace(/\/+$/, "");
const API = `${BASE_URL}/api/v1/orchestra`;
const TOKEN = process.env.PINODES_ORCHESTRA_TOKEN ?? null;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function api(path: string, opts?: RequestInit): Promise<unknown> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (TOKEN) headers["X-PiNodes-Orchestra-Token"] = TOKEN;
  const res = await fetch(`${API}${path}`, { ...opts, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err =
      (body as Record<string, unknown>)?.error ??
      `HTTP ${res.status} ${res.statusText}`;
    throw new Error(String(err));
  }
  return body;
}

function parseArgs(
  argv: string[],
): { pos: string[]; named: Record<string, string | boolean> } {
  const pos: string[] = [];
  const named: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      pos.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        named[key] = argv[i + 1];
        i++;
      } else {
        named[key] = true;
      }
    } else {
      pos.push(a);
    }
  }
  return { pos, named };
}

function jsonOrFile(raw: string): unknown {
  if (raw.endsWith(".json")) {
    return JSON.parse(readFileSync(resolve(raw), "utf-8"));
  }
  return JSON.parse(raw);
}

// ── Command handlers ──────────────────────────────────────────────────────────

async function cmdHealth(): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/health`);
  console.log(JSON.stringify(await res.json(), null, 2));
}

async function cmdInfo(): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/info`);
  console.log(JSON.stringify(await res.json(), null, 2));
}

// board subcommands
async function cmdBoardCreate(args: string[]): Promise<void> {
  const { pos, named } = parseArgs(args);
  const [cwd, label] = pos;
  if (!cwd) usage("board create <cwd> [label]");
  const body: Record<string, unknown> = { cwd };
  if (label) body.label = label;
  const result = await api("/boards", {
    method: "POST",
    body: JSON.stringify(body),
  });
  console.log(JSON.stringify(result, null, 2));
}

async function cmdBoardList(): Promise<void> {
  const result = await api("/boards");
  const data = result as { boards: unknown[] };
  if (!data.boards || data.boards.length === 0) {
    console.log("No boards.");
    return;
  }
  console.log(JSON.stringify(data.boards, null, 2));
}

async function cmdBoardDelete(args: string[]): Promise<void> {
  const [boardId] = args;
  if (!boardId) usage("board delete <boardId>");
  const result = await api(`/boards/${boardId}`, { method: "DELETE" });
  console.log(JSON.stringify(result, null, 2));
}

async function cmdBoardStatus(args: string[]): Promise<void> {
  const [boardId] = args;
  if (!boardId) usage("board status <boardId>");
  const result = await api(`/boards/${boardId}/status`);
  console.log(JSON.stringify(result, null, 2));
}

async function cmdBoardGraph(args: string[]): Promise<void> {
  const [boardId, graphFile] = args;
  if (!boardId) usage("board graph <boardId> [graphFile.json]");

  if (graphFile) {
    // Set graph from file or JSON string
    const graph = jsonOrFile(graphFile) as Record<string, unknown>;
    const result = await api(`/boards/${boardId}/graph`, {
      method: "PUT",
      body: JSON.stringify(graph),
    });
    console.log(JSON.stringify(result, null, 2));
  } else {
    // Get graph
    const result = await api(`/boards/${boardId}/graph`);
    console.log(JSON.stringify(result, null, 2));
  }
}

// node subcommands
async function cmdNodeAdd(args: string[]): Promise<void> {
  const { pos, named } = parseArgs(args);
  const [boardId, label, promptId] = pos;
  if (!boardId || !label || !promptId) usage("node add <boardId> <label> <promptId> [--x X] [--y Y] [--override O] [--canBeFinal true|false]");

  const x = Number(named.x ?? 0);
  const y = Number(named.y ?? 0);

  const body: Record<string, unknown> = {
    label,
    promptId,
    position: { x, y },
  };
  if (named.override) body.promptOverride = named.override;
  if (named.canBeFinal !== undefined) {
    body.canBeFinal = named.canBeFinal === "true" || named.canBeFinal === true;
  }

  const result = await api(`/boards/${boardId}/nodes`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  console.log(JSON.stringify(result, null, 2));
}

async function cmdNodeUpdate(args: string[]): Promise<void> {
  const { pos, named } = parseArgs(args);
  const [boardId, nodeId] = pos;
  if (!boardId || !nodeId) usage(
    "node update <boardId> <nodeId> [--label L] [--promptId P] [--override O] [--canBeFinal true|false] [--x X] [--y Y]",
  );

  const body: Record<string, unknown> = {};
  if (named.label) body.label = named.label;
  if (named.promptId) body.promptId = named.promptId;
  if (named.override !== undefined) body.promptOverride = named.override;
  if (named.canBeFinal !== undefined) {
    body.canBeFinal = named.canBeFinal === "true" || named.canBeFinal === true;
  }
  if (named.x !== undefined || named.y !== undefined) {
    body.position = {
      x: Number(named.x ?? 0),
      y: Number(named.y ?? 0),
    };
  }

  const result = await api(`/boards/${boardId}/nodes/${nodeId}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
  console.log(JSON.stringify(result, null, 2));
}

async function cmdNodeDelete(args: string[]): Promise<void> {
  const [boardId, nodeId] = args;
  if (!boardId || !nodeId) usage("node delete <boardId> <nodeId>");
  const result = await api(`/boards/${boardId}/nodes/${nodeId}`, {
    method: "DELETE",
  });
  console.log(JSON.stringify(result, null, 2));
}

async function cmdNodeStop(args: string[]): Promise<void> {
  const [boardId, nodeId] = args;
  if (!boardId || !nodeId) usage("node stop <boardId> <nodeId>");
  const result = await api(`/boards/${boardId}/nodes/${nodeId}/stop`, {
    method: "POST",
  });
  console.log(JSON.stringify(result, null, 2));
}

async function cmdNodeRestart(args: string[]): Promise<void> {
  const [boardId, nodeId] = args;
  if (!boardId || !nodeId) usage("node restart <boardId> <nodeId>");
  const result = await api(`/boards/${boardId}/nodes/${nodeId}/restart`, {
    method: "POST",
  });
  console.log(JSON.stringify(result, null, 2));
}

// edge subcommands
async function cmdEdgeAdd(args: string[]): Promise<void> {
  const [boardId, sourceNodeId, targetNodeId] = args;
  if (!boardId || !sourceNodeId || !targetNodeId)
    usage("edge add <boardId> <sourceNodeId> <targetNodeId>");
  const result = await api(`/boards/${boardId}/edges`, {
    method: "POST",
    body: JSON.stringify({ sourceNodeId, targetNodeId }),
  });
  console.log(JSON.stringify(result, null, 2));
}

async function cmdEdgeDelete(args: string[]): Promise<void> {
  const [boardId, edgeId] = args;
  if (!boardId || !edgeId) usage("edge delete <boardId> <edgeId>");
  const result = await api(`/boards/${boardId}/edges/${edgeId}`, {
    method: "DELETE",
  });
  console.log(JSON.stringify(result, null, 2));
}

async function cmdInject(args: string[]): Promise<void> {
  const [boardId, nodeId, ...rest] = args;
  const message = rest.join(" ");
  if (!boardId || !nodeId || !message)
    usage("inject <boardId> <nodeId> <message>");
  const result = await api(`/boards/${boardId}/nodes/${nodeId}/inject`, {
    method: "POST",
    body: JSON.stringify({ message }),
  });
  console.log(JSON.stringify(result, null, 2));
}

async function cmdRun(args: string[]): Promise<void> {
  const { pos, named } = parseArgs(args);
  const [boardId, ...rest] = pos;
  const message = rest.join(" ");
  if (!boardId || !message) usage("run <boardId> <message> [--nodeId NID]");
  const body: Record<string, unknown> = { message };
  if (named.nodeId) body.nodeId = named.nodeId;
  const result = await api(`/boards/${boardId}/run`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  console.log(JSON.stringify(result, null, 2));
}

async function cmdStop(args: string[]): Promise<void> {
  const [boardId] = args;
  if (!boardId) usage("stop <boardId>");
  const result = await api(`/boards/${boardId}/stop`, { method: "POST" });
  console.log(JSON.stringify(result, null, 2));
}

async function cmdFlow(args: string[]): Promise<void> {
  const { pos, named } = parseArgs(args);
  const [name, cwd, ...rest] = pos;
  if (!name || !cwd || rest.length < 2)
    usage("flow <name> <cwd> <graphFile.json> <message> [--wait] [--timeout MS]");

  const graphFile = rest[0];
  const message = rest.slice(1).join(" ");
  const graph = jsonOrFile(graphFile);

  const body: Record<string, unknown> = {
    name,
    cwd,
    graph,
    message,
    wait: named.wait === true || named.wait === "true",
  };
  if (named.timeout) body.waitTimeoutMs = Number(named.timeout);

  const result = await api("/flows", {
    method: "POST",
    body: JSON.stringify(body),
  });
  console.log(JSON.stringify(result, null, 2));
}

function cmdHelp(): void {
  console.log(`
pinodes-orchestra CLI — control PiNodes Orchestra from the terminal.

Usage:
  pinodes-orchestra <command> [args...]

Commands:

  General
    health                          Check backend health
    info                            Get server info
    help                            Show this help

  Boards
    board create <cwd> [label]      Create a new board
    board list                      List all boards
    board delete <boardId>          Delete a board
    board status <boardId>          Show board state (nodes + edges + statuses)
    board graph <boardId>           Show board graph JSON
    board graph <boardId> <file>    Load graph from JSON file

  Nodes (granular CRUD)
    node add <boardId> <label> <promptId>    Add a node
              [--x X] [--y Y]                Position (default 0 0)
              [--override O]                 Prompt override text
              [--canBeFinal true|false]      May end the chain (default true)
    node update <boardId> <nodeId>           Update node fields
              [--label L] [--promptId P]
              [--override O]
              [--canBeFinal true|false]
              [--x X] [--y Y]
    node delete <boardId> <nodeId>           Remove a node (kills PTY if running)
    node stop <boardId> <nodeId>             Stop a node's session
    node restart <boardId> <nodeId>          Kill and respawn a node's session

  Edges (granular CRUD)
    edge add <boardId> <src> <tgt>           Connect two nodes
    edge delete <boardId> <edgeId>           Remove a connection

  Execution
    run <boardId> <message>                  Start a flow (entry node by default)
              [--nodeId NID]                 Target node (default entryNodeId)
    inject <boardId> <nodeId> <message>      Send a task directly to a specific node
    stop <boardId>                           Stop all nodes on a board
    flow <name> <cwd> <file> <message>       One-shot: create board + load graph + run
              [--wait]                       Block until done
              [--timeout MS]                 Wait timeout (default 120000)

Environment:
  PINODES_ORCHESTRA_URL     Backend URL (default http://localhost:3847)
  PINODES_ORCHESTRA_TOKEN   Optional auth token
`);
}

function usage(msg: string): never {
  console.error(`pinodes-orchestra: ${msg}`);
  process.exit(1);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    cmdHelp();
    return;
  }

  const cmd = argv[0];
  const args = argv.slice(1);

  try {
    switch (cmd) {
      case "health":
        return await cmdHealth();
      case "info":
        return await cmdInfo();
      case "help":
      case "--help":
      case "-h":
        return cmdHelp();

      case "board":
      case "boards": {
        const sub = args[0];
        const subArgs = args.slice(1);
        switch (sub) {
          case "create":
            return await cmdBoardCreate(subArgs);
          case "list":
          case "ls":
            return await cmdBoardList();
          case "delete":
          case "rm":
            return await cmdBoardDelete(subArgs);
          case "status":
          case "st":
            return await cmdBoardStatus(subArgs);
          case "graph":
            return await cmdBoardGraph(subArgs);
          default:
            usage(`Unknown board subcommand: ${sub}`);
        }
      }

      case "node":
      case "nodes": {
        const sub = args[0];
        const subArgs = args.slice(1);
        switch (sub) {
          case "add":
            return await cmdNodeAdd(subArgs);
          case "update":
          case "upd":
            return await cmdNodeUpdate(subArgs);
          case "delete":
          case "rm":
            return await cmdNodeDelete(subArgs);
          case "stop":
            return await cmdNodeStop(subArgs);
          case "restart":
            return await cmdNodeRestart(subArgs);
          default:
            usage(`Unknown node subcommand: ${sub}`);
        }
      }

      case "edge":
      case "edges": {
        const sub = args[0];
        const subArgs = args.slice(1);
        switch (sub) {
          case "add":
            return await cmdEdgeAdd(subArgs);
          case "delete":
          case "rm":
            return await cmdEdgeDelete(subArgs);
          default:
            usage(`Unknown edge subcommand: ${sub}`);
        }
      }

      case "run":
        return await cmdRun(args);
      case "inject":
        return await cmdInject(args);
      case "stop":
        return await cmdStop(args);
      case "flow":
        return await cmdFlow(args);

      default:
        console.error(`pinodes-orchestra: Unknown command "${cmd}"`);
        cmdHelp();
        process.exit(1);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`pinodes-orchestra: error — ${msg}`);
    process.exit(1);
  }
}

main();
