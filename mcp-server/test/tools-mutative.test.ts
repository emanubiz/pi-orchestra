import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { registerBoardTools } from "../src/tools/boards.js";
import { registerGraphTools } from "../src/tools/graph.js";
import { registerInjectTools } from "../src/tools/inject.js";
import { registerRunTools } from "../src/tools/run.js";

const ORIGINAL_ENV = process.env;

type ToolCallback = (input: unknown) => Promise<unknown>;

function createToolRegistry() {
  const callbacks = new Map<string, ToolCallback>();
  const server = {
    registerTool(name: string, _config: unknown, callback: ToolCallback) {
      callbacks.set(name, callback);
    },
  } as unknown as McpServer;
  return { server, callbacks };
}

function parseAudit(auditPath: string) {
  return fs
    .readFileSync(auditPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

describe("mutative MCP tools", () => {
  let auditPath: string;

  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pinodes-tools-"));
    auditPath = path.join(dir, "audit.jsonl");
    process.env = { ...ORIGINAL_ENV, PINODES_ORCHESTRA_MCP_AUDIT_LOG: auditPath };
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.restoreAllMocks();
  });

  it("creates boards with allowed cwd, expected REST body, and audit", async () => {
    const { server, callbacks } = createToolRegistry();
    const config = loadConfig({ PINODES_ORCHESTRA_ALLOWED_ROOTS: "/workspace" });
    registerBoardTools(server, config);

    await callbacks.get("orchestra_create_board")?.({ cwd: "/workspace/repo", label: "Demo" });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3847/api/v1/orchestra/boards",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ cwd: "/workspace/repo", label: "Demo" }) }),
    );
    expect(parseAudit(auditPath)[0]).toMatchObject({
      tool: "orchestra_create_board",
      input: { cwd: "/workspace/repo", label: "Demo" },
    });
  });

  it("loads graphs through the expected route and validates graph cwd", async () => {
    const { server, callbacks } = createToolRegistry();
    const config = loadConfig({ PINODES_ORCHESTRA_ALLOWED_ROOTS: "/workspace" });
    registerGraphTools(server, config);
    const graph = {
      name: "Demo",
      cwd: "/workspace/repo",
      nodes: [{ id: "n1", label: "Node", promptId: "p1", position: { x: 1, y: 2 } }],
      edges: [],
    };

    await callbacks.get("orchestra_put_graph")?.({ boardId: "b1", graph });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3847/api/v1/orchestra/boards/b1/graph",
      expect.objectContaining({ method: "PUT", body: JSON.stringify(graph) }),
    );
    expect(parseAudit(auditPath)[0]).toMatchObject({ tool: "orchestra_put_graph", input: { boardId: "b1" } });
    await expect(callbacks.get("orchestra_put_graph")?.({ boardId: "b1", graph: { ...graph, cwd: "/etc" } })).rejects.toThrow(
      /outside PINODES_ORCHESTRA_ALLOWED_ROOTS/,
    );
  });

  it("runs, injects, and stops boards through P0 REST endpoints", async () => {
    const { server, callbacks } = createToolRegistry();
    const config = loadConfig({});
    registerRunTools(server, config);
    registerInjectTools(server, config);

    await callbacks.get("orchestra_run_board")?.({ boardId: "b1", message: "start", nodeId: "n1" });
    await callbacks.get("orchestra_inject_node")?.({ boardId: "b1", nodeId: "n2", message: "continue" });
    await callbacks.get("orchestra_stop_board")?.({ boardId: "b1" });

    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:3847/api/v1/orchestra/boards/b1/run",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ message: "start", nodeId: "n1" }) }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:3847/api/v1/orchestra/boards/b1/nodes/n2/inject",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ message: "continue" }) }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      3,
      "http://127.0.0.1:3847/api/v1/orchestra/boards/b1/stop",
      expect.objectContaining({ method: "POST" }),
    );
    expect(parseAudit(auditPath).map((entry) => entry.tool)).toEqual([
      "orchestra_run_board",
      "orchestra_inject_node",
      "orchestra_stop_board",
    ]);
  });
});
