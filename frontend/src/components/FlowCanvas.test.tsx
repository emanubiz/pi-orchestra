import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, screen } from "@testing-library/react";
import { useRef } from "react";
import { FlowCanvas } from "./FlowCanvas";
import { useRuntimeStore } from "../stores/runtimeStore";
import type { FlowCanvasHandle } from "./FlowCanvas";

vi.mock("@xyflow/react", async () => {
  const React = await import("react");
  return {
    ReactFlow: ({
      nodes,
      nodeTypes,
      children,
    }: {
      nodes?: Array<{ id: string; type?: string; data: unknown }>;
      nodeTypes?: Record<string, React.ComponentType<Record<string, unknown>>>;
      children?: React.ReactNode;
    }) => {
      const Agent = nodeTypes?.agent;
      return React.createElement(
        "div",
        { "data-testid": "react-flow" },
        nodes?.map((n) =>
          Agent
            ? React.createElement(Agent, {
                key: n.id,
                id: n.id,
                data: n.data,
                selected: false,
                type: n.type ?? "agent",
                dragging: false,
                zIndex: 0,
                positionAbsoluteX: 0,
                positionAbsoluteY: 0,
                targetPosition: "left",
                sourcePosition: "right",
              })
            : null,
        ),
        children,
      );
    },
    Background: () => null,
    Controls: () => null,
    MiniMap: () => null,
    Panel: ({ children }: { children?: React.ReactNode }) =>
      React.createElement("div", null, children),
    Handle: () => null,
    Position: { Left: "left", Right: "right", Top: "top", Bottom: "bottom" },
    addEdge: (edge: unknown, eds: unknown[]) => [...eds, edge],
    useNodesState: (initial: unknown[]) => {
      const [nodes, setNodes] = React.useState(initial);
      return [nodes, setNodes, vi.fn()];
    },
    useEdgesState: (initial: unknown[]) => {
      const [edges, setEdges] = React.useState(initial);
      return [edges, setEdges, vi.fn()];
    },
  };
});

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    open = vi.fn();
    write = vi.fn();
    reset = vi.fn();
    loadAddon = vi.fn();
    dispose = vi.fn();
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit = vi.fn();
  },
}));

global.ResizeObserver = class {
  observe = vi.fn();
  disconnect = vi.fn();
  unobserve = vi.fn();
} as unknown as typeof ResizeObserver;

const initialSnapshot = {
  nodes: [
    {
      id: "n1",
      type: "agent",
      position: { x: 0, y: 0 },
      data: { label: "Developer", promptId: "p1", status: "idle" as const },
    },
  ],
  edges: [] as Array<{ id: string; source: string; target: string }>,
};

function CanvasHarness() {
  const flowRef = useRef<FlowCanvasHandle | null>(null);
  return (
    <FlowCanvas
      boardId="b1"
      entryNodeId="n1"
      initialSnapshot={initialSnapshot}
      onGraphChange={vi.fn()}
      flowRef={flowRef}
      send={vi.fn()}
      onExpand={vi.fn()}
      onEditPrompt={vi.fn()}
    />
  );
}

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
  });
}

function trashButton(): HTMLButtonElement {
  const btn = document.querySelector("button .lucide-trash-2")?.closest("button");
  if (!btn) throw new Error("delete button not found");
  return btn as HTMLButtonElement;
}

describe("FlowCanvas — delete + overlay", () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not show delete dialog on Backspace while terminal overlay is open", () => {
    render(<CanvasHarness />);

    act(() => {
      useRuntimeStore.setState({ selectedNodeId: "n1", overlayNodeId: "n1" });
    });

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
    });

    // Dialog must NOT appear when overlay is open
    expect(screen.queryByRole("button", { name: /^Delete$/ })).toBeNull();
    expect(useRuntimeStore.getState().overlayNodeId).toBe("n1");
  });

  it("shows confirm dialog then closes overlay when deleting the expanded node via trash button", () => {
    render(<CanvasHarness />);

    act(() => {
      useRuntimeStore.setState({ overlayNodeId: "n1" });
    });

    act(() => {
      trashButton().click();
    });

    // Dialog should be visible
    const confirmBtn = screen.getByRole("button", { name: /^Delete$/ });
    expect(confirmBtn).toBeTruthy();

    act(() => {
      confirmBtn.click();
    });

    expect(useRuntimeStore.getState().overlayNodeId).toBeNull();
  });

  it("shows confirm dialog then removes node on Delete key when overlay is closed", () => {
    render(<CanvasHarness />);

    act(() => {
      useRuntimeStore.setState({ selectedNodeId: "n1", overlayNodeId: null });
    });

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    });

    // Dialog must appear
    const confirmBtn = screen.getByRole("button", { name: /^Delete$/ });
    expect(confirmBtn).toBeTruthy();

    act(() => {
      confirmBtn.click();
    });

    expect(useRuntimeStore.getState().selectedNodeId).toBeNull();
    expect(document.querySelector("button .lucide-trash-2")).toBeNull();
  });

  it("Cancel keeps the node alive", () => {
    render(<CanvasHarness />);

    act(() => {
      useRuntimeStore.setState({ selectedNodeId: "n1", overlayNodeId: null });
    });

    act(() => {
      trashButton().click();
    });

    act(() => {
      screen.getByRole("button", { name: /Cancel/ }).click();
    });

    // Node still present
    expect(document.querySelector("button .lucide-trash-2")).toBeTruthy();
  });
});
