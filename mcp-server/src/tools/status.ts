import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OrchestraMcpConfig } from "../config.js";
import { orchestraRequest } from "../http.js";
import { boardIdSchema } from "../schemas.js";
import { textResult } from "./common.js";

export function registerStatusTools(server: McpServer, config: OrchestraMcpConfig): void {
  server.registerTool(
    "orchestra_get_status",
    {
      title: "Get Pinodes Orchestra board status",
      description: "Fetch current node statuses and edges for a board.",
      inputSchema: boardIdSchema.shape,
    },
    async (input) => {
      const { boardId } = boardIdSchema.parse(input);
      return textResult(await orchestraRequest(config, `/api/v1/orchestra/boards/${boardId}/status`));
    },
  );
}
