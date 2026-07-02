import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { auditToolCall } from "../audit.js";
import type { OrchestraMcpConfig } from "../config.js";
import { jsonBody, orchestraRequest } from "../http.js";
import { boardIdSchema, injectNodeSchema } from "../schemas.js";
import { textResult } from "./common.js";

export function registerInjectTools(server: McpServer, config: OrchestraMcpConfig): void {
  server.registerTool(
    "orchestra_inject_node",
    {
      title: "Inject message into Pinodes Orchestra node",
      description: "Safely inject a user message into a node. This is not raw PTY input.",
      inputSchema: injectNodeSchema.shape,
    },
    async (input) => {
      const { boardId, nodeId, message } = injectNodeSchema.parse(input);
      auditToolCall("orchestra_inject_node", { boardId, nodeId, message });
      return textResult(
        await orchestraRequest(config, `/api/v1/orchestra/boards/${boardId}/nodes/${nodeId}/inject`, {
          method: "POST",
          body: jsonBody({ message }),
        }),
      );
    },
  );

  server.registerTool(
    "orchestra_stop_board",
    {
      title: "Stop Pinodes Orchestra board",
      description: "Stop all running node sessions in a board. Destructive/confirmation-worthy.",
      inputSchema: boardIdSchema.shape,
    },
    async (input) => {
      const { boardId } = boardIdSchema.parse(input);
      auditToolCall("orchestra_stop_board", { boardId });
      return textResult(
        await orchestraRequest(config, `/api/v1/orchestra/boards/${boardId}/stop`, {
          method: "POST",
        }),
      );
    },
  );
}
