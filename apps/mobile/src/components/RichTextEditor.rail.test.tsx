// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createRef } from "react";
import type { Editor } from "@tiptap/react";
import { RichTextEditor, tiptapToMarkdown } from "./RichTextEditor";
import { settleSelectionRender } from "../test-utils/editorSelection";

afterEach(cleanup);
// jsdom does not implement Range geometry used by ProseMirror's scroll-to-selection.
if (!("getClientRects" in Range.prototype)) {
  Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [] });
}
if (!("getBoundingClientRect" in Range.prototype)) {
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }),
  });
}

describe("Report editor caret formatting", () => {
  it("toggles Bold at an empty caret on and off without formatting subsequent plain typing", async () => {
    const ref = createRef<Editor | null>();
    render(<RichTextEditor label="Description" value="intro" onChange={() => {}} editorRef={ref} />);
    act(() => {
      ref.current?.commands.setContent({ type: "doc", content: [
        { type: "paragraph", content: [{ type: "text", text: "intro" }] },
        { type: "paragraph" },
      ] });
      ref.current?.commands.setTextSelection(ref.current.state.doc.content.size - 1);
    });
    const bold = screen.getByRole("button", { name: "Bold" });
    fireEvent.click(bold);
    expect(ref.current?.state.storedMarks?.some((mark) => mark.type.name === "bold")).toBe(true);
    expect(bold.getAttribute("aria-pressed")).toBe("true");
    act(() => ref.current?.commands.insertContent("bold"));
    expect(tiptapToMarkdown(ref.current?.getJSON())).toBe("intro\n\n**bold**");
    fireEvent.click(bold);
    expect(ref.current?.state.storedMarks?.some((mark) => mark.type.name === "bold")).toBe(false);
    expect(bold.getAttribute("aria-pressed")).toBe("false");
    await settleSelectionRender();
    act(() => ref.current?.commands.insertContent(" plain"));
    expect(tiptapToMarkdown(ref.current?.getJSON())).toBe("intro\n\n**bold** plain");
  });

  it("toggles selected text twice without losing the selected range", async () => {
    const ref = createRef<Editor | null>();
    render(<RichTextEditor label="Description" value="hello world" onChange={() => {}} editorRef={ref} />);
    act(() => ref.current?.commands.setTextSelection({ from: 1, to: 6 }));
    await settleSelectionRender();
    const bold = screen.getByRole("button", { name: "Bold" });
    fireEvent.click(bold);
    expect(tiptapToMarkdown(ref.current?.getJSON())).toBe("**hello** world");
    expect(bold.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(bold);
    expect(tiptapToMarkdown(ref.current?.getJSON())).toBe("hello world");
    expect(bold.getAttribute("aria-pressed")).toBe("false");
  });

  it("updates Bold when moving the caret between bold and plain text", async () => {
    const ref = createRef<Editor | null>();
    render(<RichTextEditor label="Description" value="**bold** plain" onChange={() => {}} editorRef={ref} />);
    const bold = screen.getByRole("button", { name: "Bold" });
    act(() => ref.current?.commands.setTextSelection(3));
    await settleSelectionRender();
    expect(bold.getAttribute("aria-pressed")).toBe("true");
    act(() => ref.current?.commands.setTextSelection(9));
    await settleSelectionRender();
    expect(bold.getAttribute("aria-pressed")).toBe("false");
  });
});

describe("Report editor formatting rail", () => {
  it("exposes all primary actions in grouped horizontally scrollable rail in both modes", () => {
    render(<RichTextEditor label="Description" value="hello" onChange={() => {}} />);
    for (const mode of ["inline", "fullscreen"]) {
      if (mode === "fullscreen") fireEvent.click(screen.getByRole("button", { name: "Expand description editor" }));
      const rail = screen.getByRole("toolbar", { name: "Description formatting" });
      expect(rail.className).toContain("overflow-x-auto");
      expect(rail.className).toContain("flex-nowrap");
      for (const name of ["Undo", "Redo", "Bold", "Italic", "Bullets", "Numbered", "Quote", "Link", "Paste as Markdown"]) {
        expect(within(rail).getByRole("button", { name })).toBeTruthy();
      }
      expect(within(rail).getByRole("button", { name: /Block type/ })).toBeTruthy();
      expect(within(rail).getByRole("button", { name: "Clear all formatting" })).toBeTruthy();
      expect(within(rail).queryByRole("button", { name: "More" })).toBeNull();
    }
  });

  it("keeps one independently scrolling content area above the pinned rail inside the visual viewport", () => {
    render(<RichTextEditor label="Description" value="hello" onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Expand description editor" }));
    const overlay = document.getElementById("report-editor-overlay")!;
    const scroller = screen.getByTestId("report-editor-scroller");
    const rail = within(overlay).getByRole("toolbar", { name: "Description formatting" });
    expect(overlay.style.height).toContain("--fb-visible-height");
    expect(scroller.className).toContain("overflow-y-auto");
    expect(scroller.contains(rail)).toBe(false);
    expect(scroller.compareDocumentPosition(rail) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(rail.parentElement?.className).toContain("flex-shrink-0");
    expect(rail.parentElement?.getAttribute("style")).toContain("safe-area-inset-bottom");
    expect(scroller.querySelector(".tiptap")?.className).not.toContain("overflow-y-auto");
  });

  it("inserts clipboard Markdown at the captured selection even when the async read moves the caret", async () => {
    const ref = createRef<Editor | null>();
    let resolveClipboard!: (value: string) => void;
    const readText = vi.fn(() => new Promise<string>((resolve) => { resolveClipboard = resolve; }));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText } });
    try {
      render(<RichTextEditor label="Description" value="before after" onChange={() => {}} editorRef={ref} />);
      act(() => ref.current?.commands.setTextSelection({ from: 8, to: 13 }));
      await settleSelectionRender();
      fireEvent.click(screen.getByRole("button", { name: "Paste as Markdown" }));
      act(() => ref.current?.commands.setTextSelection(1));
      await act(async () => resolveClipboard("**replacement**"));
      expect(tiptapToMarkdown(ref.current?.getJSON())).toBe("before \n\n**replacement**");
    } finally {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    }
  });

  it("discards clipboard input begun before a lock even when it settles after unlocking", async () => {
    const ref = createRef<Editor | null>();
    const onChange = vi.fn();
    let resolveClipboard!: (value: string) => void;
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText: () => new Promise<string>((resolve) => { resolveClipboard = resolve; }) } });
    try {
      const { rerender } = render(<RichTextEditor label="Description" value="before after" onChange={onChange} editorRef={ref} />);
      fireEvent.click(screen.getByRole("button", { name: "Paste as Markdown" }));
      rerender(<RichTextEditor label="Description" value="before after" onChange={onChange} editorRef={ref} disabled />);
      rerender(<RichTextEditor label="Description" value="before after" onChange={onChange} editorRef={ref} />);
      await act(async () => resolveClipboard("**late clipboard**"));
      expect(ref.current?.getText()).toBe("before after");
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    }
  });
});
