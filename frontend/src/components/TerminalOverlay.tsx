import { useEffect, useRef } from "react";
import { RotateCw, Square, X } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { onPtyExit, onPtyOutput } from "../lib/ptyBus";
import { confirmPiRestart, usePiRestartState } from "../hooks/usePiRestartState";
import { useRuntimeStore } from "../stores/runtimeStore";
import { TERM_FONT, TERM_THEME } from "../lib/termTheme";
import { fitWhenReady } from "../lib/termFit";
import { attachClipboard } from "../lib/termClipboard";

interface TerminalOverlayProps {
  boardId: string;
  nodeId: string;
  label: string;
  send: (msg: Record<string, unknown>) => void;
  onClose: () => void;
}

/** Full-screen interactive pi terminal for a single node. */
export function TerminalOverlay({ boardId, nodeId, label, send, onClose }: TerminalOverlayProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const status = useRuntimeStore((s) => s.nodeStatus[`${boardId}:${nodeId}`]);
  const [restarting, setRestarting] = usePiRestartState(boardId, nodeId);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const key = `${boardId}:${nodeId}`;

    const term = new Terminal({
      fontSize: 13,
      lineHeight: 1.2,
      fontFamily: TERM_FONT,
      theme: TERM_THEME,
      allowTransparency: true,
      cursorBlink: true,
      scrollback: 8000,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);

    const unsubOut = onPtyOutput(key, (data, replay) => {
      if (replay) term.reset();
      term.write(data);
    });
    const unsubExit = onPtyExit(key, () => {
      term.write("\r\n\x1b[2m- pi session ended - use Restart -\x1b[0m\r\n");
    });
    const onData = term.onData((data) => send({ type: "pty_input", nodeId, data }));
    const detachClipboard = attachClipboard(term, host);

    // Attach immediately with a safe default size; resize once the overlay is
    // laid out so the PTY is never at 1 column.
    send({ type: "attach_node", nodeId, cols: 80, rows: 24 });

    const unsubscribeFit = fitWhenReady(term, fit, host, (cols, rows) => {
      send({ type: "pty_resize", nodeId, cols, rows });
    });

    term.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);

    return () => {
      window.removeEventListener("keydown", onKey);
      detachClipboard();
      unsubscribeFit();
      onData.dispose();
      unsubOut();
      unsubExit();
      term.dispose();
    };
  }, [boardId, nodeId, send, onClose]);

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-6"
      onClick={onClose}
    >
      <div
        className="flex h-full w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#09090b] shadow-2xl shadow-black/60"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-white/5 px-4 py-2 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-medium text-zinc-200 truncate">{label}</span>
            <span className="text-xs font-mono text-zinc-500">{nodeId.slice(0, 8)}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={restarting}
              onClick={() => {
                if (restarting) return;
                if (!confirmPiRestart({ label, running: status === "running" })) return;
                setRestarting(true);
                send({ type: "restart_node", nodeId });
              }}
              className={`flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-md border transition-colors ${
                restarting
                  ? "bg-amber-500/10 border-amber-500/20 text-amber-400/80 animate-pulse cursor-not-allowed"
                  : "bg-white/5 border-white/10 text-zinc-300 hover:bg-white/10"
              }`}
            >
              <RotateCw size={11} strokeWidth={2} className={restarting ? "animate-spin" : ""} />
              Restart
            </button>
            <button
              type="button"
              onClick={() => send({ type: "abort_node", nodeId })}
              className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-md bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20"
            >
              <Square size={10} strokeWidth={2} fill="currentColor" />
              Stop
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded p-1 text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-200"
              title="Close (Esc)"
            >
              <X size={14} strokeWidth={2} />
            </button>
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-hidden p-2">
          <div ref={hostRef} className="h-full w-full" />
        </div>
      </div>
    </div>
  );
}
