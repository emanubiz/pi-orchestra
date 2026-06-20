import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { onNodeReady, onPtyOutput, onPtySize } from "../lib/ptyBus";
import { TERM_FONT, TERM_THEME, useTerminalBridge } from "../lib/termTheme";
import { useRuntimeStore } from "../stores/runtimeStore";

/** Live, read-only mini view of a node's pi terminal, embedded in its card. */
export function NodeTerminal({ nodeId, restarting }: { nodeId: string; restarting?: boolean }) {
  const { boardId, send } = useTerminalBridge();
  const cardRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const [live, setLive] = useState(false);
  const connected = useRuntimeStore((s) => s.connected);

  useEffect(() => {
    const card = cardRef.current;
    const host = hostRef.current;
    if (!card || !host || !connected) return;
    const key = `${boardId}:${nodeId}`;

    const term = new Terminal({
      disableStdin: true,
      cursorBlink: false,
      fontSize: 11,
      lineHeight: 1.15,
      fontFamily: TERM_FONT,
      theme: TERM_THEME,
      allowTransparency: true,
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
    //
    // We must scale by the TERMINAL GRID width, not the `.xterm` element width:
    // `.xterm` stretches to fill its container, so measuring it yields the card
    // width and the scale collapses to ~1 (the old "only fills part of the card"
    // bug). `.xterm-screen` is sized to `cols × cellWidth` — the real content.
    const rescale = () => {
      const cardW = card.clientWidth;
      const screenEl = host.querySelector(".xterm-screen") as HTMLElement | null;
      const natW = screenEl?.offsetWidth ?? 0;
      if (!cardW || !natW) return;
      const scale = cardW / natW;
      host.style.transformOrigin = "top left";
      host.style.transform = `scale(${scale})`;
    };

    // Two frames: one for xterm to relayout after a resize/write, one to measure.
    const scheduleRescale = () =>
      requestAnimationFrame(() => requestAnimationFrame(rescale));

    const applySize = (cols: number, rows: number) => {
      if (cols > 0 && rows > 0 && (cols !== term.cols || rows !== term.rows)) {
        term.resize(cols, rows);
      }
      scheduleRescale();
    };

    const unsubSize = onPtySize(key, applySize);
    const unsub = onPtyOutput(key, (data, replay) => {
      if (replay) term.reset();
      term.write(data, scheduleRescale);
    });

    // Clear the "starting pi…" overlay only once pi has actually booted (its
    // extension reported session_start → backend `node_ready`). We can't key off
    // the first PTY byte: on Windows ConPTY emits terminal-init escapes before pi
    // is up, which would hide the overlay too early — the very inconsistency this
    // fixes between Linux and Windows.
    const unsubReady = onNodeReady(key, () => setLive(true));
    // Safety net: if pi never reports ready (an old pi without session_start, or
    // the extension failing to load), reveal the terminal anyway so the overlay
    // can't hang forever. Comfortably above the backend's 10s inject fallback.
    const readyFallback = window.setTimeout(() => setLive(true), 15_000);

    // Boot the node's pi on board load (spawn:true) so cards come alive without
    // opening the side panel — but resize:false keeps the interactive terminal
    // the sole owner of the shared PTY's dimensions.
    send({ type: "attach_node", nodeId, cols: 80, rows: 24, spawn: true, resize: false });

    const ro = new ResizeObserver(scheduleRescale);
    ro.observe(card);
    scheduleRescale();

    return () => {
      ro.disconnect();
      unsub();
      unsubSize();
      unsubReady();
      window.clearTimeout(readyFallback);
      term.dispose();
      termRef.current = null;
    };
  }, [boardId, nodeId, send, connected]);

  // pointer-events off so dragging/clicking the node still works through it.
  return (
    <div ref={cardRef} className="node-terminal-mirror relative h-full w-full overflow-hidden bg-black">
      {/* width:max-content so `.xterm` shrinks to the grid; we scale this box. */}
      <div ref={hostRef} style={{ pointerEvents: "none", width: "max-content" }} />
      {!live && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[10px] text-zinc-600">
          starting pi…
        </div>
      )}
      {restarting && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-1.5 bg-black/60 backdrop-blur-[1px]">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400 animate-ping" />
          <span className="text-[10px] font-medium tracking-wide text-amber-400/90">
            restarting pi…
          </span>
        </div>
      )}
    </div>
  );
}
