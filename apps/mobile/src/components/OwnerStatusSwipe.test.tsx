// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OwnerStatusSwipe } from "./OwnerStatusSwipe";

function stubVibrate() {
  const vibrate = vi.fn(() => true);
  Object.defineProperty(navigator, "vibrate", { value: vibrate, configurable: true });
  return vibrate;
}

function surface() {
  return screen.getByTestId("owner-status-swipe-surface");
}

function drag(fromX: number, toX: number, fromY = 100, toY = 100) {
  fireEvent.pointerDown(surface(), {
    pointerId: 1,
    pointerType: "touch",
    clientX: fromX,
    clientY: fromY,
    button: 0,
  });
  fireEvent.pointerMove(surface(), {
    pointerId: 1,
    pointerType: "touch",
    clientX: toX,
    clientY: toY,
  });
  fireEvent.pointerUp(surface(), {
    pointerId: 1,
    pointerType: "touch",
    clientX: toX,
    clientY: toY,
  });
}

beforeEach(() => {
  stubVibrate();
});

afterEach(() => {
  cleanup();
  Object.defineProperty(navigator, "vibrate", { value: undefined, configurable: true });
});

describe("OwnerStatusSwipe", () => {
  it("reveals the action past the threshold and runs it only when tapped", () => {
    const onAction = vi.fn();
    const childClick = vi.fn();
    render(
      <OwnerStatusSwipe actionLabel="Mark matched" onAction={onAction}>
        <button type="button" onClick={childClick}>
          Open report
        </button>
      </OwnerStatusSwipe>,
    );

    drag(200, 130);

    expect(screen.getByTestId("owner-status-swipe").dataset.revealed).toBe("true");
    // The covered card is inert, so keyboard/AT cannot land on links that the
    // reveal is visually covering.
    expect(screen.getByTestId("owner-status-swipe-content").hasAttribute("inert")).toBe(true);
    const action = screen.getByRole("button", { name: "Mark matched" });
    expect(action.tabIndex).toBe(0);
    // Revealing is not firing.
    expect(onAction).not.toHaveBeenCalled();
    // The drag's trailing click never opens the report.
    fireEvent.click(screen.getByRole("button", { name: "Open report" }));
    expect(childClick).not.toHaveBeenCalled();

    fireEvent.click(action);
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("owner-status-swipe").dataset.revealed).toBe("false");
    expect(screen.getByTestId("owner-status-swipe-content").hasAttribute("inert")).toBe(false);
  });

  it("cancels on vertical movement so the feed still scrolls", () => {
    const onAction = vi.fn();
    render(
      <OwnerStatusSwipe actionLabel="Mark matched" onAction={onAction}>
        <button type="button">Open report</button>
      </OwnerStatusSwipe>,
    );

    // Vertical movement must cancel even when it carries enough horizontal
    // drift to cross the reveal threshold; otherwise deleting the axis check
    // would still pass this test.
    drag(200, 150, 180, 100);

    expect(screen.getByTestId("owner-status-swipe").dataset.revealed).toBe("false");
    expect(onAction).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Mark matched" })).toBeNull();
  });

  it("does not reveal for a short horizontal nudge below the threshold", () => {
    render(
      <OwnerStatusSwipe actionLabel="Mark matched" onAction={vi.fn()}>
        <button type="button">Open report</button>
      </OwnerStatusSwipe>,
    );

    drag(200, 185);

    expect(screen.getByTestId("owner-status-swipe").dataset.revealed).toBe("false");
    expect(screen.queryByRole("button", { name: "Mark matched" })).toBeNull();
  });

  it("confirms at the threshold and on reveal where haptics exist", () => {
    const vibrate = stubVibrate();
    render(
      <OwnerStatusSwipe actionLabel="Mark matched" onAction={vi.fn()}>
        <button type="button">Open report</button>
      </OwnerStatusSwipe>,
    );

    drag(200, 130);

    expect(vibrate.mock.calls).toEqual([[8], [14]]);
  });
});
