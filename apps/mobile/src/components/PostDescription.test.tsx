// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PostDescription } from "./PostDescription";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("shared post description", () => {
  it("keeps links and formatting usable when the complete rich description fits", () => {
    vi.spyOn(Element.prototype, "scrollHeight", "get").mockReturnValue(40);
    vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(40);
    render(<MemoryRouter><PostDescription text="**Blue wallet**. [Identifying mark](https://example.test/mark)" /></MemoryRouter>);
    expect(screen.getByRole("link", { name: "Identifying mark" }).getAttribute("href")).toBe("https://example.test/mark");
    expect(screen.getByText("Blue wallet").tagName).toBe("STRONG");
    expect(screen.queryByRole("button", { name: "See more" })).toBeNull();
  });

  it("remeasures on content resize without collapsing an expanded reader", () => {
    let height = 40;
    let resized: (() => void) | undefined;
    vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(() => height);
    vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(40);
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { resized = callback; }
      observe() {}
      disconnect() {}
    });
    render(<MemoryRouter><PostDescription text="A **recognizable** blue wallet." /></MemoryRouter>);
    expect(screen.queryByRole("button", { name: "See more" })).toBeNull();
    act(() => { height = 100; resized?.(); });
    const more = screen.getByRole("button", { name: "See more" });
    expect(document.getElementById(more.getAttribute("aria-controls")!)).toBeTruthy();
    fireEvent.click(more);
    act(() => { height = 40; resized?.(); });
    expect(screen.getByRole("button", { name: "Show less" })).toBeTruthy();
    expect(screen.getByText("recognizable").tagName).toBe("STRONG");
    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(screen.queryByRole("button", { name: "See more" })).toBeNull();
  });

  it("does not inherit expanded state when the report description changes", () => {
    vi.spyOn(Element.prototype, "scrollHeight", "get").mockReturnValue(100);
    vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(40);
    const { rerender } = render(<MemoryRouter><PostDescription text="Old **details**" /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: "See more" }));
    rerender(<MemoryRouter><PostDescription text="New **details**" /></MemoryRouter>);
    expect(screen.getByRole("button", { name: "See more" }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByTestId("post-description").textContent).toBe("New details");
  });
});
