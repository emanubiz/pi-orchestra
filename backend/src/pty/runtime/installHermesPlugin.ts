import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Make the app self-sufficient for Hermes handoffs: ship the orchestra plugin
 * with the backend and install + enable it in the user's Hermes automatically,
 * so a fresh install needs no manual `setup-hermes-plugin.sh` step.
 *
 * Hermes only discovers plugins under `<hermes-home>/plugins/<name>/` and a
 * standalone plugin must additionally be in `plugins.enabled` (its opt-in
 * allow-list). We satisfy both here: copy the bundled plugin into place, then
 * `hermes plugins enable orchestra` (idempotent — a no-op when already enabled).
 *
 * Depends only on the `hermes` binary being present, which is already the
 * prerequisite for using HermesRuntime at all.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Compiled at backend/dist/pty/runtime/ (dev) or server/backend/dist/pty/runtime/
// (bundled); the plugin sits at backend/hermes-plugins/orchestra/ in both, so
// the same relative walk resolves it either way (the bundle mirrors the repo).
const PLUGIN_SRC = path.resolve(__dirname, "../../../hermes-plugins/orchestra");
const PLUGIN_FILES = ["__init__.py", "plugin.yaml"];

// Install is attempted once per backend process — set the guard up-front so a
// failure (e.g. read-only home) doesn't re-run the subprocess on every spawn.
let attempted = false;

/** `<hermes-home>/`, honouring HERMES_HOME the same way Hermes itself does. */
function hermesHome(): string {
  const h = process.env.HERMES_HOME?.trim();
  return h ? path.resolve(h) : path.join(os.homedir(), ".hermes");
}

/**
 * Idempotent, best-effort. Never throws: a failure here must not block spawning
 * the node — it only means handoffs won't work until the plugin is enabled, and
 * we log a clear one-line hint for that case.
 */
export function ensureHermesPluginInstalled(hermesCmd: string): void {
  if (attempted) return;
  attempted = true;
  try {
    const targetDir = path.join(hermesHome(), "plugins", "orchestra");
    if (copyPluginFiles(targetDir)) {
      console.log(`pinodes-orchestra: installed orchestra Hermes plugin → ${targetDir}`);
    }
    enablePlugin(hermesCmd);
  } catch (err) {
    console.error(
      "pinodes-orchestra: Hermes plugin auto-install failed — handoffs may not " +
        "work until you run `hermes plugins enable orchestra`:",
      err,
    );
  }
}

/**
 * Copy the bundled plugin files into `targetDir`, returning true when anything
 * was written. A symlinked target means a dev checkout wired via
 * setup-hermes-plugin.sh — leave it pointing at the repo so live edits keep
 * working, and just let enablePlugin run.
 */
function copyPluginFiles(targetDir: string): boolean {
  let link: fs.Stats | undefined;
  try {
    link = fs.lstatSync(targetDir);
  } catch {
    /* target missing — fresh install */
  }
  if (link?.isSymbolicLink()) return false;

  if (!fs.existsSync(PLUGIN_SRC)) {
    throw new Error(`bundled plugin source not found at ${PLUGIN_SRC}`);
  }
  fs.mkdirSync(targetDir, { recursive: true });
  let wrote = false;
  for (const f of PLUGIN_FILES) {
    const next = fs.readFileSync(path.join(PLUGIN_SRC, f));
    const dst = path.join(targetDir, f);
    let cur: Buffer | undefined;
    try {
      cur = fs.readFileSync(dst);
    } catch {
      /* not there yet */
    }
    if (!cur || !cur.equals(next)) {
      fs.writeFileSync(dst, next);
      wrote = true;
    }
  }
  return wrote;
}

/** Enable the plugin in Hermes' opt-in allow-list (idempotent; no-op when on). */
function enablePlugin(hermesCmd: string): void {
  execFileSync(hermesCmd, ["plugins", "enable", "orchestra"], {
    stdio: "ignore",
    timeout: 15_000,
  });
}
