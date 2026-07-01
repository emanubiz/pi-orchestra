import { useCallback, useEffect, useRef } from "react";
import { useRuntimeStore } from "../stores/runtimeStore";
import { emitNodeReady, emitPtyExit, emitPtyOutput, emitPtySize } from "../lib/ptyBus";
import { normalizeColumn, useKanbanStore } from "../stores/kanbanStore";
import { wsUrl } from "../lib/api";
import { useTimelineCapture } from "./useTimelineCapture";

export function useOrchestraWs(
  activeBoardId: string,
  // TODO: `_edges` is unused — the timeline now derives handoffs from the
  // canonical backend `handoff` event, not from edge inference. Drop this param
  // (and the `boardEdges` memo in App.tsx that feeds it) on the next cleanup.
  _edges: Array<{ source: string; target: string }>,
  nodeLabels: Record<string, string>,
) {
  const wsRef = useRef<WebSocket | null>(null);
  const boardRef = useRef(activeBoardId);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unmountedRef = useRef(false);
  boardRef.current = activeBoardId;

  const captureMessage = useTimelineCapture(activeBoardId, nodeLabels);
  const captureRef = useRef(captureMessage);
  captureRef.current = captureMessage;

  const {
    setConnected,
    setHermesAvailable,
    setNodeStatus,
    setNodeError,
    clearNodeError,
    setEnforcement,
    appendChat,
    appendStream,
    flushStream,
  } = useRuntimeStore();

  useEffect(() => {
    unmountedRef.current = false;

    const connect = () => {
      if (unmountedRef.current) return;
      const ws = new WebSocket(wsUrl());
      wsRef.current = ws;

      ws.onopen = () => setConnected(true);

      ws.onclose = () => {
        setConnected(false);
        wsRef.current = null;
        if (!unmountedRef.current) {
          reconnectRef.current = setTimeout(connect, 1500);
        }
      };

      ws.onerror = (ev) => {
        console.error("pinodes-orchestra: WebSocket error", ev);
        // onclose will handle reconnect
      };

      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data) as Record<string, unknown>;
        const boardId = (msg.boardId as string) || boardRef.current;
        if (
          boardId !== boardRef.current &&
          msg.type !== "connected" &&
          msg.type !== "card_status"
        )
          return;

        captureRef.current(msg);

        switch (msg.type) {
          case "connected":
            setConnected(true);
            if (msg.runtimes && typeof msg.runtimes === "object") {
              const rt = msg.runtimes as Record<string, unknown>;
              if (typeof rt.hermes === "boolean") setHermesAvailable(rt.hermes);
            }
            break;
          case "node_status":
            const rawStatus = msg.status as string;
            const validStatus =
              rawStatus === "idle" || rawStatus === "running" || rawStatus === "done" || rawStatus === "error"
                ? rawStatus
                : "idle";
            setNodeStatus(boardId, msg.nodeId as string, validStatus);
            if (msg.status === "error" && msg.message) {
              setNodeError(boardId, msg.nodeId as string, msg.message as string);
              appendChat(boardId, {
                nodeId: msg.nodeId as string,
                kind: "system",
                text: msg.message as string,
              });
            } else {
              clearNodeError(boardId, msg.nodeId as string);
            }
            if (["idle", "done", "error"].includes(msg.status as string)) {
              flushStream(boardId, msg.nodeId as string);
            }
            break;
          case "pty_output":
            // A replay carries the PTY's real size so mirrors render faithfully.
            if (typeof msg.cols === "number" && typeof msg.rows === "number") {
              emitPtySize(
                `${boardId}:${msg.nodeId as string}`,
                msg.cols as number,
                msg.rows as number,
              );
            }
            emitPtyOutput(
              `${boardId}:${msg.nodeId as string}`,
              msg.data as string,
              Boolean(msg.replay),
            );
            break;
          case "pty_size":
            emitPtySize(
              `${boardId}:${msg.nodeId as string}`,
              msg.cols as number,
              msg.rows as number,
            );
            break;
          case "node_ready":
            emitNodeReady(`${boardId}:${msg.nodeId as string}`);
            break;
          case "enforcement":
            setEnforcement(boardId, msg.nodeId as string, msg.enabled !== false);
            break;
          case "pty_exit":
            emitPtyExit(`${boardId}:${msg.nodeId as string}`, (msg.code as number) ?? 0);
            break;
          case "card_status": {
            const col = normalizeColumn(msg.column as string);
            if (col) useKanbanStore.getState().moveCardByBoard(boardId, col);
            break;
          }
          case "stream": {
            const kind = msg.kind as string;
            if (kind === "text" || kind === "thinking") {
              appendStream(boardId, msg.nodeId as string, msg.text as string);
            } else if (kind === "tool_start") {
              appendChat(boardId, {
                nodeId: msg.nodeId as string,
                kind: "tool",
                text: `tool_start ${msg.text}`,
              });
            } else if (kind === "tool_end") {
              appendChat(boardId, {
                nodeId: msg.nodeId as string,
                kind: "tool",
                text: `tool_end ${msg.text}`,
              });
            }
            break;
          }
          case "message_in":
            appendChat(boardId, {
              nodeId: msg.nodeId as string,
              kind: msg.source === "user" ? "user" : "agent",
              text: msg.text as string,
            });
            break;
          case "turn_end":
            flushStream(boardId, msg.nodeId as string);
            break;
          case "error":
            appendChat(boardId, {
              nodeId: (msg.nodeId as string) ?? "system",
              kind: "system",                text: `error ${msg.message}`,
            });
            break;
        }
      };
    };

    connect();

    return () => {
      unmountedRef.current = true;
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      wsRef.current?.close();
      wsRef.current = null;
      setConnected(false);
    };
  }, [setConnected, setHermesAvailable, setNodeStatus, setNodeError, clearNodeError, setEnforcement, appendChat, appendStream, flushStream]);

  // Stable identity: relies only on refs, so consumers (e.g. the terminal)
  // don't tear down on every render.
  const send = useCallback((msg: Record<string, unknown>) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      // Default to the active board, but let callers target another board explicitly.
      wsRef.current.send(JSON.stringify({ boardId: boardRef.current, ...msg }));
    }
  }, []);

  return { send };
}
