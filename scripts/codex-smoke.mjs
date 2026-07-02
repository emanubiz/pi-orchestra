#!/usr/bin/env node
/**
 * Codex structured-runtime smoke test (PRE_MERGE_TEST_CHECKLIST § 4-D).
 *
 * Uses scripts/mock-codex.mjs on PATH via PINODES_ORCHESTRA_CODEX=true.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";
import http from "node:http";
import WebSocket from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const MOCK_CODEX = path.join(__dirname, "mock-codex.mjs");
const PORT = 12000 + Math.floor(Math.random() * 40000);

const passed = [];
const failed = [];

function ok(name) {
  passed.push(name);
  console.log(`  ✅ ${name}`);
}
function fail(name, reason) {
  failed.push(name);
  console.error(`  ❌ ${name}: ${reason}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function request(method, urlPath, body) {
  const data = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: PORT,
        path: urlPath,
        method,
        headers: data
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }
          : {},
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          let parsed;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            parsed = null;
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

async function waitForHealth() {
  for (let i = 0; i < 150; i++) {
    try {
      const res = await request("GET", "/api/health");
      if (res.status === 200) return true;
    } catch {
      /* not up */
    }
    await sleep(100);
  }
  return false;
}

function connectWs(boardId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const events = [];
    ws.on("open", () => resolve({ ws, events, send: (msg) => ws.send(JSON.stringify({ boardId, ...msg })) }));
    ws.on("message", (raw) => {
      try {
        events.push(JSON.parse(raw.toString()));
      } catch {
        /* ignore */
      }
    });
    ws.on("error", reject);
  });
}

function outputFor(events, nodeId) {
  return events
    .filter((e) => e.type === "pty_output" && e.nodeId === nodeId && !e.replay)
    .map((e) => e.data)
    .join("");
}

function waitForEvent(events, predicate, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const hit = events.find(predicate);
      if (hit) return resolve(hit);
      if (Date.now() - start > timeoutMs) return reject(new Error("timeout"));
      setTimeout(tick, 50);
    };
    tick();
  });
}

async function run() {
  console.log("[codex-smoke] Starting backend on port", PORT);

  const backend = spawn("node", ["backend/dist/index.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      PINODES_ORCHESTRA_HOST: "127.0.0.1",
      PINODES_ORCHESTRA_CODEX: "true",
      PATH: `${path.dirname(MOCK_CODEX)}:${process.env.PATH}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Symlink mock as `codex` next to mock-codex.mjs
  const mockDir = path.dirname(MOCK_CODEX);
  const codexLink = path.join(mockDir, "codex");
  await import("node:fs/promises").then((fs) =>
    fs.writeFile(
      codexLink,
      `#!/usr/bin/env node\nimport '${MOCK_CODEX.replace(/\\/g, "\\\\")}';\n`,
      { mode: 0o755 },
    ),
  );

  if (!(await waitForHealth())) {
    fail("Backend startup", "health check timed out");
    backend.kill("SIGTERM");
    process.exit(1);
  }
  ok("Backend startup");

  try {
    // 4-D: Codex available
    const info = await request("GET", "/api/info");
    if (info.body?.runtimes?.codex === true) ok("Codex available (/api/info → runtimes.codex: true)");
    else fail("Codex available", `runtimes.codex=${info.body?.runtimes?.codex}`);

    const boardRes = await request("POST", "/api/v1/orchestra/boards", {
      cwd: ROOT,
      label: "codex-smoke",
    });
    const boardId = boardRes.body?.boardId;
    if (!boardId) throw new Error("board creation failed");

    const graph = {
      name: "codex-smoke",
      cwd: ROOT,
      entryNodeId: "arch",
      nodes: [
        {
          id: "arch",
          label: "Architect",
          promptId: "builtin:empty",
          runtime: "pi",
          canBeFinal: false,
          position: { x: 0, y: 0 },
        },
        {
          id: "dev",
          label: "Developer",
          promptId: "builtin:empty",
          runtime: "codex",
          canBeFinal: false,
          position: { x: 200, y: 0 },
        },
        {
          id: "reviewer",
          label: "Reviewer",
          promptId: "builtin:empty",
          runtime: "pi",
          position: { x: 400, y: 0 },
        },
      ],
      edges: [
        { id: "e1", sourceNodeId: "arch", targetNodeId: "dev" },
        { id: "e2", sourceNodeId: "dev", targetNodeId: "reviewer" },
      ],
    };
    await request("PUT", `/api/v1/orchestra/boards/${boardId}/graph`, graph);

    const { ws, events, send } = await connectWs(boardId);
    await sleep(200);

    // Spawn codex node via attach
    send({ type: "attach_node", nodeId: "dev", cols: 80, rows: 24 });
    await sleep(300);

    const scrollback = events.find(
      (e) => e.type === "pty_output" && e.nodeId === "dev" && String(e.data).includes("codex session ready"),
    );
    if (scrollback) ok("Session ready (─ codex session ready ─)");
    else fail("Session ready", `output=${JSON.stringify(events.filter((e) => e.nodeId === "dev"))}`);

    // Structured input: pty_input should not start a turn (codex ignores empty trim of \r)
    const eventsBefore = events.length;
    send({ type: "pty_input", nodeId: "dev", data: "typed from keyboard\n" });
    await sleep(400);
    const typedOutput = outputFor(events.slice(eventsBefore), "dev");
    if (typedOutput.includes("Keyboard input ignored")) {
      ok("Structured input (keyboard pty_input does not inject task)");
    } else {
      fail("Structured input", `expected ignore hint, got ${JSON.stringify(typedOutput.slice(0, 200))}`);
    }

    // Handoff delivery: upstream injects into codex
    const injectRes = await request("POST", `/api/v1/orchestra/boards/${boardId}/nodes/dev/inject`, {
      message: "Implement the API smoke test",
    });
    if (injectRes.status !== 200) fail("Handoff delivery", `inject status=${injectRes.status}`);
    else ok("Handoff delivery (inject accepted)");

    await waitForEvent(events, (e) => e.type === "node_status" && e.nodeId === "dev" && e.status === "running");
    await sleep(800);

    const devOutput = outputFor(events, "dev");
    if (devOutput.includes("Implemented feature") || devOutput.includes("Done.")) {
      ok("Output streaming (Codex JSONL → terminal text)");
    } else {
      fail("Output streaming", `devOutput=${JSON.stringify(devOutput.slice(0, 500))}`);
    }

    // Handoff works: codex emits @@HANDOFF to reviewer
    await request("POST", `/api/v1/orchestra/boards/${boardId}/nodes/dev/inject`, {
      message: "Please hand off to reviewer now",
    });
    await sleep(1200);

    const handoffEvent = events.find(
      (e) => e.type === "handoff" && e.fromNodeId === "dev" && e.toNodeId === "reviewer",
    );
    if (handoffEvent) ok("Handoff works (@@HANDOFF delivered to connected node)");
    else fail("Handoff works", `events=${JSON.stringify(events.filter((e) => e.type === "handoff"))}`);

    // Watchdog: non-final node ending without handoff gets nudged
    await request("POST", `/api/v1/orchestra/boards/${boardId}/nodes/dev/restart`);
    await sleep(400);
    events.length = 0;
    send({ type: "attach_node", nodeId: "dev", cols: 80, rows: 24 });
    await sleep(300);
    await request("POST", `/api/v1/orchestra/boards/${boardId}/nodes/dev/inject`, {
      message: "watchdog test — finish without handoff",
    });
    await sleep(2500);
    const watchdogOutput = outputFor(events, "dev");
    if (/Still working without handoff/.test(watchdogOutput) && /Nudged handoff/.test(watchdogOutput)) {
      ok("Watchdog (non-final node nudged on missing handoff)");
    } else {
      fail("Watchdog", `output=${JSON.stringify(watchdogOutput.slice(0, 800))}`);
    }

    // No pi fallback when codex unavailable
    backend.kill("SIGTERM");
    await sleep(500);

    const backendOff = spawn("node", ["backend/dist/index.js"], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(PORT + 1),
        PINODES_ORCHESTRA_HOST: "127.0.0.1",
        PINODES_ORCHESTRA_CODEX: "false",
      },
      stdio: "ignore",
    });
    const offPort = PORT + 1;
    const offRequest = (method, urlPath, body) => {
      const data = body ? JSON.stringify(body) : null;
      return new Promise((resolve, reject) => {
        const req = http.request(
          { hostname: "127.0.0.1", port: offPort, path: urlPath, method, headers: data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {} },
          (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => {
              let parsed;
              try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { parsed = null; }
              resolve({ status: res.statusCode, body: parsed });
            });
          },
        );
        req.on("error", reject);
        if (data) req.write(data);
        req.end();
      });
    };
    for (let i = 0; i < 100; i++) {
      try {
        const h = await offRequest("GET", "/api/health");
        if (h.status === 200) break;
      } catch { /* wait */ }
      await sleep(100);
    }
    const offInfo = await offRequest("GET", "/api/info");
    if (offInfo.body?.runtimes?.codex === false) ok("No pi fallback prep (runtimes.codex: false when forced off)");
    else fail("No pi fallback prep", `codex=${offInfo.body?.runtimes?.codex}`);

    const offBoard = await offRequest("POST", "/api/v1/orchestra/boards", { cwd: ROOT, label: "off" });
    const offBoardId = offBoard.body?.boardId;
    await offRequest("PUT", `/api/v1/orchestra/boards/${offBoardId}/graph`, {
      name: "codex-off",
      cwd: ROOT,
      entryNodeId: "dev",
      nodes: [{ ...graph.nodes.find((n) => n.id === "dev"), canBeFinal: true, runtime: "codex" }],
      edges: [],
    });
    const offWs = await new Promise((resolve, reject) => {
      const w = new WebSocket(`ws://127.0.0.1:${offPort}/ws`);
      const ev = [];
      w.on("open", () => resolve({ ws: w, events: ev, send: (msg) => w.send(JSON.stringify({ boardId: offBoardId, ...msg })) }));
      w.on("message", (raw) => { try { ev.push(JSON.parse(raw.toString())); } catch { /* */ } });
      w.on("error", reject);
    });
    offWs.send({ type: "attach_node", nodeId: "dev", cols: 80, rows: 24 });
    await sleep(500);
    const offOutput = offWs.events
      .filter((e) => e.type === "pty_output" && e.nodeId === "dev")
      .map((e) => e.data)
      .join("");
    if (offOutput.includes("CLI not found") && !offOutput.toLowerCase().includes("starting pi")) {
      ok("No pi fallback (codex node fails clearly, does not spawn pi)");
    } else {
      fail("No pi fallback", `output=${JSON.stringify(offOutput.slice(0, 300))}`);
    }
    const offRunning = offWs.events.some(
      (e) => e.type === "node_status" && e.nodeId === "dev" && e.status === "running",
    );
    if (!offRunning) ok("No spurious running status after codex spawn failure");
    else fail("No spurious running status", "node stayed running after codex unavailable");
    backendOff.kill("SIGTERM");
    offWs.ws.close();

    // Restart → fresh session (restart main backend for this check)
    const backend2 = spawn("node", ["backend/dist/index.js"], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(PORT),
        PINODES_ORCHESTRA_HOST: "127.0.0.1",
        PINODES_ORCHESTRA_CODEX: "true",
        PATH: `${path.dirname(MOCK_CODEX)}:${process.env.PATH}`,
      },
      stdio: "ignore",
    });
    for (let i = 0; i < 100; i++) {
      try {
        const h = await request("GET", "/api/health");
        if (h.status === 200) break;
      } catch { /* wait */ }
      await sleep(100);
    }

    const board2 = await request("POST", "/api/v1/orchestra/boards", { cwd: ROOT, label: "restart" });
    const boardId2 = board2.body?.boardId;
    await request("PUT", `/api/v1/orchestra/boards/${boardId2}/graph`, graph);
    const ws2 = await connectWs(boardId2);
    ws2.send({ type: "attach_node", nodeId: "dev", cols: 80, rows: 24 });
    await sleep(300);
    await request("POST", `/api/v1/orchestra/boards/${boardId2}/nodes/dev/inject`, { message: "first session" });
    await sleep(800);
    const thread1Output = outputFor(ws2.events, "dev");
    ws2.send({ type: "restart_node", nodeId: "dev", cols: 80, rows: 24 });
    await sleep(400);
    ws2.events.length = 0;
    ws2.send({ type: "attach_node", nodeId: "dev", cols: 80, rows: 24 });
    await sleep(300);
    const readyAgain = ws2.events.some(
      (e) => e.type === "pty_output" && e.nodeId === "dev" && String(e.data).includes("codex session ready"),
    );
    if (readyAgain) ok("Restart (fresh codex session ready after restart)");
    else fail("Restart", `events=${JSON.stringify(ws2.events.slice(0, 5))}`);

    ws.close();
    ws2.ws.close();
    backend2.kill("SIGTERM");
    try {
      await request("DELETE", `/api/v1/orchestra/boards/${boardId}`);
    } catch {
      /* backend already stopped */
    }
  } catch (err) {
    fail("Unexpected", err instanceof Error ? err.message : String(err));
  } finally {
    try { backend.kill("SIGTERM"); } catch { /* */ }
  }

  console.log("\n─── Codex Smoke Summary (§ 4-D) ───");
  console.log(`  ✅ Passed: ${passed.length}`);
  if (failed.length) {
    console.log(`  ❌ Failed: ${failed.length}`);
    for (const f of failed) console.log(`    • ${f}`);
  }
  process.exit(failed.length ? 1 : 0);
}

run().catch((err) => {
  console.error("[codex-smoke] Fatal:", err);
  process.exit(1);
});
