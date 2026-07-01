import { describe, expect, it, vi, beforeEach } from "vitest";
import type { WebSocket } from "@fastify/websocket";

const { setGraph, enforcementOverrides } = vi.hoisted(() => ({
  setGraph: vi.fn(),
  enforcementOverrides: vi.fn(() => [] as Array<{ nodeId: string; enabled: boolean }>),
}));

vi.mock("../pty/PtyHub.js", () => ({
  ptyHub: {
    setBroadcast: vi.fn(),
    setGraph,
    enforcementOverrides,
    ensure: vi.fn(() => ""),
    size: vi.fn(),
    isReady: vi.fn(() => false),
    input: vi.fn(),
    injectTask: vi.fn(),
    setKanbanTracked: vi.fn(),
    setEnforcement: vi.fn(),
    resize: vi.fn(),
    restart: vi.fn(),
    kill: vi.fn(),
    killBoard: vi.fn(),
  },
}));

import { attachWebSocket } from "./handler.js";

function createHarness() {
  const sent: string[] = [];
  let messageHandler: ((raw: Buffer) => void) | undefined;
  const ws = {
    readyState: 1,
    send(payload: string) {
      sent.push(payload);
    },
    on(event: string, fn: (raw: Buffer) => void) {
      if (event === "message") messageHandler = fn;
      return ws;
    },
    close: vi.fn(),
  } as unknown as WebSocket;

  attachWebSocket(ws);

  return {
    sent,
    emit(msg: unknown) {
      messageHandler?.(Buffer.from(JSON.stringify(msg)));
    },
  };
}

describe("ws/handler load_graph", () => {
  beforeEach(() => {
    setGraph.mockClear();
  });

  it("rejects load_graph when cwd does not exist", () => {
    const h = createHarness();
    h.emit({
      type: "load_graph",
      graph: { name: "x", nodes: [], edges: [] },
      cwd: "/path/that/does/not/exist-xyz",
    });
    expect(setGraph).not.toHaveBeenCalled();
    const err = JSON.parse(h.sent.at(-1)!) as { type: string; message: string };
    expect(err.type).toBe("error");
    expect(err.message).toContain("Not a valid directory");
  });

  it("calls setGraph when cwd is valid", () => {
    const h = createHarness();
    h.emit({
      type: "load_graph",
      graph: { name: "x", nodes: [], edges: [] },
      cwd: "/tmp",
    });
    expect(setGraph).toHaveBeenCalledOnce();
    expect(h.sent.some((s) => s.includes('"type":"connected"'))).toBe(true);
  });

  it("sends runtime capabilities on connect", () => {
    const prev = process.env.PINODES_ORCHESTRA_HERMES;
    process.env.PINODES_ORCHESTRA_HERMES = "true";
    try {
      const h = createHarness();
      const connected = JSON.parse(h.sent[0]!) as {
        type: string;
        runtimes?: { hermes?: boolean };
      };
      expect(connected.type).toBe("connected");
      expect(connected.runtimes?.hermes).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.PINODES_ORCHESTRA_HERMES;
      else process.env.PINODES_ORCHESTRA_HERMES = prev;
    }
  });
});
