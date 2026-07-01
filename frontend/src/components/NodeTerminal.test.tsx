import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { NodeTerminal } from "./NodeTerminal";
import { TerminalContext } from "../lib/termTheme";
import { useRuntimeStore } from "../stores/runtimeStore";

// Mock xterm to avoid real DOM operations in tests
vi.mock("@xterm/xterm", () => {
  return {
    Terminal: class {
      cols = 80;
      rows = 24;
      open = vi.fn();
      write = vi.fn();
      reset = vi.fn();
      loadAddon = vi.fn();
      dispose = vi.fn();
    },
  };
});

vi.mock("@xterm/addon-fit", () => {
  return {
    FitAddon: class {
      fit = vi.fn();
    },
  };
});

// Mock ResizeObserver for jsdom
global.ResizeObserver = class {
  observe = vi.fn();
  disconnect = vi.fn();
  unobserve = vi.fn();
} as unknown as typeof ResizeObserver;

function resetStore() {
  useRuntimeStore.setState({
    connected: false,
    activeBoardId: "",
    nodeStatus: {},
    chatByNode: {},
    streamBuffer: {},
    selectedNodeId: null,
    prompts: [],
    runPromptDraft: "",
  });
}

describe("NodeTerminal", () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
  });

  it("does not send attach_node while WebSocket is offline", () => {
    const send = vi.fn();
    render(
      <TerminalContext.Provider value={{ boardId: "b1", send, onExpand: vi.fn(), onDelete: vi.fn(), onEditPrompt: vi.fn(), onToggleFinal: vi.fn() }}>
        <NodeTerminal nodeId="n1" />
      </TerminalContext.Provider>
    );
    expect(send).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "attach_node" })
    );
  });

  it("sends attach_node once WebSocket becomes connected", () => {
    const send = vi.fn();
    render(
      <TerminalContext.Provider value={{ boardId: "b1", send, onExpand: vi.fn(), onDelete: vi.fn(), onEditPrompt: vi.fn(), onToggleFinal: vi.fn() }}>
        <NodeTerminal nodeId="n1" />
      </TerminalContext.Provider>
    );
    expect(send).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "attach_node" })
    );

    act(() => {
      useRuntimeStore.setState({ connected: true });
    });

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "attach_node", nodeId: "n1" })
    );
  });
});
