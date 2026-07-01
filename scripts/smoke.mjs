#!/usr/bin/env node
/**
 * smoke.mjs — Single-command sanity check for manual testing.
 *
 * Starts the backend on an ephemeral port, exercises the /api/v1/orchestra
 * REST API (board creation, graph load, run + lifecycle), then tears down.
 *
 * Graceful degradation: if the `pi` CLI is not on PATH, the "run node" step
 * is skipped and the script reports which steps were tested vs skipped.
 *
 * Usage:
 *   node scripts/smoke.mjs          # normal run
 *   node scripts/smoke.mjs --quiet  # minimal output
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import http from "node:http";

// ── Config ──────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const QUIET = process.argv.includes("--quiet");
const PORT = 10000 + Math.floor(Math.random() * 50000); // ephemeral

// ── Helpers ─────────────────────────────────────────────────────────────────

function log(...args) {
  if (!QUIET) console.log("[smoke]", ...args);
}

/** HTTP request helper — returns { status, body }. */
function request(method, urlPath, body) {
  const data = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: PORT,
        path: urlPath,
        method,
        headers: {
          // Only declare a JSON body when there IS one: Fastify rejects an
          // empty body sent with Content-Type: application/json (400,
          // FST_ERR_CTP_EMPTY_JSON_BODY) — e.g. on bare DELETEs.
          ...(data
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }
            : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
          let parsed;
          try {
            parsed = JSON.parse(raw);
          } catch {
            parsed = raw;
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

/** Wait for the backend to be healthy (up to 15 s). */
async function waitForHealth() {
  for (let i = 0; i < 150; i++) {
    try {
      const res = await request("GET", "/api/health");
      if (res.status === 200) return true;
    } catch {
      // not up yet
    }
    await sleep(100);
  }
  return false;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Check if pi CLI is on PATH. */
function hasPiCli() {
  return new Promise((resolve) => {
    const child = spawn("which", ["pi"], { stdio: "ignore" });
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

// ── Main ────────────────────────────────────────────────────────────────────

const passed = [];
const failed = [];
const skipped = [];

function ok(name) {
  passed.push(name);
  log(`  ✅ ${name}`);
}
function fail(name, reason) {
  failed.push(name);
  console.error(`  ❌ ${name}: ${reason}`);
}
function skip(name, reason) {
  skipped.push(name);
  log(`  ⏭️  ${name} (skipped: ${reason})`);
}

async function run() {
  log("Starting backend on port", PORT);

  // 1. Spawn backend
  const backend = spawn("node", ["backend/dist/index.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), PINODES_ORCHESTRA_HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let backendOutput = "";
  backend.stdout.on("data", (d) => {
    backendOutput += d.toString();
  });
  backend.stderr.on("data", (d) => {
    backendOutput += d.toString();
  });

  const exitPromise = new Promise((resolve) => {
    backend.on("close", (code) => resolve(code));
  });

  // Give it a moment, then check health
  const healthy = await waitForHealth();
  if (!healthy) {
    fail("Backend startup", "health check timed out after 15s");
    backend.kill("SIGTERM");
    printSummary();
    process.exit(1);
  }
  ok("Backend startup");

  try {
    // 2. Health endpoint
    const health = await request("GET", "/api/health");
    if (health.status === 200 && health.body?.ok) {
      ok("GET /api/health");
    } else {
      fail("GET /api/health", `status=${health.status}`);
    }

    // 3. Create board
    const boardRes = await request("POST", "/api/v1/orchestra/boards", {
      cwd: "/tmp",
      label: "smoke-test",
    });
    if (boardRes.status === 200 && boardRes.body?.boardId) {
      ok("POST /boards — board created");
    } else {
      fail("POST /boards", `status=${boardRes.status} body=${JSON.stringify(boardRes.body)}`);
      throw new Error("Cannot continue without a board");
    }
    const boardId = boardRes.body.boardId;

    // 4. Load a 2-node graph
    const graph = {
      name: "smoke",
      cwd: "/tmp",
      entryNodeId: "n1",
      nodes: [
        { id: "n1", label: "Source", promptId: "builtin:empty", canBeFinal: false, position: { x: 0, y: 0 } },
        { id: "n2", label: "Target", promptId: "builtin:empty", position: { x: 100, y: 0 } },
      ],
      edges: [{ id: "e1", sourceNodeId: "n1", targetNodeId: "n2" }],
    };
    const graphRes = await request("PUT", `/api/v1/orchestra/boards/${boardId}/graph`, graph);
    if (graphRes.status === 200 && graphRes.body?.ok) {
      ok("PUT /graph — 2-node graph persisted");
    } else {
      fail("PUT /graph", `status=${graphRes.status} body=${JSON.stringify(graphRes.body)}`);
    }

    // 5. GET graph back
    const getGraph = await request("GET", `/api/v1/orchestra/boards/${boardId}/graph`);
    if (
      getGraph.status === 200 &&
      getGraph.body?.nodes?.length === 2 &&
      getGraph.body?.edges?.length === 1
    ) {
      ok("GET /graph — round-trip verified");
    } else {
      fail("GET /graph", `status=${getGraph.status} nodes=${getGraph.body?.nodes?.length}`);
    }

    // 6. Board status (before run — all idle)
    const statusRes = await request("GET", `/api/v1/orchestra/boards/${boardId}/status`);
    if (
      statusRes.status === 200 &&
      statusRes.body?.nodes?.length === 2 &&
      statusRes.body.nodes.every((n) => n.status === "idle")
    ) {
      ok("GET /status — 2 nodes, all idle");
    } else {
      fail("GET /status (pre-run)", `status=${statusRes.status}`);
    }

    // 7. Run a node — requires pi CLI
    const piAvailable = await hasPiCli();
    if (!piAvailable) {
      skip("POST /run — node lifecycle", "pi CLI not on PATH");
      skip("GET /status (running)", "pi CLI not on PATH");
    } else {
      const runRes = await request("POST", `/api/v1/orchestra/boards/${boardId}/run`, {
        message: "smoke test task",
      });
      if (runRes.status === 200 && runRes.body?.ok) {
        ok("POST /run — node started");
      } else {
        fail("POST /run", `status=${runRes.status} body=${JSON.stringify(runRes.body)}`);
      }

      // Give the PTY a moment to spawn
      await sleep(500);

      const statusRunning = await request("GET", `/api/v1/orchestra/boards/${boardId}/status`);
      const runningNode = statusRunning.body?.nodes?.find((n) => n.nodeId === "n1");
      if (runningNode?.status === "running") {
        ok("GET /status — entry node is running");
      } else {
        fail("GET /status (running)", `n1 status=${runningNode?.status}`);
      }
    }

    // 8. Granular CRUD: add node
    const addNode = await request("POST", `/api/v1/orchestra/boards/${boardId}/nodes`, {
      label: "Reviewer",
      promptId: "builtin:empty",
      position: { x: 200, y: 0 },
    });
    if (addNode.status === 200 && addNode.body?.node?.id) {
      ok("POST /nodes — granular add");
    } else {
      fail("POST /nodes", `status=${addNode.status}`);
    }

    // 9. Granular CRUD: add edge
    const addEdge = await request("POST", `/api/v1/orchestra/boards/${boardId}/edges`, {
      sourceNodeId: "n2",
      targetNodeId: addNode.body?.node?.id,
    });
    if (addEdge.status === 200 && addEdge.body?.edge?.id) {
      ok("POST /edges — granular add");
    } else {
      fail("POST /edges", `status=${addEdge.status}`);
    }

    // 10. Delete board
    const delRes = await request("DELETE", `/api/v1/orchestra/boards/${boardId}`);
    if (delRes.status === 200 && delRes.body?.ok) {
      ok("DELETE /boards — cleanup");
    } else {
      fail("DELETE /boards", `status=${delRes.status}`);
    }

    // 11. 404 for deleted board
    const afterDel = await request("GET", `/api/v1/orchestra/boards/${boardId}/status`);
    if (afterDel.status === 404) {
      ok("GET /status (deleted) — 404");
    } else {
      fail("GET /status (deleted)", `expected 404, got ${afterDel.status}`);
    }
  } finally {
    backend.kill("SIGTERM");
    await Promise.race([exitPromise, sleep(3000)]);
  }

  printSummary();
  process.exit(failed.length > 0 ? 1 : 0);
}

function printSummary() {
  console.log("");
  console.log("─── Smoke Test Summary ───────────────────────────────────");
  console.log(`  ✅ Passed:   ${passed.length}`);
  if (failed.length) console.log(`  ❌ Failed:   ${failed.length}`);
  if (skipped.length) console.log(`  ⏭️  Skipped:  ${skipped.length}`);
  if (failed.length) {
    console.log("");
    console.log("  Failures:");
    for (const f of failed) console.log(`    • ${f}`);
  }
  console.log("──────────────────────────────────────────────────────────");
}

run().catch((err) => {
  console.error("[smoke] Fatal:", err);
  process.exit(1);
});
