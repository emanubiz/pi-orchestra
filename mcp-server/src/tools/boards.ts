import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { auditToolCall } from "../audit.js";
import type { OrchestraMcpConfig } from "../config.js";
import { assertPathAllowed } from "../config.js";
import { jsonBody, orchestraRequest } from "../http.js";
import { createBoardSchema } from "../schemas.js";
import { textResult } from "./common.js";

export function registerBoardTools(server: McpServer, config: OrchestraMcpConfig): void {
  server.registerTool(
    "orchestra_list_boards",
    {
      title: "List Pinodes Orchestra boards",
      description: "List live/persisted boards from the configured pinodes-orchestra backend.",
      inputSchema: {},
    },
    async () => textResult(await orchestraRequest(config, "/api/v1/orchestra/boards")),
  );

  server.registerTool(
    "orchestra_create_board",
    {
      title: "Create Pinodes Orchestra board",
      description: "Create a board after validating cwd against PINODES_ORCHESTRA_ALLOWED_ROOTS.",
      inputSchema: createBoardSchema.shape,
    },
    async (input) => {
      const parsed = createBoardSchema.parse(input);
      auditToolCall("orchestra_create_board", parsed);
      const cwd = assertPathAllowed(parsed.cwd, config);
      const result = await orchestraRequest(config, "/api/v1/orchestra/boards", {
        method: "POST",
        body: jsonBody({ cwd, label: parsed.label }),
      });
      return textResult(result);
    },
  );
}
