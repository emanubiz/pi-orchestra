import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useOrchestraWs } from "./useOrchestraWs";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useKanbanStore } from "../stores/kanbanStore";
import { onPtyOutput, onPtySize, onNodeReady, onPtyExit } from "../lib/ptyBus";

// ── fake WebSocket ───────────────────────────────────────────────────────────

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;
  url: string;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  /** Test helper: simulate the server opening the connection. */
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  /** Test helper: simulate an incoming server message. */
  receive(msg: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

let instances: FakeWebSocket[] = [];

function lastSocket(): FakeWebSocket {
  const s = instances.at(-1);
  if (!s) throw new Error("no WebSocket instance created");
  return s;
}

describe("useOrchestraWs", () => {
  beforeEach(() => {
    instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    useRuntimeStore.setState({
      connected: false,
      nodeStatus: {},
      chatByNode: {},
      streamBuffer: {},
      nodeError: {},
      enforcement: {},
    });
    useKanbanStore.setState({ cards: [] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function mount(boardId = "b1") {
    return renderHook(() => useOrchestraWs(boardId, [], { n1: "Architect", n2: "Developer" }));
  }

  it("opens a connection on mount and marks the store connected", () => {
    mount();
    const ws = lastSocket();
    act(() => ws.open());
    expect(useRuntimeStore.getState().connected).toBe(true);
  });

  it("marks the store disconnected on close and schedules a reconnect", () => {
    vi.useFakeTimers();
    mount();
    const ws = lastSocket();
    act(() => ws.open());

    act(() => ws.close());
    expect(useRuntimeStore.getState().connected).toBe(false);
    expect(instances).toHaveLength(1);

    act(() => vi.advanceTimersByTime(1500));
    expect(instances).toHaveLength(2); // reconnected
  });

  it("does not reconnect after the hook unmounts", () => {
    vi.useFakeTimers();
    const { unmount } = mount();
    const ws = lastSocket();
    act(() => ws.open());

    unmount();
    act(() => ws.close());
    act(() => vi.advanceTimersByTime(5000));

    expect(instances).toHaveLength(1); // no reconnect after unmount
  });

  it("updates node status for known statuses and defaults unknown ones to idle", () => {
    mount();
    const ws = lastSocket();

    act(() => ws.receive({ type: "node_status", boardId: "b1", nodeId: "n1", status: "running" }));
    expect(useRuntimeStore.getState().nodeStatus["b1:n1"]).toBe("running");

    act(() => ws.receive({ type: "node_status", boardId: "b1", nodeId: "n1", status: "bogus" }));
    expect(useRuntimeStore.getState().nodeStatus["b1:n1"]).toBe("idle");
  });

  it("records a node error and appends a system chat line, then clears it on recovery", () => {
    mount();
    const ws = lastSocket();

    act(() =>
      ws.receive({ type: "node_status", boardId: "b1", nodeId: "n1", status: "error", message: "boom" }),
    );
    expect(useRuntimeStore.getState().nodeError["b1:n1"]).toBe("boom");
    expect(useRuntimeStore.getState().chatByNode["b1:n1"]?.at(-1)).toMatchObject({
      kind: "system",
      text: "boom",
    });

    act(() => ws.receive({ type: "node_status", boardId: "b1", nodeId: "n1", status: "running" }));
    expect(useRuntimeStore.getState().nodeError["b1:n1"]).toBeUndefined();
  });

  it("flushes the stream buffer when a node settles into idle/done/error", () => {
    mount();
    const ws = lastSocket();

    act(() => ws.receive({ type: "stream", boardId: "b1", nodeId: "n1", kind: "text", text: "partial output" }));
    expect(useRuntimeStore.getState().streamBuffer["b1:n1"]).toBe("partial output");

    act(() => ws.receive({ type: "node_status", boardId: "b1", nodeId: "n1", status: "done" }));
    expect(useRuntimeStore.getState().streamBuffer["b1:n1"]).toBeUndefined();
    expect(useRuntimeStore.getState().chatByNode["b1:n1"]?.at(-1)).toMatchObject({
      kind: "stream",
      text: "partial output",
    });
  });

  it("forwards pty_output (with replay size) and pty_size to the ptyBus", () => {
    mount();
    const ws = lastSocket();

    const outputs: Array<[string, boolean]> = [];
    const sizes: Array<[number, number]> = [];
    const offOutput = onPtyOutput("b1:n1", (data, replay) => outputs.push([data, replay]));
    const offSize = onPtySize("b1:n1", (cols, rows) => sizes.push([cols, rows]));

    act(() =>
      ws.receive({ type: "pty_output", boardId: "b1", nodeId: "n1", data: "hello", replay: true, cols: 80, rows: 24 }),
    );

    expect(outputs).toEqual([["hello", true]]);
    expect(sizes).toEqual([[80, 24]]);

    offOutput();
    offSize();
  });

  it("forwards node_ready and pty_exit to the ptyBus", () => {
    mount();
    const ws = lastSocket();

    let ready = false;
    let exitCode: number | null = null;
    const offReady = onNodeReady("b1:n1", () => (ready = true));
    const offExit = onPtyExit("b1:n1", (code) => (exitCode = code));

    act(() => ws.receive({ type: "node_ready", boardId: "b1", nodeId: "n1" }));
    expect(ready).toBe(true);

    act(() => ws.receive({ type: "pty_exit", boardId: "b1", nodeId: "n1", code: 7 }));
    expect(exitCode).toBe(7);

    offReady();
    offExit();
  });

  it("moves the linked kanban card when a recognizable card_status arrives", () => {
    mount();
    const ws = lastSocket();
    useKanbanStore.setState({
      cards: [
        {
          id: "c1",
          title: "t",
          description: "",
          column: "todo",
          linkedBoardId: "b1",
          createdAt: Date.now(),
        },
      ],
    });

    act(() => ws.receive({ type: "card_status", boardId: "b1", column: "in progress" }));
    expect(useKanbanStore.getState().cards[0].column).toBe("in_progress");
  });

  it("appends a user/agent chat line for message_in based on source", () => {
    mount();
    const ws = lastSocket();

    act(() => ws.receive({ type: "message_in", boardId: "b1", nodeId: "n1", source: "user", text: "hi" }));
    act(() => ws.receive({ type: "message_in", boardId: "b1", nodeId: "n1", source: "agent", text: "hello" }));

    const lines = useRuntimeStore.getState().chatByNode["b1:n1"];
    expect(lines?.map((l) => l.kind)).toEqual(["user", "agent"]);
  });

  it("ignores messages scoped to a different board (except connected/card_status)", () => {
    mount();
    const ws = lastSocket();

    act(() => ws.receive({ type: "node_status", boardId: "other", nodeId: "n1", status: "running" }));
    expect(useRuntimeStore.getState().nodeStatus["other:n1"]).toBeUndefined();
  });

  it("send() only writes when the socket is open, tagging the message with the active board", () => {
    const { result } = mount();
    const ws = lastSocket();

    act(() => result.current.send({ type: "pty_input", nodeId: "n1", data: "x" }));
    expect(ws.sent).toHaveLength(0); // not open yet

    act(() => ws.open());
    act(() => result.current.send({ type: "pty_input", nodeId: "n1", data: "x" }));

    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0])).toMatchObject({ boardId: "b1", type: "pty_input", nodeId: "n1", data: "x" });
  });
});
