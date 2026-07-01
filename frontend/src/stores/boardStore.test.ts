import { describe, it, expect, beforeEach } from "vitest";
import { useBoardStore } from "./boardStore";
import type { Board, BoardSnapshot } from "../types";

function emptySnapshot(): BoardSnapshot {
  return { nodes: [], edges: [] };
}

function board(overrides: Partial<Board> & { id: string; cwd: string }): Board {
  return {
    label: "repo",
    workflowName: "Untitled",
    workflowId: null,
    entryNodeId: null,
    snapshot: emptySnapshot(),
    ...overrides,
  };
}

describe("boardStore — setDefaultCwd", () => {
  it("upgrades the lone placeholder board (cwd '.') with the real cwd and derived label", () => {
    useBoardStore.setState({
      boards: [board({ id: "b1", cwd: ".", label: "repo" })],
      activeBoardId: "b1",
      defaultCwd: null,
    });

    useBoardStore.getState().setDefaultCwd("/home/user/my-project");

    const { boards, defaultCwd } = useBoardStore.getState();
    expect(defaultCwd).toBe("/home/user/my-project");
    expect(boards).toHaveLength(1);
    expect(boards[0].cwd).toBe("/home/user/my-project");
    expect(boards[0].label).toBe("my-project");
  });

  it("preserves a user-renamed placeholder label instead of overwriting it", () => {
    useBoardStore.setState({
      boards: [board({ id: "b1", cwd: ".", label: "My Custom Name" })],
      activeBoardId: "b1",
      defaultCwd: null,
    });

    useBoardStore.getState().setDefaultCwd("/home/user/my-project");

    expect(useBoardStore.getState().boards[0].label).toBe("My Custom Name");
  });

  it("does not touch boards once more than one exists", () => {
    useBoardStore.setState({
      boards: [board({ id: "b1", cwd: ".", label: "repo" }), board({ id: "b2", cwd: "/other" })],
      activeBoardId: "b1",
      defaultCwd: null,
    });

    useBoardStore.getState().setDefaultCwd("/home/user/my-project");

    expect(useBoardStore.getState().boards[0].cwd).toBe(".");
  });

  it("does not touch a lone board that is no longer the placeholder cwd", () => {
    useBoardStore.setState({
      boards: [board({ id: "b1", cwd: "/already/bound" })],
      activeBoardId: "b1",
      defaultCwd: null,
    });

    useBoardStore.getState().setDefaultCwd("/home/user/my-project");

    expect(useBoardStore.getState().boards[0].cwd).toBe("/already/bound");
  });
});

describe("boardStore — bindWorkspace", () => {
  beforeEach(() => {
    useBoardStore.setState({
      boards: [board({ id: "b1", cwd: "/proj-a" }), board({ id: "b2", cwd: "/proj-b" })],
      activeBoardId: "b1",
      defaultCwd: null,
    });
  });

  it("reuses an existing board bound to the same cwd instead of creating a new one", () => {
    useBoardStore.getState().bindWorkspace("/proj-b");

    const { boards, activeBoardId, defaultCwd } = useBoardStore.getState();
    expect(boards).toHaveLength(1);
    expect(boards[0].id).toBe("b2");
    expect(activeBoardId).toBe("b2");
    expect(defaultCwd).toBe("/proj-b");
  });

  it("creates a new board when no existing one matches the cwd, collapsing to just it", () => {
    useBoardStore.getState().bindWorkspace("/proj-c", "Project C");

    const { boards, activeBoardId } = useBoardStore.getState();
    expect(boards).toHaveLength(1);
    expect(boards[0].cwd).toBe("/proj-c");
    expect(boards[0].label).toBe("Project C");
    expect(activeBoardId).toBe(boards[0].id);
  });
});

describe("boardStore — addBoard / removeBoard", () => {
  beforeEach(() => {
    useBoardStore.setState({
      boards: [board({ id: "b1", cwd: "/proj-a" })],
      activeBoardId: "b1",
      defaultCwd: null,
    });
  });

  it("addBoard appends a new board and makes it active", () => {
    const added = useBoardStore.getState().addBoard("/proj-b", "B");

    const { boards, activeBoardId } = useBoardStore.getState();
    expect(boards.map((b) => b.id)).toEqual(["b1", added.id]);
    expect(activeBoardId).toBe(added.id);
  });

  it("removeBoard refuses to remove the last remaining board", () => {
    useBoardStore.getState().removeBoard("b1");

    expect(useBoardStore.getState().boards).toHaveLength(1);
  });

  it("removeBoard reassigns activeBoardId when the active board is removed", () => {
    const added = useBoardStore.getState().addBoard("/proj-b", "B");
    expect(useBoardStore.getState().activeBoardId).toBe(added.id);

    useBoardStore.getState().removeBoard(added.id);

    const { boards, activeBoardId } = useBoardStore.getState();
    expect(boards.map((b) => b.id)).toEqual(["b1"]);
    expect(activeBoardId).toBe("b1");
  });

  it("removeBoard leaves activeBoardId untouched when removing a non-active board", () => {
    useBoardStore.getState().addBoard("/proj-b", "B"); // now active
    useBoardStore.getState().setActiveBoard("b1");

    const before = useBoardStore.getState().boards.find((b) => b.cwd === "/proj-b")!;
    useBoardStore.getState().removeBoard(before.id);

    expect(useBoardStore.getState().activeBoardId).toBe("b1");
  });
});

describe("boardStore — updateActiveBoard / updateBoardSnapshot", () => {
  beforeEach(() => {
    useBoardStore.setState({
      boards: [board({ id: "b1", cwd: "/proj-a" }), board({ id: "b2", cwd: "/proj-b" })],
      activeBoardId: "b1",
      defaultCwd: null,
    });
  });

  it("updateActiveBoard patches only the active board", () => {
    useBoardStore.getState().updateActiveBoard({ workflowName: "Renamed" });

    const { boards } = useBoardStore.getState();
    expect(boards.find((b) => b.id === "b1")?.workflowName).toBe("Renamed");
    expect(boards.find((b) => b.id === "b2")?.workflowName).toBe("Untitled");
  });

  it("updateBoardSnapshot patches the targeted board regardless of which is active", () => {
    const snapshot: BoardSnapshot = { nodes: [], edges: [{ id: "e1", source: "a", target: "b" }] };
    useBoardStore.getState().updateBoardSnapshot("b2", snapshot);

    const { boards } = useBoardStore.getState();
    expect(boards.find((b) => b.id === "b2")?.snapshot).toEqual(snapshot);
    expect(boards.find((b) => b.id === "b1")?.snapshot).toEqual(emptySnapshot());
  });
});

describe("boardStore — persisted-state rehydration fallback", () => {
  it("assigns activeBoardId from the first board when it is missing after rehydration", () => {
    const onRehydrateStorage = useBoardStore.persist.getOptions().onRehydrateStorage;
    const listener = onRehydrateStorage?.(useBoardStore.getState());
    const state = { activeBoardId: "", boards: [board({ id: "only", cwd: "/x" })] } as unknown as ReturnType<
      typeof useBoardStore.getState
    >;

    listener?.(state, undefined);

    expect(state.activeBoardId).toBe("only");
  });
});
