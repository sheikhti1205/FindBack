// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLongPress } from "./useLongPress";

const HOLD_MS = 400;

function Probe({ onOpen, disabled }: { onOpen: () => void; disabled?: boolean }) {
  const press = useLongPress(onOpen, { delayMs: HOLD_MS, disabled });
  return (
    <button
      type="button"
      data-testid="press-target"
      onPointerDown={press.onPointerDown}
      onPointerMove={press.onPointerMove}
      onPointerUp={press.onPointerUp}
      onPointerCancel={press.onPointerCancel}
      onClick={(e) => {
        if (press.claimTap()) e.preventDefault();
      }}
    >
      hold me
    </button>
  );
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useLongPress", () => {
  it("opens after holding past the threshold (red: hook missing)", () => {
    const onOpen = vi.fn();
    render(<Probe onOpen={onOpen} />);
    fireEvent.pointerDown(screen.getByTestId("press-target"), { clientX: 10, clientY: 10, button: 0 });
    expect(onOpen).not.toHaveBeenCalled();
    vi.advanceTimersByTime(HOLD_MS);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("does not open on a quick tap (pointerup before threshold)", () => {
    const onOpen = vi.fn();
    render(<Probe onOpen={onOpen} />);
    const target = screen.getByTestId("press-target");
    fireEvent.pointerDown(target, { clientX: 10, clientY: 10, button: 0 });
    vi.advanceTimersByTime(HOLD_MS - 50);
    fireEvent.pointerUp(target, { clientX: 10, clientY: 10 });
    vi.advanceTimersByTime(1000);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("cancels when the gesture becomes a scroll (pointermove beyond threshold)", () => {
    const onOpen = vi.fn();
    render(<Probe onOpen={onOpen} />);
    const target = screen.getByTestId("press-target");
    fireEvent.pointerDown(target, { clientX: 10, clientY: 10, button: 0 });
    vi.advanceTimersByTime(HOLD_MS - 50);
    fireEvent.pointerMove(target, { clientX: 10, clientY: 40 });
    vi.advanceTimersByTime(1000);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("tolerates tiny jitter inside the threshold", () => {
    const onOpen = vi.fn();
    render(<Probe onOpen={onOpen} />);
    const target = screen.getByTestId("press-target");
    fireEvent.pointerDown(target, { clientX: 10, clientY: 10, button: 0 });
    fireEvent.pointerMove(target, { clientX: 12, clientY: 13 });
    vi.advanceTimersByTime(HOLD_MS);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("cancels on pointercancel", () => {
    const onOpen = vi.fn();
    render(<Probe onOpen={onOpen} />);
    const target = screen.getByTestId("press-target");
    fireEvent.pointerDown(target, { clientX: 10, clientY: 10, button: 0 });
    fireEvent.pointerCancel(target);
    vi.advanceTimersByTime(1000);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("flags the tap for suppression once the tray opened (long-press click must not toggle)", () => {
    const onOpen = vi.fn();
    let claimed: boolean | null = null;
    function ClaimProbe() {
      const press = useLongPress(onOpen, { delayMs: HOLD_MS });
      return (
        <button
          type="button"
          data-testid="claim-target"
          onPointerDown={press.onPointerDown}
          onPointerUp={press.onPointerUp}
          onClick={() => {
            claimed = press.claimTap();
          }}
        >
          hold me
        </button>
      );
    }
    render(<ClaimProbe />);
    const target = screen.getByTestId("claim-target");
    fireEvent.pointerDown(target, { clientX: 10, clientY: 10, button: 0 });
    vi.advanceTimersByTime(HOLD_MS);
    fireEvent.pointerUp(target);
    fireEvent.click(target);
    expect(claimed).toBe(true);
    // The next plain tap is a real tap again.
    fireEvent.pointerDown(target, { clientX: 10, clientY: 10, button: 0 });
    fireEvent.pointerUp(target);
    fireEvent.click(target);
    expect(claimed).toBe(false);
  });

  it("stays shut while disabled", () => {
    const onOpen = vi.fn();
    render(<Probe onOpen={onOpen} disabled />);
    fireEvent.pointerDown(screen.getByTestId("press-target"), { clientX: 10, clientY: 10, button: 0 });
    vi.advanceTimersByTime(HOLD_MS + 500);
    expect(onOpen).not.toHaveBeenCalled();
  });
});
