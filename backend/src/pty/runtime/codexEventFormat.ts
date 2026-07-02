/** Format `codex exec --json` JSONL events as terminal-safe text for xterm. */

interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  status?: string;
  message?: string;
}

interface CodexEvent {
  type?: string;
  thread_id?: string;
  item?: CodexItem;
  message?: string;
}

const DIM = "\x1b[90m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

function formatItem(item: CodexItem, phase: "started" | "updated" | "completed"): string | null {
  const kind = item.type ?? "unknown";
  switch (kind) {
    case "agent_message":
      if (phase === "completed" && item.text) return item.text + (item.text.endsWith("\n") ? "" : "\n");
      return null;
    case "command_execution": {
      const cmd = item.command ?? "(command)";
      if (phase === "started") return `${DIM}▶ ${cmd}${RESET}\n`;
      if (phase === "completed") {
        const status = item.status ?? "completed";
        return `${DIM}■ ${cmd} (${status})${RESET}\n`;
      }
      return null;
    }
    case "file_change":
      if (phase === "completed") return `${DIM}📝 file change (${item.status ?? "done"})${RESET}\n`;
      return null;
    case "mcp_tool_call":
      if (phase === "started") return `${DIM}⚙ mcp: ${item.command ?? item.id ?? "tool"}${RESET}\n`;
      if (phase === "completed") return `${DIM}✓ mcp done${RESET}\n`;
      return null;
    case "reasoning":
      if (phase === "completed" && item.text) return `${DIM}${item.text}${RESET}\n`;
      return null;
    default:
      return null;
  }
}

/** Returns terminal text to emit, or null when the event is silent/metadata-only. */
export function formatCodexEvent(raw: CodexEvent): string | null {
  switch (raw.type) {
    case "thread.started":
      return null;
    case "turn.started":
      return null;
    case "turn.completed":
      return null;
    case "turn.failed":
      return `${RED}[turn failed] ${raw.message ?? "unknown error"}${RESET}\n`;
    case "item.started":
      return raw.item ? formatItem(raw.item, "started") : null;
    case "item.updated":
      return raw.item ? formatItem(raw.item, "updated") : null;
    case "item.completed":
      return raw.item ? formatItem(raw.item, "completed") : null;
    case "error": {
      const msg = raw.message ?? "error";
      if (/reconnecting/i.test(msg)) return `${DIM}${msg}${RESET}\n`;
      return `${RED}[error] ${msg}${RESET}\n`;
    }
    default:
      return null;
  }
}

/** Extract thread id from a parsed event, if present. */
export function extractThreadId(raw: CodexEvent): string | undefined {
  if (raw.type === "thread.started" && typeof raw.thread_id === "string") {
    return raw.thread_id;
  }
  return undefined;
}

/** Collect final assistant text from completed agent_message items. */
export function extractAssistantText(raw: CodexEvent, current: string): string {
  if (raw.type !== "item.completed") return current;
  const item = raw.item;
  if (item?.type === "agent_message" && item.text) return item.text;
  return current;
}

/** Parse one JSONL line; returns null on blank/invalid lines. */
export function parseCodexJsonLine(line: string): CodexEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as CodexEvent;
  } catch {
    return null;
  }
}
