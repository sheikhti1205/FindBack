// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BottomSheet } from "./BottomSheet";
import { consumeBackIntercept, resetBackInterceptors } from "./backNavigation";

afterEach(() => {
  cleanup();
  resetBackInterceptors();
  document.body.style.overflow = "";
});

function tabOn(node: Element, shiftKey = false): void {
  act(() => {
    node.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true }),
    );
  });
}

describe("BottomSheet", () => {
  it("opens with an accessible title and locks background scroll", () => {
    render(
      <>
        <button>Behind</button>
        <BottomSheet open onClose={vi.fn()} title="Details" description="More info">
          <p>Sheet body</p>
        </BottomSheet>
      </>,
    );
    const dialog = screen.getByRole("dialog", { name: "Details" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByText("More info")).toBeTruthy();
    expect(screen.getByText("Sheet body")).toBeTruthy();
    expect(document.body.style.overflow).toBe("hidden");
  });

  it.each([
    ["medium", "50dvh"],
    ["large", "85dvh"],
    ["full", "100dvh"],
  ] as const)("supports the %s height", (height, maxHeight) => {
    render(
      <BottomSheet open onClose={vi.fn()} title="Details" height={height}>
        body
      </BottomSheet>,
    );
    const dialog = screen.getByTestId("bottom-sheet");
    expect(dialog.getAttribute("data-height")).toBe(height);
    expect(dialog.style.maxHeight).toBe(maxHeight);
  });

  it("defaults to the large height", () => {
    render(
      <BottomSheet open onClose={vi.fn()} title="Details">
        body
      </BottomSheet>,
    );
    expect(screen.getByTestId("bottom-sheet").getAttribute("data-height")).toBe("large");
  });

  it("closes on backdrop tap and restores scroll after the exit animation", async () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <BottomSheet open onClose={onClose} title="Details">
        body
      </BottomSheet>,
    );
    fireEvent.click(screen.getByTestId("bottom-sheet-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(
      <BottomSheet open={false} onClose={onClose} title="Details">
        body
      </BottomSheet>,
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.body.style.overflow).toBe("");
  });

  it("closes on the header close button", () => {
    const onClose = vi.fn();
    render(
      <BottomSheet open onClose={onClose} title="Details">
        body
      </BottomSheet>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("dismisses on back via the shared back interceptor", () => {
    const onClose = vi.fn();
    render(
      <BottomSheet open onClose={onClose} title="Details">
        body
      </BottomSheet>,
    );
    expect(consumeBackIntercept()).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("dismisses on Escape on web", () => {
    const onClose = vi.fn();
    render(
      <BottomSheet open onClose={onClose} title="Details">
        <button>Action</button>
      </BottomSheet>,
    );
    fireEvent.keyDown(screen.getByTestId("bottom-sheet"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("moves focus into the sheet on open", () => {
    render(
      <>
        <button>Behind</button>
        <BottomSheet open onClose={vi.fn()} title="Details">
          <button>Action</button>
        </BottomSheet>
      </>,
    );
    expect(screen.getByTestId("bottom-sheet").contains(document.activeElement)).toBe(true);
  });

  it("returns focus to the launcher after the exit animation", async () => {
    const opener = document.createElement("button");
    opener.textContent = "Opener";
    document.body.appendChild(opener);
    opener.focus();

    const { rerender } = render(
      <BottomSheet open onClose={vi.fn()} title="Details">
        <button>Action</button>
      </BottomSheet>,
    );
    expect(document.activeElement).not.toBe(opener);

    rerender(
      <BottomSheet open={false} onClose={vi.fn()} title="Details">
        <button>Action</button>
      </BottomSheet>,
    );
    await waitFor(() => expect(document.activeElement).toBe(opener));
    opener.remove();
  });

  it("keeps background out of the keyboard tab order", () => {
    render(
      <>
        <button>Behind</button>
        <BottomSheet open onClose={vi.fn()} title="Details">
          <button>Action</button>
        </BottomSheet>
      </>,
    );
    const dialog = screen.getByTestId("bottom-sheet");
    const first = screen.getByRole("button", { name: "Close" });
    const last = screen.getByRole("button", { name: "Action" });

    last.focus();
    tabOn(last);
    expect(document.activeElement).toBe(first);

    first.focus();
    tabOn(first, true);
    expect(document.activeElement).toBe(last);
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("scrolls long content inside the sheet", () => {
    render(
      <BottomSheet open onClose={vi.fn()} title="Details">
        <div style={{ height: 3000 }}>tall body</div>
      </BottomSheet>,
    );
    const content = screen.getByTestId("bottom-sheet-content");
    expect(content.style.overflowY).toBe("auto");
    expect(content.textContent).toContain("tall body");
  });

  it("keeps a focused input visible for keyboard/IME", () => {
    render(
      <BottomSheet open onClose={vi.fn()} title="Details">
        <label>
          Note
          <input aria-label="Note" />
        </label>
      </BottomSheet>,
    );
    const input = screen.getByLabelText("Note") as HTMLInputElement;
    input.scrollIntoView = vi.fn();
    fireEvent.focus(input);
    expect(input.scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  });

  it("plays an exit animation instead of unmounting synchronously", async () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <BottomSheet open onClose={onClose} title="Details">
        body
      </BottomSheet>,
    );
    expect(screen.getByRole("dialog", { name: "Details" })).toBeTruthy();

    rerender(
      <BottomSheet open={false} onClose={onClose} title="Details">
        body
      </BottomSheet>,
    );
    // Exit animation keeps the sheet + backdrop mounted for a beat …
    expect(screen.getByRole("dialog", { name: "Details" })).toBeTruthy();
    expect(screen.getByTestId("bottom-sheet-backdrop")).toBeTruthy();
    // … then the sheet unmounts and releases the scroll lock.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), {
      timeout: 3000,
    });
    expect(document.body.style.overflow).toBe("");
  });

  it("fades the backdrop out on exit", async () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <BottomSheet open onClose={onClose} title="Details">
        body
      </BottomSheet>,
    );
    const backdrop = screen.getByTestId("bottom-sheet-backdrop");
    // Enter fade completes first (fully opaque while open) …
    await waitFor(() => expect(backdrop.style.opacity).toBe("1"), {
      timeout: 3000,
    });

    rerender(
      <BottomSheet open={false} onClose={onClose} title="Details">
        body
      </BottomSheet>,
    );
    // … then the exit fade drops opacity below 1 …
    const exiting = screen.getByTestId("bottom-sheet-backdrop");
    await waitFor(
      () => expect(Number(exiting.style.opacity || "1")).toBeLessThan(1),
      { timeout: 3000 },
    );
    // … and the backdrop unmounts once the exit finishes.
    await waitFor(
      () => expect(screen.queryByTestId("bottom-sheet-backdrop")).toBeNull(),
      { timeout: 3000 },
    );
  });

  it("supports non-dismissible mode for critical ops", () => {
    const onClose = vi.fn();
    render(
      <BottomSheet open onClose={onClose} title="Uploading" dismissible={false}>
        <button>Action</button>
      </BottomSheet>,
    );
    // Dialog still opens and traps focus.
    expect(screen.getByRole("dialog", { name: "Uploading" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();

    fireEvent.click(screen.getByTestId("bottom-sheet-backdrop"));
    fireEvent.keyDown(screen.getByTestId("bottom-sheet"), { key: "Escape" });
    // Back is consumed (no navigation) but must not dismiss.
    expect(consumeBackIntercept()).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
  });
});
