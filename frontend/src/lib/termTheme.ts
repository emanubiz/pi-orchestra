import { createContext, useContext } from "react";

export const TERM_THEME = {
  // Transparent so the terminal inherits its themed container background
  // (`--app-bg`), which follows the VS Code theme when embedded.
  background: "rgba(0,0,0,0)",
  foreground: "#e4e4e7",
  cursor: "#a78bfa",
  cursorAccent: "#09090b",
  selectionBackground: "rgba(139,92,246,0.35)",
  black: "#18181b",
  brightBlack: "#52525b",
};

export const TERM_FONT =
  "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";

export interface TerminalBridge {
  boardId: string;
  send: (msg: Record<string, unknown>) => void;
  onExpand: (nodeId: string) => void;
  onDelete: (nodeId: string) => void;
  /** Open the system-prompt viewer/editor for a node. */
  onEditPrompt: (nodeId: string) => void;
  /** Flip whether a node is allowed to end the chain. */
  onToggleFinal: (nodeId: string) => void;
}

export const TerminalContext = createContext<TerminalBridge | null>(null);

export function useTerminalBridge(): TerminalBridge {
  const ctx = useContext(TerminalContext);
  if (!ctx) throw new Error("TerminalContext not available");
  return ctx;
}
