import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const AUDIT_ACTIONS = new Set([
  "orchestra_create_board",
  "orchestra_put_graph",
  "orchestra_run_board",
  "orchestra_inject_node",
  "orchestra_stop_board",
]);

export function auditToolCall(tool: string, input: unknown): void {
  if (!AUDIT_ACTIONS.has(tool)) return;
  const explicitPath = process.env.PINODES_ORCHESTRA_MCP_AUDIT_LOG;
  const baseDir = process.env.PINODES_ORCHESTRA_DATA_DIR ?? path.join(os.homedir(), ".pinodes-orchestra");
  const auditPath = explicitPath ?? path.join(baseDir, "mcp-audit.jsonl");
  try {
    fs.mkdirSync(path.dirname(auditPath), { recursive: true });
    fs.appendFileSync(
      auditPath,
      JSON.stringify({ ts: new Date().toISOString(), actor: "mcp", tool, input }) + "\n",
      "utf8",
    );
  } catch {
    // Audit logging must never break tool execution.
  }
}
