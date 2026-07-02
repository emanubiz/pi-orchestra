import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OrchestraMcpConfig } from "../config.js";
import { openUiSchema } from "../schemas.js";
import { textResult } from "./common.js";

export function buildUiUrl(config: OrchestraMcpConfig, input: unknown): string {
  const { boardId, cwd, embed } = openUiSchema.parse(input ?? {});
  const url = new URL(config.baseUrl);
  if (boardId) url.searchParams.set("board", boardId);
  if (cwd) url.searchParams.set("cwd", cwd);
  if (embed) url.searchParams.set("embed", embed);
  if (config.token) url.searchParams.set("token", config.token);
  return url.toString();
}

export function registerOpenUiTools(server: McpServer, config: OrchestraMcpConfig): void {
  server.registerTool(
    "orchestra_open_ui",
    {
      title: "Build Pinodes Orchestra UI URL",
      description: "Return a browser URL/deep link for the Orchestra UI. Does not open a browser in safe mode.",
      inputSchema: openUiSchema.shape,
    },
    async (input) => textResult({ url: buildUiUrl(config, input) }),
  );
}
