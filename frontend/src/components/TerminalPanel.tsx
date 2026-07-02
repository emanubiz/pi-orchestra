import { useEffect, useRef } from "react";
import { RotateCw, Square } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { Node } from "@xyflow/react";
import "@xterm/xterm/css/xterm.css";
import { useRuntimeStore } from "../stores/runtimeStore";
import { confirmPiRestart, usePiRestartState } from "../hooks/usePiRestartState";
import { onPtyExit, onPtyOutput } from "../lib/ptyBus";
import { fitWhenReady } from "../lib/termFit";
import { TERM_FONT, TERM_THEME } from "../lib/termTheme";
import { attachClipboard } from "../lib/termClipboard";
import {
  isStructuredRuntime,
  runtimeSessionEndedLabel,
  STRUCTURED_INPUT_HINT,
} from "../lib/runtimeKind";
import type { WorkflowNodeData } from "../types";

interface TerminalPanelProps {
  boardId: string;
  send: (msg: Record<string, unknown>) => void;
  getSelectedNode: () => Node<WorkflowNodeData> | undefined;
}


export function TerminalPanel({ boardId, send, getSelectedNode }: TerminalPanelProps) {
  const selectedNodeId = useRuntimeStore((s) => s.selectedNodeId);
  const node = selectedNodeId ? getSelectedNode() : undefined;
  const runtime = node?.data.runtime ?? "pi";
  const structured = isStructuredRuntime(runtime);
  const status = useRuntimeStore((s) =>
    selectedNodeId ? s.nodeStatus[`${boardId}:${selectedNodeId}`] : undefined,
  );
  const [restarting, setRestarting] = usePiRestartState(boardId, selectedNodeId);
  const overlayNodeId = useRuntimeStore((s) => s.overlayNodeId);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!selectedNodeId || !host) return;
    const key = `${boardId}:${selectedNodeId}`;

    const term = new Terminal({
      convertEol: structured,
      disableStdin: structured,
      fontSize: 12.5,
      lineHeight: 1.15,
      fontFamily: TERM_FONT,
      theme: TERM_THEME,
      allowTransparency: true,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;

    const unsubOut = onPtyOutput(key, (data, replay) => {
      if (replay) term.reset();
      term.write(data);
    });
    const unsubExit = onPtyExit(key, () => {
      term.write(`\r\n\x1b[2m${runtimeSessionEndedLabel(runtime)}\x1b[0m\r\n`);
    });

    const onData = structured
      ? null
      : term.onData((data) => send({ type: "pty_input", nodeId: selectedNodeId, data }));
    const detachClipboard = attachClipboard(term, host);

    // Attach immediately with a safe default size so a brand-new PTY is never
    // spawned at 1 column while the sidebar is still being laid out. resize:false
    // so we don't bounce an already-running PTY to this placeholder width — the
    // real width is set by the fit below (and reclaimed when the overlay closes).
    send({ type: "attach_node", nodeId: selectedNodeId, cols: 80, rows: 24, resize: false });

    const unsubscribeFit = fitWhenReady(
      term,
      fit,
      host,
      structured ? () => {} : (cols, rows) => {
        send({ type: "pty_resize", nodeId: selectedNodeId, cols, rows });
      },
    );

    term.focus();

    return () => {
      detachClipboard();
      unsubscribeFit();
      onData?.dispose();
      unsubOut();
      unsubExit();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [boardId, selectedNodeId, send, runtime, structured]);

  // The side panel and the full-screen overlay share ONE pi PTY. While the
  // overlay is open it sizes that PTY to its own (much wider) width. When the
  // overlay closes, this panel stays mounted — its host width never changed, so
  // the fit ResizeObserver never fires — and the PTY is left at the overlay's
  // width. pi then keeps drawing at that width while the panel renders far
  // fewer columns, so the input line wraps on every keystroke (the staircase).
  // Reclaim the PTY at the panel's real width whenever the overlay is not
  // showing this node.
  useEffect(() => {
    if (!selectedNodeId || overlayNodeId === selectedNodeId) return;
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    const id = requestAnimationFrame(() => {
      try {
        fit.fit();
      } catch {
        return;
      }
      if (term.cols > 0 && term.rows > 0 && !structured) {
        send({ type: "pty_resize", nodeId: selectedNodeId, cols: term.cols, rows: term.rows });
      }
    });
    return () => cancelAnimationFrame(id);
  }, [overlayNodeId, selectedNodeId, send, structured]);

  if (!selectedNodeId) {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--app-bg)] text-sm text-zinc-600 p-4 text-center">
        Select a node to open its pi terminal
      </div>
    );
  }

  const running = status === "running";

  return (
    <div className="flex h-full flex-col bg-[var(--app-bg)]">
      <div className="flex items-center justify-between border-b border-white/5 px-3 py-1.5 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={`h-1.5 w-1.5 rounded-full shrink-0 ${
              running ? "bg-emerald-400 live-dot" : "bg-zinc-600"
            }`}
          />
          <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-zinc-500">
            {runtime}
          </span>
          <span className="text-xs font-mono text-zinc-400 truncate">
            {selectedNodeId.slice(0, 8)}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            disabled={restarting}
            onClick={() => {
              if (restarting) return;
              if (!confirmPiRestart({ label: "this node", running: status === "running" })) return;
              setRestarting(true);
              send({ type: "restart_node", nodeId: selectedNodeId });
            }}
            className={`flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-md border transition-colors ${
              restarting
                ? "bg-amber-500/10 border-amber-500/20 text-amber-400/80 animate-pulse cursor-not-allowed"
                : "bg-white/5 border-white/10 text-zinc-300 hover:bg-white/10"
            }`}
            title={restarting ? `Restarting ${runtime}…` : `Restart the ${runtime} session`}
          >
            <RotateCw size={11} strokeWidth={2} className={restarting ? "animate-spin" : ""} />
            Restart
          </button>
          <button
            type="button"
            onClick={() => send({ type: "abort_node", nodeId: selectedNodeId })}
            className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-md bg-red-500/10 text-red-400 border border-red-500/20 transition-colors hover:bg-red-500/20"
            title="End the session"
          >
            <Square size={10} strokeWidth={2} fill="currentColor" />
            Stop
          </button>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-hidden px-1.5 py-1">
        {structured && (
          <p className="mb-1 px-1 text-[10px] leading-snug text-sky-400/80">{STRUCTURED_INPUT_HINT}</p>
        )}
        <div ref={hostRef} className="h-full w-full" />
      </div>
    </div>
  );
}
