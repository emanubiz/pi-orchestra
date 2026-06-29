import fs from "node:fs";
import path from "node:path";

/** Search an executable in PATH. Accepts a single name or multiple fallback names. */
export function findInPath(names: string | string[]): string | undefined {
  const candidates = Array.isArray(names) ? names : [names];
  const pathVar = process.env.PATH ?? "";
  for (const dir of pathVar.split(path.delimiter)) {
    for (const name of candidates) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    }
  }
  return undefined;
}
