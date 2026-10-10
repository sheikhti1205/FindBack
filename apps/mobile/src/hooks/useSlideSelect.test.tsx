// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSlideSelect } from "./useSlideSelect";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  // jsdom has no elementFromPoint; tests assign it directly.
  delete (document as unknown as { elementFromPoint?: unknown }).elementFromPoint;
});

function stubPoint(el: Element | null) {
  (document as unknown as { elementFromPoint: (x: number, y: number) => Element | null }).elementFromPoint =
    () => el;
}

function Probe({ open, holding, onCancel = () => {} }: { open: boolean; holding: boolean; onCancel?: () => void }) {
  const slide = useSlideSelect(open, holding, onCancel);
  return (
    <div>
      <span data-testid="hovered">{slide.hovered ?? "none"}</span>
      <div data-testid="tray">
        <button type="button" data-kind="LOVE">love</button>
        <button type="button" data-kind="WOW">wow</button>
      </div>
    </div>
  );
}

describe("useSlideSelect (hold/slide/release state machine)", () => {
  it("resolves the kind under the finger while held open", () => {
    render(<Probe open holding />);
    const love = screen.getByText("love");
    stubPoint(love);
    fireEvent.pointerMove(window, { clientX: 50, clientY: 60 });
    expect(screen.getByTestId("hovered").textContent).toBe("LOVE");
  });

  it("clears hover off-tray (release over empty space cancels the pick)", () => {
    render(<Probe open holding />);
    stubPoint(null);
    fireEvent.pointerMove(window, { clientX: 5, clientY: 5 });
    expect(screen.getByTestId("hovered").textContent).toBe("none");
  });

  it("stays inert while the finger is lifted (no hover without hold)", () => {
    render(<Probe open holding={false} />);
    const love = screen.getByText("love");
    stubPoint(love);
    fireEvent.pointerMove(window, { clientX: 50, clientY: 60 });
    expect(screen.getByTestId("hovered").textContent).toBe("none");
  });

  it("cancels on predominantly-vertical travel (scroll, not a pick)", () => {
    const onCancel = vi.fn();
    render(<Probe open holding onCancel={onCancel} />);
    stubPoint(null);
    act(() => {
      fireEvent.pointerMove(window, { clientX: 10, clientY: 10 });
      fireEvent.pointerMove(window, { clientX: 11, clientY: 80 });
    });
    expect(onCancel).toHaveBeenCalled();
  });
});
