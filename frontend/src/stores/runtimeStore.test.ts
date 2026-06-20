import { describe, it, expect, beforeEach } from "vitest";
import { useRuntimeStore } from "./runtimeStore";

describe("runtimeStore — overlay", () => {
  beforeEach(() => {
    useRuntimeStore.setState({
      activeBoardId: "b1",
      selectedNodeId: null,
      overlayNodeId: null,
    });
  });

  it("clears overlayNodeId and selectedNodeId when switching boards", () => {
    useRuntimeStore.getState().setOverlayNodeId("n1");
    useRuntimeStore.getState().setSelectedNodeId("n1");

    useRuntimeStore.getState().setActiveBoardId("b2");

    expect(useRuntimeStore.getState().activeBoardId).toBe("b2");
    expect(useRuntimeStore.getState().overlayNodeId).toBeNull();
    expect(useRuntimeStore.getState().selectedNodeId).toBeNull();
  });
});
