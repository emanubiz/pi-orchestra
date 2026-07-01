#!/usr/bin/env node
/**
 * Assemble a self-contained backend tree under `vscode-extension/server/` so the
 * packaged extension can run without the repo checked out.
 *
 * Layout produced (mirrors the repo so the backend's path resolution — which
 * walks up from its own dist — keeps working unchanged):
 *
 *   server/
 *     backend/dist/**            compiled backend (ESM)
 *     backend/pi-extensions/**   @@HANDOFF/@@CARD parser (pi --extension, .ts)
 *     backend/hermes-plugins/**  orchestra plugin (Python) auto-installed into
 *                                ~/.hermes/plugins by installHermesPlugin.ts
 *     backend/package.json       trimmed: type=module + prod deps (no pi)
 *     backend/node_modules/**    production dependency closure incl. native
 *                                (node-pty, better-sqlite3) — `pi` is NOT bundled
 *                                (it's a runtime prerequisite checked at launch)
 *     frontend/dist/**           built UI, served statically by the backend
 *     prompts/**                 seed system prompts
 *
 * No network: the prod dependency closure is copied from the workspace's
 * (hoisted) node_modules, which is already built for this platform. Native
 * binaries are therefore tied to THIS OS/arch + Node ABI — produce one VSIX per
 * platform with `vsce package --target <platform>` built on/for that platform.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const extRoot = path.resolve(here, "..");
const repoRoot = path.resolve(extRoot, "..");
const rootModules = path.join(repoRoot, "node_modules");
const serverDir = path.join(extRoot, "server");

/** Dependency we never ship: the user installs the pi CLI themselves. */
const EXCLUDE = new Set(["@earendil-works/pi-coding-agent"]);

/** Platform we're bundling for (process.platform + process.arch). */
const BUNDLE_PLATFORM = `${process.platform}-${process.arch}`;

/** Packages with native binaries that need platform-specific filtering. */
const NATIVE_PKGS = {
  "node-pty": {
    // Keep the whole build/Release tree: on Windows the runtime needs more than
    // pty.node (conpty.node, winpty.dll, winpty-agent.exe, the conpty/ folder).
    // Compilation intermediates are stripped by skipBuildJunk below.
    keep: [
      "package.json",
      "lib/**",
      "build/Release/**",
    ],
    // Recent node-pty ships its native binaries under prebuilds/<platform>/
    // (prebuildify layout) instead of build/Release — on Windows that's where
    // pty.node + conpty.node live. Copy the prebuild for THE TARGET platform so
    // the loadable .node modules actually make it into the VSIX. (A previously
    // hardcoded "linux-x64" here meant Windows/mac VSIXs shipped no pty binary,
    // leaving agent nodes stuck on "starting pi".)
    prebuildPlatform: BUNDLE_PLATFORM,
  },
  "better-sqlite3": {
    keep: [
      "package.json",
      "lib/**",
      "build/Release/**",
    ],
  },
};

/** Drop compiler intermediates so build/Release/** stays lean across platforms. */
function skipBuildJunk(src) {
  const b = path.basename(src);
  if (b === "obj.target" || b === "obj" || b === ".deps") return false;
  if (b === "test_extension.node") return false; // better-sqlite3 test fixture
  // Drop compiler intermediates and link-time-only artifacts (static/import
  // libs, debug symbols); the runtime only needs the loadable *.node + dlls.
  return !/\.(o|obj|a|lib|pdb|tlog|lastbuildstate|recipe|ipdb|iobj|exp|ilk)$/i.test(b);
}

const log = (m) => console.log(`[bundle] ${m}`);

function run(cmd, args) {
  log(`$ ${cmd} ${args.join(" ")}`);
  // On Windows `npm` is `npm.cmd`; Node ≥18.20/20.12 refuses to spawn .cmd
  // without a shell, so enable it there.
  execFileSync(cmd, args, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
}

function copyDir(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true, dereference: true });
}

/** Copy a package with platform-specific filtering for native modules. */
function copyPkgFiltered(name, src, dest) {
  const spec = NATIVE_PKGS[name];
  if (!spec) {
    copyDir(src, dest);
    return;
  }

  log(`filtering native package: ${name} (platform: ${BUNDLE_PLATFORM})`);

  // Create dest dir
  fs.mkdirSync(dest, { recursive: true });

  // Helper: copy matching patterns
  const copyPatterns = (patterns, srcBase, destBase) => {
    for (const pattern of patterns) {
      if (pattern.endsWith("/**")) {
        // Directory copy: copy entire subtree
        const dir = pattern.slice(0, -3);
        const srcDir = path.join(srcBase, dir);
        const destDir = path.join(destBase, dir);
        if (fs.existsSync(srcDir)) {
          fs.cpSync(srcDir, destDir, {
            recursive: true,
            dereference: true,
            filter: skipBuildJunk,
          });
        }
      } else {
        // Single file
        const srcFile = path.join(srcBase, pattern);
        const destFile = path.join(destBase, pattern);
        if (fs.existsSync(srcFile)) {
          fs.mkdirSync(path.dirname(destFile), { recursive: true });
          fs.copyFileSync(srcFile, destFile);
        }
      }
    }
  };

  // Always copy kept patterns
  copyPatterns(spec.keep, src, dest);

  // For node-pty, copy the prebuildify-layout native binaries for the target
  // platform (prebuilds/<platform>/*.node) — this is where pty.node/conpty.node
  // live in recent versions, separate from build/Release.
  if (spec.prebuildPlatform) {
    const prebuildDir = path.join(src, "prebuilds", spec.prebuildPlatform);
    if (fs.existsSync(prebuildDir)) {
      const destPrebuild = path.join(dest, "prebuilds", spec.prebuildPlatform);
      fs.cpSync(prebuildDir, destPrebuild, { recursive: true, dereference: true });
    }
  }

  // Copy nested node_modules (prod deps of the native pkg)
  const nestedModules = path.join(src, "node_modules");
  if (fs.existsSync(nestedModules)) {
    const destNested = path.join(dest, "node_modules");
    fs.cpSync(nestedModules, destNested, { recursive: true, dereference: true });
  }
}

/** Resolve a package directory, preferring a consumer-local nested copy. */
function resolvePkg(name, fromDirs) {
  for (const base of fromDirs) {
    const dir = path.join(base, ...name.split("/"));
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
  }
  return null;
}

/** BFS the production dependency closure starting from a set of names. */
function collectClosure(rootNames) {
  const resolved = new Map(); // name -> source dir
  const queue = [...rootNames].map((name) => ({ name, fromDirs: [rootModules] }));

  while (queue.length) {
    const { name, fromDirs } = queue.shift();
    if (EXCLUDE.has(name) || resolved.has(name)) continue;
    const dir = resolvePkg(name, fromDirs);
    if (!dir) {
      log(`WARN: dependency not found, skipping: ${name}`);
      continue;
    }
    resolved.set(name, dir);
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8"));
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.optionalDependencies ?? {}) };
    const nested = path.join(dir, "node_modules");
    for (const depName of Object.keys(deps)) {
      if (!resolved.has(depName) && !EXCLUDE.has(depName)) {
        queue.push({ name: depName, fromDirs: [nested, rootModules] });
      }
    }
  }
  return resolved;
}

function dirSizeMB(dir) {
  let bytes = 0;
  const walk = (p) => {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const full = path.join(p, e.name);
      if (e.isDirectory()) walk(full);
      else
        try {
          bytes += fs.statSync(full).size;
        } catch {
          /* ignore */
        }
    }
  };
  walk(dir);
  return (bytes / 1024 / 1024).toFixed(1);
}

// ── 1. Build backend + frontend (unless told to reuse existing output) ───────
if (!process.env.SKIP_BUILD) {
  run("npm", ["run", "build", "-w", "backend", "-w", "frontend"]);
}

const backendDist = path.join(repoRoot, "backend", "dist");
const frontendDist = path.join(repoRoot, "frontend", "dist");
if (!fs.existsSync(backendDist)) throw new Error("backend/dist missing — build failed?");
if (!fs.existsSync(frontendDist)) throw new Error("frontend/dist missing — build failed?");

// ── 2. Clean & lay out server/ ──────────────────────────────────────────────
log(`cleaning ${path.relative(repoRoot, serverDir)}`);
fs.rmSync(serverDir, { recursive: true, force: true });

copyDir(backendDist, path.join(serverDir, "backend", "dist"));
copyDir(path.join(repoRoot, "backend", "pi-extensions"), path.join(serverDir, "backend", "pi-extensions"));
// The Hermes orchestra plugin (Python): installHermesPlugin.ts copies it from
// here into ~/.hermes/plugins/orchestra so the app is self-sufficient for
// Hermes handoffs without a manual setup step.
copyDir(path.join(repoRoot, "backend", "hermes-plugins"), path.join(serverDir, "backend", "hermes-plugins"));
copyDir(frontendDist, path.join(serverDir, "frontend", "dist"));
copyDir(path.join(repoRoot, "prompts"), path.join(serverDir, "prompts"));

// ── 3. Trimmed backend package.json (prod deps, no pi, ESM) ──────────────────
const backendPkg = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "backend", "package.json"), "utf-8"),
);
const prodDeps = Object.fromEntries(
  Object.entries(backendPkg.dependencies ?? {}).filter(([name]) => !EXCLUDE.has(name)),
);
fs.writeFileSync(
  path.join(serverDir, "backend", "package.json"),
  JSON.stringify(
    {
      name: backendPkg.name,
      version: backendPkg.version,
      private: true,
      type: backendPkg.type ?? "module",
      main: "dist/index.js",
      dependencies: prodDeps,
    },
    null,
    2,
  ) + "\n",
);

// ── 4. Copy the production dependency closure ───────────────────────────────
const closure = collectClosure(Object.keys(prodDeps));
log(`copying ${closure.size} production packages`);
const destModules = path.join(serverDir, "backend", "node_modules");
for (const [name, src] of closure) {
  const dest = path.join(destModules, ...name.split("/"));
  // For native packages, filter to only runtime-necessary files.
  // Other packages are copied as-is (they're pure JS).
  copyPkgFiltered(name, src, dest);
}

log(`done → server/ (${dirSizeMB(serverDir)} MB)`);
log("native binaries are platform-specific: package per-target with `vsce package --target <platform>`.");
