import { useEffect, useState } from "react";
import { onNodeReady } from "../lib/ptyBus";

/** Fallback if node_ready never arrives after a restart. */
const RESTART_TIMEOUT_MS = 30_000;

export function usePiRestartState(boardId: string, nodeId: string | undefined | null) {
  const [restarting, setRestarting] = useState(false);

  useEffect(() => {
    if (!restarting || !nodeId) return;
    const key = `${boardId}:${nodeId}`;
    const unsub = onNodeReady(key, () => setRestarting(false));
    const timer = window.setTimeout(() => setRestarting(false), RESTART_TIMEOUT_MS);
    return () => {
      unsub();
      window.clearTimeout(timer);
    };
  }, [boardId, nodeId, restarting]);

  return [restarting, setRestarting] as const;
}

export function confirmPiRestart(opts: { label: string; running: boolean }): boolean {
  const { label, running } = opts;
  const msg = running
    ? `Node "${label}" is running. Restart pi anyway? It will be killed and respawned.`
    : `Restart pi for node "${label}"? It will pick up config, prompt, and extension changes.`;
  return window.confirm(msg);
}
