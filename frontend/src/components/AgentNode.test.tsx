import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, screen } from "@testing-library/react";
import { Position } from "@xyflow/react";
import { AgentNode } from "./AgentNode";
import { TerminalContext } from "../lib/termTheme";
import { useRuntimeStore } from "../stores/runtimeStore";
import { emitNodeReady } from "../lib/ptyBus";
import type { NodeStatus, WorkflowNodeData } from "../types";

// Mock @xyflow/react Handle so it doesn't require ReactFlowProvider
vi.mock("@xyflow/react", () => ({
  Handle: () => null,
  Position: { Left: "left", Right: "right" },
}));

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
    connected: true,
    activeBoardId: "b1",
    nodeStatus: {},
    enforcement: {},
    chatByNode: {},
    streamBuffer: {},
    nodeError: {},
    selectedNodeId: null,
    overlayNodeId: null,
    prompts: [],
    runPromptDraft: "",
    hermesAvailable: null,
  });
}

const baseData = {
  label: "Developer",
  promptId: "p1",
  status: "idle" as NodeStatus,
};

const terminalCtx = {
  boardId: "b1",
  send: vi.fn(),
  onExpand: vi.fn(),
  onDelete: vi.fn(),
  onEditPrompt: vi.fn(),
  onToggleFinal: vi.fn(),
};

describe("AgentNode — refresh button", () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function renderNode(data: typeof baseData = baseData) {
    return render(
      <TerminalContext.Provider value={terminalCtx}>
        <AgentNode
          id="n1"
          data={data}
          selected={false}
          type="agent"
          dragging={false}
          zIndex={0}
          selectable
          deletable
          draggable
          isConnectable
          positionAbsoluteX={0}
          positionAbsoluteY={0}
          targetPosition={Position.Left}
          sourcePosition={Position.Right}
        />
      </TerminalContext.Provider>,
    );
  }

  it("renders a refresh button with the default title", () => {
    renderNode();
    const btn = screen.getByTitle("Restart pi (pick up config/extension changes)");
    expect(btn).toBeTruthy();
  });

  it("shows a confirm dialog on click and does nothing on cancel", () => {
    const confirm = vi.fn(() => false);
    vi.spyOn(window, "confirm").mockImplementation(confirm);

    renderNode();
    const btn = screen.getByTitle("Restart pi (pick up config/extension changes)");
    btn.click();

    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining("Restart pi"),
    );
    expect(terminalCtx.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "restart_node" }),
    );
  });

  it("mentions running state in the confirm when the node is running", () => {
    const confirm = vi.fn(() => false);
    vi.spyOn(window, "confirm").mockImplementation(confirm);

    renderNode({ ...baseData, status: "running" });
    const btn = screen.getByTitle("Restart pi (pick up config/extension changes)");
    btn.click();

    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining("running"),
    );
    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining("kill"),
    );
  });

  it("does not mention running in the confirm when the node is idle", () => {
    const confirm = vi.fn(() => false);
    vi.spyOn(window, "confirm").mockImplementation(confirm);

    renderNode({ ...baseData, status: "idle" });
    const btn = screen.getByTitle("Restart pi (pick up config/extension changes)");
    btn.click();

    expect(confirm).toHaveBeenCalledWith(
      expect.not.stringContaining("running"),
    );
  });

  it("sends restart_node via WebSocket when confirmed", () => {
    vi.spyOn(window, "confirm").mockImplementation(() => true);

    renderNode();
    const btn = screen.getByTitle("Restart pi (pick up config/extension changes)");
    act(() => { btn.click(); });

    expect(terminalCtx.send).toHaveBeenCalledWith({
      type: "restart_node",
      nodeId: "n1",
    });
  });

  it("shows 'Restarting pi…' title and disables the button while restarting", () => {
    vi.spyOn(window, "confirm").mockImplementation(() => true);

    renderNode();
    const btn = screen.getByTitle("Restart pi (pick up config/extension changes)");
    act(() => { btn.click(); });

    // After confirm, the button should now show the restarting title
    const restartingBtn = screen.getByTitle("Restarting pi…");
    expect(restartingBtn).toBeTruthy();
    expect((restartingBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it("has a disabled button while restarting, preventing double-send", () => {
    vi.spyOn(window, "confirm").mockImplementation(() => true);

    renderNode();
    const btn = screen.getByTitle("Restart pi (pick up config/extension changes)");
    act(() => { btn.click(); });

    // The button is now disabled — HTML disabled buttons don't fire click events
    const restartingBtn = screen.getByTitle("Restarting pi…");
    expect((restartingBtn as HTMLButtonElement).disabled).toBe(true);

    // send was called with restart_node exactly once (other calls like attach_node also happen)
    const restartCalls = terminalCtx.send.mock.calls.filter(
      (args: unknown[]) => (args[0] as Record<string, unknown>)?.type === "restart_node",
    );
    expect(restartCalls).toHaveLength(1);
    expect(restartCalls[0][0]).toEqual({
      type: "restart_node",
      nodeId: "n1",
    });
  });

  it("clears restarting after 30s if node_ready never arrives", () => {
    vi.useFakeTimers();
    vi.spyOn(window, "confirm").mockImplementation(() => true);

    renderNode();
    const btn = screen.getByTitle("Restart pi (pick up config/extension changes)");
    act(() => { btn.click(); });
    expect(screen.getByTitle("Restarting pi…")).toBeTruthy();

    act(() => { vi.advanceTimersByTime(30_000); });

    const restoredBtn = screen.getByTitle("Restart pi (pick up config/extension changes)");
    expect(restoredBtn).toBeTruthy();
    expect((restoredBtn as HTMLButtonElement).disabled).toBe(false);
    vi.useRealTimers();
  });

  it("clears the restarting state and re-enables the button on node_ready", () => {
    vi.spyOn(window, "confirm").mockImplementation(() => true);

    renderNode();

    // Click to start restarting
    const btn = screen.getByTitle("Restart pi (pick up config/extension changes)");
    act(() => { btn.click(); });

    // Confirm it's now restarting
    expect(screen.getByTitle("Restarting pi…")).toBeTruthy();

    // Fire node_ready — the useEffect in AgentNode subscribes to onNodeReady
    act(() => {
      emitNodeReady("b1:n1");
    });

    // The button should be back to the default title and enabled
    const restoredBtn = screen.getByTitle("Restart pi (pick up config/extension changes)");
    expect(restoredBtn).toBeTruthy();
    expect((restoredBtn as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("AgentNode — runtime badge", () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
  });

  function renderNode(data: WorkflowNodeData = baseData) {
    return render(
      <TerminalContext.Provider value={terminalCtx}>
        <AgentNode
          id="n1"
          data={data}
          selected={false}
          type="agent"
          dragging={false}
          zIndex={0}
          selectable
          deletable
          draggable
          isConnectable
          positionAbsoluteX={0}
          positionAbsoluteY={0}
          targetPosition={Position.Left}
          sourcePosition={Position.Right}
        />
      </TerminalContext.Provider>,
    );
  }

  it("shows read-only runtime badge (no toggle)", () => {
    renderNode({ ...baseData, runtime: "hermes" });
    expect(screen.getByText("hm")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "pi" })).toBeNull();
  });
});
