// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRef, useState } from "react";
import { createPortal } from "react-dom";
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
  it.each(["disabled", "removed"])("recovers focus when the current control is %s", async (change) => {
    function Changing({ changed }: { changed: boolean }) {
      const ref = useRef<HTMLDivElement>(null);
      const setRef = useFocusTrap(ref, vi.fn());
      return <div ref={setRef} role="dialog" tabIndex={-1}>
        <button>Close</button>
        {!(changed && change === "removed") && <button disabled={changed}>Send</button>}
      </div>;
    }
    const { rerender } = render(<Changing changed={false} />);
    screen.getByRole("button", { name: "Send" }).focus();
    rerender(<Changing changed />);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" })));
  });

  it("uses the container when a mutation leaves no enabled controls", async () => {
    function Changing({ busy }: { busy: boolean }) {
      const ref = useRef<HTMLDivElement>(null);
      const setRef = useFocusTrap(ref, vi.fn());
      return <div ref={setRef} role="dialog" tabIndex={-1}><button disabled={busy}>Send</button></div>;
    }
    const { rerender } = render(<Changing busy={false} />);
    rerender(<Changing busy />);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("dialog")));
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    document.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
  });

  it("preserves a valid text-field focus across unrelated content mutations", async () => {
    function Changing({ loaded }: { loaded: boolean }) {
      const ref = useRef<HTMLDivElement>(null);
      const setRef = useFocusTrap(ref, vi.fn());
      return <div ref={setRef} tabIndex={-1}><button>Close</button><input aria-label="Details" />{loaded && <p>Loaded</p>}</div>;
    }
    const { rerender } = render(<Changing loaded={false} />);
    screen.getByRole("textbox").focus();
    rerender(<Changing loaded />);
    await waitFor(() => expect(screen.getByText("Loaded")).toBeTruthy());
    expect(document.activeElement).toBe(screen.getByRole("textbox"));
  });

  it("does not let a covered sheet reclaim focus on its own mutation", async () => {
    const { rerender } = render(<Outer><p>Loading</p></Outer>);
    // Register a top layer by opening it after the outer layer, as production does.
    rerender(<Outer><p>Loading</p>{createPortal(<Inner onClose={vi.fn()} />, document.body)}</Outer>);
    screen.getByRole("button", { name: "Inner second" }).focus();
    rerender(<Outer><p>Outer load completed</p>{createPortal(<Inner onClose={vi.fn()} />, document.body)}</Outer>);
    await waitFor(() => expect(screen.getByText("Outer load completed")).toBeTruthy());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Inner second" }));
  });

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
