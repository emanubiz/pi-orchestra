import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { auditToolCall } from "../audit.js";
import type { OrchestraMcpConfig } from "../config.js";
import { assertPathAllowed } from "../config.js";
import { jsonBody, orchestraRequest } from "../http.js";
import { boardIdSchema, putGraphSchema } from "../schemas.js";
import { textResult } from "./common.js";

export function registerGraphTools(server: McpServer, config: OrchestraMcpConfig): void {
  server.registerTool(
    "orchestra_get_graph",
    {
      title: "Get Pinodes Orchestra graph",
      description: "Fetch the graph for a board.",
      inputSchema: boardIdSchema.shape,
    },
    async (input) => {
      const { boardId } = boardIdSchema.parse(input);
      return textResult(await orchestraRequest(config, `/api/v1/orchestra/boards/${boardId}/graph`));
    },
  );

  server.registerTool(
    "orchestra_put_graph",
    {
      title: "Load Pinodes Orchestra graph",
      description: "Validate and load a workflow graph into a board.",
      inputSchema: putGraphSchema.shape,
    },
    async (input) => {
      const { boardId, graph } = putGraphSchema.parse(input);
      auditToolCall("orchestra_put_graph", { boardId, graph });
      const safeGraph = graph.cwd ? { ...graph, cwd: assertPathAllowed(graph.cwd, config) } : graph;
      return textResult(
        await orchestraRequest(config, `/api/v1/orchestra/boards/${boardId}/graph`, {
          method: "PUT",
          body: jsonBody(safeGraph),
        }),
      );
    },
  );
}
