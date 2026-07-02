/**
 * pinodes-orchestra ↔ Claude Code bridge — ONE hook script for all events.
 *
 * Wired via `--settings` (see resolveClaudeSettings.ts) to three hook events,
 * and dispatched on the `hook_event_name` field Claude Code passes on stdin:
 *
 *   SessionStart     → POST /internal/ready            (mark node booted → flush queued injects)
 *   UserPromptSubmit → POST /internal/turn-started     (closed-loop submit confirmation)
 *                      GET  /internal/orchestra-context → emit additionalContext (per-turn appendix)
 *   Stop             → parse the turn's final output from the transcript for the
 *                      shared text sentinels (same contract as pi's call-agent.ts
 *                      and the Hermes plugin):
 *                        @@HANDOFF:<handle> … @@END → POST /internal/call-agent
 *                        @@CARD:<column>            → POST /internal/card-status
 *                      then POST /internal/turn-ended { handoffCalledThisTurn }
 *
 * Self-gating: when PINODES_ORCHESTRA_NODE is absent from the env this exits 0
 * immediately, so a user's own `claude` sessions are never affected. Fail-open:
 * a network error must never block the agent — the backend already tolerates a
 * missed ready (fallback timeout), turn-started (submit watch re-sends `\r`)
 * and turn-ended (watchdog is best-effort).
 */
import fs from "node:fs";

// Env is read lazily (not at module load) so tests can set it after import;
// at runtime the values are constant for the process lifetime anyway.
const env = () => ({
  BASE_URL: process.env.PINODES_ORCHESTRA_URL ?? "http://localhost:3847",
  BOARD_ID: process.env.PINODES_ORCHESTRA_BOARD ?? "",
  NODE_ID: process.env.PINODES_ORCHESTRA_NODE ?? "",
  TOKEN: process.env.PINODES_ORCHESTRA_TOKEN ?? "",
});

const REQUEST_TIMEOUT_MS = 5_000;

// Same regexes as backend/pi-extensions/call-agent.ts — the reference
// implementation of the sentinel contract. Keep in sync.
export const HANDOFF_RE = /@@HANDOFF:\s*([^\s\n]+)\s*\n([\s\S]*?)@@END/g;
export const CARD_RE = /@@CARD:\s*([^\s\n]+)/g;

const authHeaders = () => {
  const { TOKEN } = env();
  return TOKEN ? { "x-pinodes-orchestra-token": TOKEN } : {};
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** POST JSON, fail-open (resolves false on any error). */
export async function post(path, body, fetchImpl = fetch) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${env().BASE_URL}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

/** POST with small retries — for signals whose loss degrades the pipeline
 *  (turn-ended: a lost one leaves the node busy until the next turn). */
export async function postWithRetry(path, body, retries = 3, delayMs = 250, fetchImpl = fetch) {
  for (let i = 0; i <= retries; i++) {
    if (await post(path, body, fetchImpl)) return true;
    if (i < retries) await sleep(delayMs);
  }
  return false;
}

/** Terminal intent: @@DONE alone on the last non-empty line (not prose mentioning it). */
export function hasExplicitDone(text) {
  for (const line of text.trim().split(/\r?\n/).reverse()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    return /^@@DONE\s*$/.test(trimmed);
  }
  return false;
}

/** All @@HANDOFF blocks in a turn's final text → [{recipient, message}]. */
export function parseHandoffs(text) {
  HANDOFF_RE.lastIndex = 0;
  const out = [];
  let m;
  while ((m = HANDOFF_RE.exec(text)) !== null) {
    const recipient = m[1].trim();
    const message = m[2].trim();
    if (recipient && message) out.push({ recipient, message });
  }
  return out;
}

/** All @@CARD moves in a turn's final text → ["in_progress", …]. */
export function parseCards(text) {
  CARD_RE.lastIndex = 0;
  const out = [];
  let m;
  while ((m = CARD_RE.exec(text)) !== null) {
    const column = m[1].trim();
    if (column) out.push(column);
  }
  return out;
}

/** Text of one transcript message (string or content-parts array). */
function messageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p && typeof p === "object")
      .map((p) => (p.type === "text" ? p.text ?? "" : ""))
      .join("");
  }
  return "";
}

/**
 * The turn's final assistant text from a Claude Code transcript (JSONL).
 * Mirrors pi's `lastAssistantText(messages)`: the LAST assistant entry is the
 * final answer of the agent loop — that is where explicit intent must live.
 */
export function lastAssistantTextFromTranscript(jsonl) {
  const lines = jsonl.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type === "assistant" && entry.message?.role === "assistant") {
      const text = messageText(entry.message);
      if (text.trim()) return text;
    }
  }
  return "";
}

/** Handle one hook invocation. Returns the JSON to print on stdout (or null). */
export async function handleEvent(input, deps = {}) {
  const fetchImpl = deps.fetch ?? fetch;
  const readFile = deps.readFile ?? ((p) => fs.readFileSync(p, "utf8"));
  const event = input?.hook_event_name;
  const { BASE_URL, BOARD_ID, NODE_ID } = env();

  if (event === "SessionStart") {
    await post("/internal/ready", { boardId: BOARD_ID, nodeId: NODE_ID }, fetchImpl);
    return null;
  }

  if (event === "UserPromptSubmit") {
    // Closed-loop submit confirmation: a prompt was submitted → the injected
    // task reached the input line. Disarms the backend's submit watch.
    await post("/internal/turn-started", { boardId: BOARD_ID, nodeId: NODE_ID }, fetchImpl);

    // Per-turn orchestration appendix (recipients, finality, kanban) as
    // additional context — the Claude analog of pi's system-prompt refresh.
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
      const res = await fetchImpl(
        `${BASE_URL}/internal/orchestra-context?boardId=${encodeURIComponent(BOARD_ID)}&nodeId=${encodeURIComponent(NODE_ID)}`,
        { signal: ac.signal, headers: { "cache-control": "no-store", ...authHeaders() } },
      );
      clearTimeout(t);
      if (res.ok) {
        const ctx = await res.json();
        if (ctx?.appendix) {
          return {
            hookSpecificOutput: {
              hookEventName: "UserPromptSubmit",
              additionalContext: String(ctx.appendix),
            },
          };
        }
      }
    } catch {
      /* fail-open: the spawn-time fallback appendix is already in the system prompt */
    }
    return null;
  }

  if (event === "Stop") {
    let text = "";
    try {
      text = lastAssistantTextFromTranscript(readFile(input.transcript_path));
    } catch {
      /* unreadable transcript → still signal turn-ended below */
    }

    let delivered = 0;
    for (const h of parseHandoffs(text)) {
      const ok = await post(
        "/internal/call-agent",
        { boardId: BOARD_ID, fromNodeId: NODE_ID, targetNodeId: h.recipient, message: h.message },
        fetchImpl,
      );
      if (ok) delivered++;
    }
    for (const column of parseCards(text)) {
      await post("/internal/card-status", { boardId: BOARD_ID, column }, fetchImpl);
    }

    // Busy→idle transition + server-side watchdog signal. Retried: a lost
    // turn-ended parks later injects' submit watches forever (silent stall).
    await postWithRetry(
      "/internal/turn-ended",
      { boardId: BOARD_ID, nodeId: NODE_ID, handoffCalledThisTurn: delivered >= 1 },
      3,
      250,
      fetchImpl,
    );
    return null;
  }

  return null;
}

/** Entrypoint: read the hook input JSON from stdin, dispatch, print output. */
async function main() {
  // Self-gate: not an Orchestra-spawned session → do nothing, affect nothing.
  if (!env().NODE_ID) return;
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }
  const output = await handleEvent(input);
  if (output) process.stdout.write(JSON.stringify(output));
}

// Only run when executed directly (not when imported by tests).
import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(() => {
    /* fail-open — a bridge error must never break the agent */
  });
}
