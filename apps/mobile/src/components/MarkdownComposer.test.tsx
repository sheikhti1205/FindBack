// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MarkdownComposer } from "./MarkdownComposer";

afterEach(cleanup);

describe("MarkdownComposer motion (Wave E)", () => {
  it("crossfades Write and Preview instead of stacking both panels", async () => {
    const onChange = vi.fn();
    render(<MarkdownComposer label="Description" value="hello" onChange={onChange} />);
    expect(screen.getByLabelText("Description")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Preview" }));
    // `mode="wait"`: the write panel leaves before the preview arrives, so the
    // two panels are never live at the same time.
    await waitFor(() => expect(screen.queryByLabelText("Description")).toBeNull());
    // The draft renders as a preview paragraph (the textarea's value text must
    // not be mistaken for it).
    expect(screen.getByText("hello", { selector: "p" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Preview" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "Write" }).getAttribute("aria-selected")).toBe("false");

    fireEvent.click(screen.getByRole("tab", { name: "Write" }));
    await waitFor(() => expect(screen.getByLabelText("Description")).toBeTruthy());
    expect(screen.queryByText("hello", { selector: "p" })).toBeNull();
    expect(screen.getByRole("tab", { name: "Write" }).getAttribute("aria-selected")).toBe("true");
  });

  it("acknowledges a press on a toolbar tool", async () => {
    const onChange = vi.fn();
    render(<MarkdownComposer label="Description" value="" onChange={onChange} />);
    const bold = screen.getByRole("button", { name: "Bold" });
    fireEvent.pointerDown(bold, { pointerId: 1, isPrimary: true, buttons: 1 });
    // `pressFeedback.iconButton` is a scale token, so the dip lands on transform.
    await waitFor(() => expect(bold.style.transform).toContain("0.96"), { timeout: 1500 });
    fireEvent.pointerUp(bold, { pointerId: 1, isPrimary: true });
    await waitFor(() => expect(bold.style.transform).not.toContain("0.96"), { timeout: 1500 });
    // The acknowledgement never swallows the edit itself.
    expect(onChange).not.toHaveBeenCalled();
  });

  it("still wraps the selection when a tool is used", () => {
    const onChange = vi.fn();
    render(<MarkdownComposer label="Description" value="word" onChange={onChange} />);
    const area = screen.getByLabelText("Description") as HTMLTextAreaElement;
    area.setSelectionRange(0, 4);
    fireEvent.click(screen.getByRole("button", { name: "Bold" }));
    expect(onChange).toHaveBeenCalledWith("**word**");
  });
});
