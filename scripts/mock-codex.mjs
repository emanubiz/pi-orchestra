#!/usr/bin/env node
/**
 * Mock `codex` CLI for Codex structured-runtime smoke tests.
 * Supports: `codex exec --json … -` and `codex exec … resume <threadId> -`
 */
import { createInterface } from "node:readline";

const args = process.argv.slice(2);

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function fail(msg, code = 1) {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
}

if (args[0] === "--version") {
  console.log("mock-codex 0.0.0-smoke");
  process.exit(0);
}

if (args[0] !== "exec") {
  fail(`mock-codex: unsupported command (got ${args[0] ?? "(none)"})`);
}

const jsonMode = args.includes("--json");
if (!jsonMode) fail("mock-codex: only --json exec mode is supported");

const resumeIdx = args.indexOf("resume");
const isResume = resumeIdx !== -1;
const threadId = isResume
  ? args[resumeIdx + 1] ?? `thread-resumed-${Date.now()}`
  : `thread-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function readStdin() {
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8");
  }
  return "";
}

const prompt = await readStdin();
// User task is appended after the orchestration appendix (double newline).
const userTask = prompt.includes("\n\n")
  ? prompt.slice(prompt.lastIndexOf("\n\n") + 2).trim()
  : prompt.trim();

emit({ type: "thread.started", thread_id: threadId });
emit({ type: "turn.started" });

let text = "Done.\n";

if (/Please hand off to reviewer/i.test(userTask)) {
  text = "@@HANDOFF:reviewer\nTask complete.\n@@END\n";
} else if (/watchdog test/i.test(userTask)) {
  text = "Still working without handoff.\n";
} else if (/\[orchestra\] You must hand off/i.test(userTask)) {
  const recipient = userTask.match(/recipients:\s*([^\s,\n]+)/i)?.[1] ?? "reviewer";
  text = `@@HANDOFF:${recipient}\nNudged handoff.\n@@END\n`;
} else if (/Implement the API/i.test(userTask)) {
  text = "Implemented feature.\n";
}

emit({
  type: "item.completed",
  item: { id: "1", type: "agent_message", text },
});
emit({ type: "turn.completed" });
process.exit(0);
