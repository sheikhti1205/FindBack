// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import type { Editor } from "@tiptap/react";
import { RichTextEditor, markdownToTiptap } from "./RichTextEditor";

afterEach(cleanup);

describe("RichTextEditor workset2 mobile layout", () => {
  it("orders label, editor, toolbar, count for mobile", () => {
    const { container } = render(<RichTextEditor label="Description" value="" onChange={() => {}} />);
    const root = container.firstElementChild as HTMLElement;
    const order = Array.from(root.children).map((el) => {
      if (el.tagName === "SPAN" && el.textContent === "Description") return "label";
      if (el.querySelector(".tiptap")) return "editor";
      if (el.getAttribute("role") === "toolbar") return "toolbar";
      if (el.getAttribute("role") === "status") return "count";
      return el.tagName;
    });
    expect(order).toEqual(["label", "editor", "toolbar", "count"]);
  });

  it("keeps the toolbar on one horizontally scrollable row with 44px targets", () => {
    render(<RichTextEditor label="Description" value="" onChange={() => {}} />);
    const toolbar = screen.getByRole("toolbar", { name: "Description formatting" });
    expect(toolbar.className).toMatch(/overflow-x-auto/);
    expect(toolbar.className).not.toMatch(/flex-wrap/);
    expect(toolbar.className).toMatch(/flex-nowrap|whitespace-nowrap/);
    for (const name of ["Bold", "Link"]) {
      const btn = screen.getByRole("button", { name });
      expect(btn.className).toMatch(/min-h-\[48px\]/);
      expect(btn.className).toMatch(/min-w-\[48px\]/);
    }
  });
});

describe("RichTextEditor workset2 visual marks", () => {
  it("bolds the selected word with a visual mark and no literal markdown", () => {
    const seen: string[] = [];
    const ref = createRef<Editor | null>();
    const { container } = render(
      <RichTextEditor label="Description" value="hello world" onChange={(md) => seen.push(md)} editorRef={ref} />,
    );
    expect(ref.current).toBeTruthy();
    act(() => {
      ref.current?.commands.setContent(markdownToTiptap("hello world"));
      ref.current?.commands.setTextSelection({ from: 1, to: 6 });
    });
    fireEvent.click(screen.getByRole("button", { name: "Bold" }));
    const last = seen[seen.length - 1] ?? "";
    expect(last).toBe("**hello** world");
    const editorEl = container.querySelector(".tiptap") as HTMLElement;
    expect(editorEl.querySelector("strong")).toBeTruthy();
    expect(editorEl.textContent).not.toContain("**");
  });

  it("links selected text with a visual mark and no literal markdown syntax", () => {
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("https://example.com/map");
    try {
      const seen: string[] = [];
      const ref = createRef<Editor | null>();
      const { container } = render(
        <RichTextEditor label="Description" value="see map here" onChange={(md) => seen.push(md)} editorRef={ref} />,
      );
      act(() => {
        ref.current?.commands.setContent(markdownToTiptap("see map here"));
        ref.current?.commands.setTextSelection({ from: 5, to: 8 });
      });
      fireEvent.click(screen.getByRole("button", { name: "Link" }));
      const last = seen[seen.length - 1] ?? "";
      expect(last).toBe("see [map](https://example.com/map) here");
      const editorEl = container.querySelector(".tiptap") as HTMLElement;
      const link = editorEl.querySelector('a[href="https://example.com/map"]');
      expect(link).toBeTruthy();
      expect(editorEl.textContent).not.toContain("[map]");
      expect(editorEl.textContent).not.toContain("](https://");
    } finally {
      promptSpy.mockRestore();
    }
  });
});
