// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { useFocusTrap } from "./useFocusTrap";

describe("useFocusTrap", () => {
  afterEach(cleanup);

  it("moves focus into the trap on mount", () => {
    const onClose = vi.fn();

    function Trap() {
      const ref = useRef<HTMLDivElement>(null);
      useFocusTrap(ref as React.RefObject<HTMLElement>, onClose);
      return (
        <div ref={ref} tabIndex={-1}>
          <button>First</button>
          <a href="#">Link</a>
          <button>Last</button>
        </div>
      );
    }

    render(<Trap />);
    expect(document.activeElement).toBe(document.querySelector("button"));
  });

  it("Tab on the last focusable wraps to the first", () => {
    const onClose = vi.fn();

    function Trap() {
      const ref = useRef<HTMLDivElement>(null);
      useFocusTrap(ref as React.RefObject<HTMLElement>, onClose);
      return (
        <div ref={ref} tabIndex={-1}>
          <button>First</button>
          <a href="#">Link</a>
          <button>Last</button>
        </div>
      );
    }

    const { container } = render(<Trap />);
    const last = container.querySelectorAll("button")[1] as HTMLElement;
    last.focus();

    act(() => {
      container.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    });
    expect(document.activeElement).toBe(container.querySelector("button"));
  });

  it("Shift+Tab on the first wraps to the last", () => {
    const onClose = vi.fn();

    function Trap() {
      const ref = useRef<HTMLDivElement>(null);
      useFocusTrap(ref as React.RefObject<HTMLElement>, onClose);
      return (
        <div ref={ref} tabIndex={-1}>
          <button>First</button>
          <a href="#">Link</a>
          <button>Last</button>
        </div>
      );
    }

    const { container } = render(<Trap />);
    const first = container.querySelector("button") as HTMLElement;
    first.focus();

    act(() => {
      container.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
    });
    const buttons = container.querySelectorAll("button");
    expect(document.activeElement).toBe(buttons[buttons.length - 1]);
  });

  it("Escape calls onClose", () => {
    const onClose = vi.fn();

    function Trap() {
      const ref = useRef<HTMLDivElement>(null);
      useFocusTrap(ref as React.RefObject<HTMLElement>, onClose);
      return <div ref={ref} tabIndex={-1}><button>First</button></div>;
    }

    const { container } = render(<Trap />);
    act(() => {
      container.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("restores focus to the opener on unmount", () => {
    const onClose = vi.fn();

    const opener = document.createElement("button");
    opener.textContent = "Opener";
    document.body.appendChild(opener);
    opener.focus();

    function Trap() {
      const ref = useRef<HTMLDivElement>(null);
      useFocusTrap(ref as React.RefObject<HTMLElement>, onClose);
      return <div ref={ref} tabIndex={-1}><button>First</button></div>;
    }

    const { unmount } = render(<Trap />);
    act(() => { unmount(); });
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
