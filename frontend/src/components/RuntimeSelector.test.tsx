import { describe, it, expect, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { RuntimeSelector } from "./RuntimeSelector";

describe("RuntimeSelector", () => {
  it("calls onChange when selecting a different runtime", () => {
    const onChange = vi.fn();
    render(<RuntimeSelector value="pi" onChange={onChange} />);

    act(() => {
      screen.getByRole("button", { name: "hermes" }).click();
    });

    expect(onChange).toHaveBeenCalledWith("hermes");
  });

  it("shows a warning affordance when hermes is selected but unavailable", () => {
    render(
      <RuntimeSelector value="hermes" hermesAvailable={false} onChange={vi.fn()} />,
    );

    expect(screen.getByTitle(/CLI was not found/i)).toBeTruthy();
    expect(screen.getByText("⚠")).toBeTruthy();
  });

  it("offers claude and calls onChange with it", () => {
    const onChange = vi.fn();
    render(<RuntimeSelector value="pi" onChange={onChange} />);

    act(() => {
      screen.getByRole("button", { name: "claude" }).click();
    });

    expect(onChange).toHaveBeenCalledWith("claude");
  });

  it("shows a warning affordance when claude is selected but unavailable", () => {
    render(
      <RuntimeSelector value="claude" claudeAvailable={false} onChange={vi.fn()} />,
    );

    expect(screen.getByTitle(/CLI was not found/i)).toBeTruthy();
    expect(screen.getByText("⚠")).toBeTruthy();
  });
});
