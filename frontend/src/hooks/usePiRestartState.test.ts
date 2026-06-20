import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { confirmPiRestart, usePiRestartState } from "./usePiRestartState";
import { emitNodeReady } from "../lib/ptyBus";

describe("confirmPiRestart", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("asks to restart when idle", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    confirmPiRestart({ label: "Dev", running: false });
    expect(confirm).toHaveBeenCalledWith(
      'Restart pi for node "Dev"? It will pick up config, prompt, and extension changes.',
    );
  });

  it("warns about killing a running node", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    confirmPiRestart({ label: "Dev", running: true });
    expect(confirm).toHaveBeenCalledWith(
      'Node "Dev" is running. Restart pi anyway? It will be killed and respawned.',
    );
  });
});

describe("usePiRestartState", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts with restarting false", () => {
    const { result } = renderHook(() => usePiRestartState("b1", "n1"));
    expect(result.current[0]).toBe(false);
  });

  it("clears restarting on node_ready", () => {
    const { result } = renderHook(() => usePiRestartState("b1", "n1"));

    act(() => result.current[1](true));
    expect(result.current[0]).toBe(true);

    act(() => emitNodeReady("b1:n1"));
    expect(result.current[0]).toBe(false);
  });

  it("clears restarting after 30s if node_ready never arrives", () => {
    const { result } = renderHook(() => usePiRestartState("b1", "n1"));

    act(() => result.current[1](true));
    expect(result.current[0]).toBe(true);

    act(() => vi.advanceTimersByTime(30_000));
    expect(result.current[0]).toBe(false);
  });

  it("does not arm timeout while nodeId is missing", () => {
    const { result } = renderHook(() => usePiRestartState("b1", null));

    act(() => result.current[1](true));
    expect(result.current[0]).toBe(true);

    act(() => vi.advanceTimersByTime(30_000));
    expect(result.current[0]).toBe(true);
  });
});
