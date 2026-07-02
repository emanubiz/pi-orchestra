import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { auditToolCall } from "../audit.js";
import type { OrchestraMcpConfig } from "../config.js";
import { jsonBody, orchestraRequest } from "../http.js";
import { runBoardSchema } from "../schemas.js";
import { textResult } from "./common.js";

export function registerRunTools(server: McpServer, config: OrchestraMcpConfig): void {
  server.registerTool(
    "orchestra_run_board",
    {
      title: "Run Pinodes Orchestra board",
      description: "Inject a task into a board entry node or a specific node.",
      inputSchema: runBoardSchema.shape,
    },
    async (input) => {
      const { boardId, message, nodeId } = runBoardSchema.parse(input);
      auditToolCall("orchestra_run_board", { boardId, message, nodeId });
      return textResult(
        await orchestraRequest(config, `/api/v1/orchestra/boards/${boardId}/run`, {
          method: "POST",
          body: jsonBody({ message, nodeId }),
        }),
      );
    },
  );
}
