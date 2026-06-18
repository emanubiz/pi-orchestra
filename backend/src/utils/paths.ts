import fs from "node:fs";
import path from "node:path";

/** Resolve and validate a board working directory. Throws if missing or not a directory. */
export function resolveCwd(cwd: unknown, fallback?: string): string {
  const raw =
    typeof cwd === "string" && cwd.trim()
      ? cwd.trim()
      : (fallback?.trim() || process.cwd());
  const resolved = path.resolve(raw);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`Not a valid directory: ${resolved}`);
  }
  return resolved;
}

/** Prefer graph cwd when valid; otherwise fall back to the board's stored cwd. */
export function resolveBoardCwd(graphCwd: string | undefined, boardCwd: string): string {
  if (graphCwd?.trim()) {
    try {
      return resolveCwd(graphCwd.trim());
    } catch {
      return resolveCwd(boardCwd);
    }
  }
  return resolveCwd(boardCwd);
}
