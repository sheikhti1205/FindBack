// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRef, useState } from "react";
import { useFocusTrap } from "./useFocusTrap";

afterEach(() => cleanup());

function Outer({ children, onClose }: { children?: React.ReactNode; onClose?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const setRef = useFocusTrap(ref, onClose ?? vi.fn(), true);
  return (
    <div ref={setRef} data-testid="outer" tabIndex={-1}>
      <button type="button">Outer action</button>
      {children}
    </div>
  );
}

function Inner({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const setRef = useFocusTrap(ref, onClose, true);
  return (
    <div ref={setRef} role="dialog" aria-label="Inner dialog" tabIndex={-1}>
      <button type="button">Inner first</button>
      <button type="button">Inner second</button>
    </div>
  );
}

function Nested({ onOuterClose, onInnerClose }: { onOuterClose: () => void; onInnerClose: () => void }) {
  // The inner dialog opens AFTER the outer layer mounts, exactly like the
  // production sheets/menus/dialogs: push order then matches z-order, so the
  // last-opened layer is topmost.
  const [open, setOpen] = useState(false);
  return (
    <Outer onClose={onOuterClose}>
      <button type="button" onClick={() => setOpen(true)}>Open inner</button>
      {open ? <Inner onClose={() => { onInnerClose(); setOpen(false); }} /> : null}
    </Outer>
  );
}

function openInner(): void {
  fireEvent.click(screen.getByRole("button", { name: "Open inner" }));
  expect(screen.getByRole("dialog", { name: "Inner dialog" })).toBeTruthy();
}

describe("useFocusTrap nested layers", () => {
  it("moves Tab into the topmost dialog instead of wrapping the covered editor", () => {
    const onOuterClose = vi.fn();
    const onInnerClose = vi.fn();
    render(<Nested onOuterClose={onOuterClose} onInnerClose={onInnerClose} />);
    openInner();
    // Opening the dialog focuses its first control; move focus back out to
    // the covered editor, then press Tab: the top dialog must reclaim it.
    (screen.getByRole("button", { name: "Outer action" }) as HTMLElement).focus();
    expect(document.activeElement?.textContent).toBe("Outer action");
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement?.textContent).toBe("Inner first");
    expect(onOuterClose).not.toHaveBeenCalled();
    expect(onInnerClose).not.toHaveBeenCalled();
  });

  it("wraps Shift+Tab inside the topmost dialog", () => {
    render(<Nested onOuterClose={vi.fn()} onInnerClose={vi.fn()} />);
    openInner();
    (screen.getByRole("button", { name: "Inner first" }) as HTMLElement).focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement?.textContent).toBe("Inner second");
  });

  it("closes only the topmost layer on Escape", () => {
    const onOuterClose = vi.fn();
    const onInnerClose = vi.fn();
    render(<Nested onOuterClose={onOuterClose} onInnerClose={onInnerClose} />);
    openInner();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onInnerClose).toHaveBeenCalledTimes(1);
    expect(onOuterClose).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Inner dialog" })).toBeNull();
  });

  it("restores focus to the trigger when the top dialog unmounts", () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <div>
          <button type="button" onClick={() => setOpen(true)}>Open dialog</button>
          {open ? <Inner onClose={() => setOpen(false)} /> : null}
        </div>
      );
    }
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Open dialog" });
    (trigger as HTMLElement).focus();
    fireEvent.click(trigger);
    expect(document.activeElement?.textContent).toBe("Inner first");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Inner dialog" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
