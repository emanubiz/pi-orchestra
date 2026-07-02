import path from "node:path";

export type McpMode = "safe" | "full";

export interface OrchestraMcpConfig {
  baseUrl: string;
  token: string | null;
  allowedRoots: string[];
  mode: McpMode;
  timeoutMs: number;
}

function cleanUrl(value: string | undefined): string {
  return (value || "http://127.0.0.1:3847").replace(/\/+$/, "");
}

function parseAllowedRoots(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => path.resolve(item));
}

function parseMode(value: string | undefined): McpMode {
  return value === "full" ? "full" : "safe";
}

function parseTimeout(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 30_000;
  return Math.min(parsed, 300_000);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): OrchestraMcpConfig {
  return {
    baseUrl: cleanUrl(env.PINODES_ORCHESTRA_URL),
    token: env.PINODES_ORCHESTRA_TOKEN || null,
    allowedRoots: parseAllowedRoots(env.PINODES_ORCHESTRA_ALLOWED_ROOTS),
    mode: parseMode(env.PINODES_ORCHESTRA_MCP_MODE),
    timeoutMs: parseTimeout(env.PINODES_ORCHESTRA_TIMEOUT_MS),
  };
}

export function assertPathAllowed(targetPath: string, config: OrchestraMcpConfig): string {
  const resolved = path.resolve(targetPath);
  if (config.allowedRoots.length === 0) return resolved;

  const allowed = config.allowedRoots.some((root) => {
    const relative = path.relative(root, resolved);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });

  if (!allowed) {
    throw new Error(
      `Path is outside PINODES_ORCHESTRA_ALLOWED_ROOTS: ${resolved}. Allowed roots: ${config.allowedRoots.join(", ")}`,
    );
  }
  return resolved;
}
