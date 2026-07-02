#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { registerBoardTools } from "./tools/boards.js";
import { registerGraphTools } from "./tools/graph.js";
import { registerHealthTools } from "./tools/health.js";
import { registerInjectTools } from "./tools/inject.js";
import { registerOpenUiTools } from "./tools/open-ui.js";
import { registerRunTools } from "./tools/run.js";
import { registerStatusTools } from "./tools/status.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let MCP_VERSION = "0.3.0";
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "../package.json"), "utf8"));
  MCP_VERSION = pkg.version || MCP_VERSION;
} catch {
  // Keep fallback.
}

const config = loadConfig();
const server = new McpServer({
  name: "pinodes-orchestra-mcp",
  version: MCP_VERSION,
});

registerHealthTools(server, config);
registerBoardTools(server, config);
registerGraphTools(server, config);
registerRunTools(server, config);
registerStatusTools(server, config);
registerInjectTools(server, config);
registerOpenUiTools(server, config);

const transport = new StdioServerTransport();
await server.connect(transport);
