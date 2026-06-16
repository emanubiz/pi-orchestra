import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { onPtyOutput, onPtySize } from "../lib/ptyBus";
import { TERM_FONT, TERM_THEME, useTerminalBridge } from "../lib/termTheme";
import { useRuntimeStore } from "../stores/runtimeStore";

/** Live, read-only mini view of a node's pi terminal, embedded in its card. */
export function NodeTerminal({ nodeId }: { nodeId: string }) {
  const { boardId, send } = useTerminalBridge();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const [live, setLive] = useState(false);
  const connected = useRuntimeStore((s) => s.connected);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !connected) return;
    const key = `${boardId}:${nodeId}`;

    const term = new Terminal({
      disableStdin: true,
      cursorBlink: false,
      fontSize: 11,
      lineHeight: 1.15,
      fontFamily: TERM_FONT,
      theme: TERM_THEME,
      scrollback: 800,
      convertEol: false,
      minimumContrastRatio: 1,
    });
    term.open(host);
    termRef.current = term;

    // pi is a full-screen TUI that emits absolute-cursor escape sequences sized
    // for the shared PTY (owned by the interactive panel/overlay). Replaying that
    // stream into a grid of a DIFFERENT size garbles it (the infamous staircase).
    // So we render the mirror at the PTY's exact cols/rows and scale it down with
    // CSS to fit the card — faithful, just smaller.
    const xtermEl = host.querySelector(".xterm") as HTMLElement | null;
    const rescale = () => {
      if (!xtermEl) return;
      const natW = xtermEl.offsetWidth;
      const natH = xtermEl.offsetHeight;
      if (!natW || !natH || !host.clientWidth || !host.clientHeight) return;
      const scale = Math.min(host.clientWidth / natW, host.clientHeight / natH);
      xtermEl.style.transformOrigin = "top left";
      xtermEl.style.transform = `scale(${scale})`;
    };

    const applySize = (cols: number, rows: number) => {
      if (cols > 0 && rows > 0 && (cols !== term.cols || rows !== term.rows)) {
        term.resize(cols, rows);
      }
      // Let xterm relayout, then measure and scale.
      requestAnimationFrame(rescale);
    };

    const unsubSize = onPtySize(key, applySize);
    const unsub = onPtyOutput(key, (data, replay) => {
      if (replay) term.reset();
      if (data.length > 0) setLive(true);
      term.write(data, () => requestAnimationFrame(rescale));
    });

    // Attach only to receive scrollback/replay (and the PTY size). Do NOT resize
    // the shared PTY: the interactive terminal owns the dimensions.
    send({ type: "attach_node", nodeId, cols: 80, rows: 24, spawn: false });

    const ro = new ResizeObserver(() => rescale());
    ro.observe(host);
    requestAnimationFrame(rescale);

    return () => {
      ro.disconnect();
      unsub();
      unsubSize();
      term.dispose();
      termRef.current = null;
    };
  }, [boardId, nodeId, send, connected]);

  // pointer-events off so dragging/clicking the node still works through it.
  return (
    <div className="relative h-full w-full overflow-hidden">
      <div ref={hostRef} className="h-full w-full" style={{ pointerEvents: "none" }} />
      {!live && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[10px] text-zinc-600">
          starting pi…
        </div>
      )}
    </div>
  );
}
