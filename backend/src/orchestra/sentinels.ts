/** Shared sentinel parsing for Orchestra handoffs. Keep regexes aligned with
 *  backend/pi-extensions/call-agent.ts and backend/claude-hooks/orchestra-hook.mjs. */

export const HANDOFF_RE = /@@HANDOFF:\s*([^\s\n]+)\s*\n([\s\S]*?)@@END/g;
export const CARD_RE = /@@CARD:\s*([^\s\n]+)/g;

export interface ParsedHandoff {
  recipient: string;
  message: string;
}

/** Terminal intent: @@DONE alone on the last non-empty line (not prose mentioning it). */
export function hasExplicitDone(text: string): boolean {
  for (const line of text.trim().split(/\r?\n/).reverse()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    return /^@@DONE\s*$/.test(trimmed);
  }
  return false;
}

/** All @@HANDOFF blocks in a turn's final text. */
export function parseHandoffs(text: string): ParsedHandoff[] {
  HANDOFF_RE.lastIndex = 0;
  const out: ParsedHandoff[] = [];
  let m: RegExpExecArray | null;
  while ((m = HANDOFF_RE.exec(text)) !== null) {
    const recipient = m[1].trim();
    const message = m[2].trim();
    if (recipient && message) out.push({ recipient, message });
  }
  return out;
}

/** All @@CARD moves in a turn's final text. */
export function parseCards(text: string): string[] {
  CARD_RE.lastIndex = 0;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = CARD_RE.exec(text)) !== null) {
    const column = m[1].trim();
    if (column) out.push(column);
  }
  return out;
}
