// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SplitView } from "./SplitView";
import { CHAT_PANE } from "./panePreference";

const PANE = { ...CHAT_PANE, label: "Resize conversation list" };
const originalWidth = window.innerWidth;

function setWidth(value: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value });
}

function renderSplit() {
  render(<SplitView selected={false} pane={PANE}
    list={(pane) => <button type="button" onClick={pane.toggle}>
      {pane.collapsed ? "Expand list" : "Collapse list"}
    </button>}
    detail={<p role="main">Thread</p>} />);
}

function stored() {
  return JSON.parse(globalThis.localStorage.getItem(PANE.storageKey) ?? "null");
}

beforeEach(() => { setWidth(1200); globalThis.localStorage.clear(); });
afterEach(() => {
  cleanup();
  document.documentElement.style.removeProperty("font-size");
  setWidth(originalWidth);
  globalThis.localStorage.clear();
});

describe("the resizable conversation pane", () => {
  it("reserves the actual fixed list ceiling at large text", () => {
    document.documentElement.style.fontSize = "24px";
    setWidth(840);
    render(<SplitView selected={false} list={<p>List</p>} detail={<p>Details</p>} />);
    expect(document.querySelector(".fb-split-view")?.className).not.toContain("fb-split-wide");
    cleanup();
    setWidth(848); // 22rem at 24px + 320px detail.
    render(<SplitView selected={false} list={<p>List</p>} detail={<p>Details</p>} />);
    expect(document.querySelector(".fb-split-view")?.className).toContain("fb-split-wide");
  });

  it("re-evaluates the wide decision when the root text size changes after mount", async () => {
    setWidth(840);
    render(<SplitView selected={false} list={<p>List</p>} detail={<p>Details</p>} />);
    // 16px root: 22rem = 352px, detail = 840-352 = 488px — wide is viable.
    expect(document.querySelector(".fb-split-view")?.className).toContain("fb-split-wide");
    document.documentElement.style.fontSize = "32px";
    await act(async () => {});
    expect(document.querySelector(".fb-split-view")?.className).not.toContain("fb-split-wide");
  });

  it("reserves the maximum adjustable width, not the current minimum", () => {
    setWidth(840);
    const pane = { ...PANE, minWidth: 260, maxWidth: 600 };
    render(<SplitView selected={false} pane={pane} list={<p>List</p>} detail={<p>Details</p>} />);
    expect(document.querySelector(".fb-split-view")?.className).not.toContain("fb-split-wide");
  });
  it("collapses to one pane when the list would leave no usable detail width", () => {
    setWidth(880);
    const greedy = { ...PANE, minWidth: 600, maxWidth: 700, defaultWidth: 600 };
    render(<SplitView selected={false} pane={greedy}
      list={<p>List</p>}
      detail={<p role="main">Thread</p>} />);
    // A wide window is not enough: both panes need a viable width.
    expect(document.querySelector(".fb-split-view")?.className).not.toContain("fb-split-wide");
    cleanup();

    renderSplit();
    expect(document.querySelector(".fb-split-view")?.className).toContain("fb-split-wide");
  });

  it("exposes the divider as a keyboard-operable splitter with real bounds", () => {
    renderSplit();
    const divider = screen.getByRole("separator", { name: "Resize conversation list" });
    expect(divider.getAttribute("aria-orientation")).toBe("vertical");
    expect(divider.getAttribute("aria-valuenow")).toBe("320");
    expect(divider.getAttribute("aria-valuemin")).toBe("260");
    expect(divider.getAttribute("aria-valuemax")).toBe("480");

    divider.focus();
    fireEvent.keyDown(divider, { key: "ArrowRight" });
    expect(divider.getAttribute("aria-valuenow")).toBe("336");
    fireEvent.keyDown(divider, { key: "ArrowLeft", shiftKey: true });
    expect(divider.getAttribute("aria-valuenow")).toBe("288");
    fireEvent.keyDown(divider, { key: "End" });
    expect(divider.getAttribute("aria-valuenow")).toBe("480");
    fireEvent.keyDown(divider, { key: "Home" });
    expect(divider.getAttribute("aria-valuenow")).toBe("260");
    expect(stored()).toEqual({ width: 260, collapsed: false });
  });

  it("tracks the pointer and stores the habit once, on release", () => {
    renderSplit();
    const divider = screen.getByRole("separator", { name: "Resize conversation list" });
    fireEvent.pointerDown(divider, { button: 0, clientX: 400, pointerId: 1 });
    fireEvent.pointerMove(divider, { clientX: 460, pointerId: 1 });
    expect(divider.getAttribute("aria-valuenow")).toBe("380");
    expect(stored()).toBeNull();
    fireEvent.pointerUp(divider, { clientX: 460, pointerId: 1 });
    expect(stored()).toEqual({ width: 380, collapsed: false });
  });

  it("treats a click on the divider as a non-event", () => {
    renderSplit();
    const divider = screen.getByRole("separator", { name: "Resize conversation list" });
    fireEvent.pointerDown(divider, { button: 0, clientX: 400, pointerId: 1 });
    fireEvent.pointerUp(divider, { clientX: 400, pointerId: 1 });
    expect(divider.getAttribute("aria-valuenow")).toBe("320");
    expect(stored()).toBeNull();
  });

  it("collapses to the rail and comes back at the width the user chose", () => {
    renderSplit();
    const divider = screen.getByRole("separator", { name: "Resize conversation list" });
    divider.focus();
    fireEvent.keyDown(divider, { key: "ArrowRight" });
    fireEvent.keyDown(divider, { key: "Enter" });

    expect(screen.getByRole("button", { name: "Expand list" })).toBeTruthy();
    expect(screen.queryByRole("separator")).toBeNull();
    expect(stored()).toEqual({ width: 336, collapsed: true });

    fireEvent.click(screen.getByRole("button", { name: "Expand list" }));
    expect(screen.getByRole("separator").getAttribute("aria-valuenow")).toBe("336");
    expect(stored()).toEqual({ width: 336, collapsed: false });
  });

  it("restores a remembered collapse on the next visit", () => {
    globalThis.localStorage.setItem(PANE.storageKey, JSON.stringify({ width: 300, collapsed: true }));
    renderSplit();
    expect(screen.getByRole("button", { name: "Expand list" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Expand list" }));
    expect(screen.getByRole("separator").getAttribute("aria-valuenow")).toBe("300");
  });

  it("stays a single phone pane with no splitter or rail", () => {
    setWidth(390);
    renderSplit();
    expect(screen.queryByRole("separator")).toBeNull();
    expect(screen.getByRole("button", { name: "Collapse list" })).toBeTruthy();
    // With no conversation chosen the list is the only visible pane.
    expect(screen.queryByRole("main")).toBeNull();
  });

  it("leaves a split view that did not opt in exactly as it was", () => {
    render(<SplitView selected={false} list={<button type="button">List</button>} detail={<p>Thread</p>} />);
    expect(screen.queryByRole("separator")).toBeNull();
  });
});
