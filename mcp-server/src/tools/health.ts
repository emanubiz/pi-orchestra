import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OrchestraMcpConfig } from "../config.js";
import { orchestraRequest } from "../http.js";
import { textResult } from "./common.js";

export function registerHealthTools(server: McpServer, config: OrchestraMcpConfig): void {
  server.registerTool(
    "orchestra_health",
    {
      title: "Check Pinodes Orchestra health",
      description: "Call GET /api/health on the configured pinodes-orchestra backend.",
      inputSchema: {},
    },
    async () => textResult(await orchestraRequest(config, "/api/health")),
  );

  server.registerTool(
    "orchestra_info",
    {
      title: "Get Pinodes Orchestra info",
      description: "Call GET /api/info on the configured pinodes-orchestra backend.",
      inputSchema: {},
    },
    async () => textResult(await orchestraRequest(config, "/api/info")),
  );
}
