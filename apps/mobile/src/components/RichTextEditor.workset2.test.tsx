// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import type { Editor } from "@tiptap/react";
import { RichTextEditor, markdownToTiptap, tiptapToMarkdown } from "./RichTextEditor";

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

  it("keeps combined Bold and Italic on only the selected word across Markdown restore", () => {
    const ref = createRef<Editor | null>();
    const { container } = render(<RichTextEditor label="Description" value="The phone has a black case." onChange={() => {}} editorRef={ref} />);
    act(() => ref.current?.commands.setTextSelection({ from: 17, to: 22 }));
    fireEvent.click(screen.getByRole("button", { name: "Bold" }));
    fireEvent.click(screen.getByRole("button", { name: "Italic" }));
    expect(tiptapToMarkdown(ref.current?.getJSON())).toBe("The phone has a ***black*** case.");
    expect(container.querySelector(".tiptap strong em")?.textContent).toBe("black");
    expect(markdownToTiptap(tiptapToMarkdown(ref.current?.getJSON())).content).toBeTruthy();
  });

  it("links precisely the selected text through a cancellable sheet, never a browser prompt", () => {
    const promptSpy = vi.spyOn(window, "prompt");
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
       expect(screen.getByRole("dialog", { name: "Add link" })).toBeTruthy();
       expect((screen.getByLabelText("Selected text") as HTMLInputElement).value).toBe("map");
       expect(promptSpy).not.toHaveBeenCalled();
       fireEvent.change(screen.getByLabelText("URL"), { target: { value: "https://example.com/map" } });
       fireEvent.click(screen.getByRole("button", { name: "Add link" }));
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

  it("leaves the selected word unchanged when the link sheet is cancelled", () => {
    const ref = createRef<Editor | null>();
    render(<RichTextEditor label="Description" value="see map here" onChange={() => {}} editorRef={ref} />);
    act(() => ref.current?.commands.setTextSelection({ from: 5, to: 8 }));
    fireEvent.click(screen.getByRole("button", { name: "Link" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(tiptapToMarkdown(ref.current?.getJSON())).toBe("see map here");
  });

  it("disables Link at an unlinked caret and rejects unsafe URLs without changing marks", () => {
    const ref = createRef<Editor | null>();
    render(<RichTextEditor label="Description" value="see map here" onChange={() => {}} editorRef={ref} />);
    expect((screen.getByRole("button", { name: "Link" }) as HTMLButtonElement).disabled).toBe(true);
    act(() => ref.current?.commands.setTextSelection({ from: 5, to: 8 }));
    fireEvent.click(screen.getByRole("button", { name: "Link" }));
    fireEvent.change(screen.getByLabelText("URL"), { target: { value: "javascript:alert(1)" } });
    fireEvent.click(screen.getByRole("button", { name: "Add link" }));
    expect(screen.getByRole("alert").textContent).toMatch(/safe HTTP/i);
    expect(tiptapToMarkdown(ref.current?.getJSON())).toBe("see map here");
  });
});

describe("RichTextEditor selection preservation (toolbar focus loss)", () => {
  it("bolds only the originally selected word after the visible selection collapses (focus moved to toolbar)", () => {
    const seen: string[] = [];
    const ref = createRef<Editor | null>();
    render(
      <RichTextEditor label="Description" value="hello world" onChange={(md) => seen.push(md)} editorRef={ref} />,
    );
    expect(ref.current).toBeTruthy();
    act(() => {
      ref.current?.commands.setContent(markdownToTiptap("hello world"));
      ref.current?.commands.setTextSelection({ from: 1, to: 6 });
    });
    // Simulate focus moving from the editor/WebView to a bottom-toolbar button:
    // the visible DOM selection collapses (Android long-press popup focus loss).
    act(() => {
      ref.current?.commands.setTextSelection({ from: 12, to: 12 });
    });
    fireEvent.click(screen.getByRole("button", { name: "Bold" }));
    const last = seen[seen.length - 1] ?? "";
    expect(last).toBe("**hello** world");
  });

  it("italicizes only the originally selected word after the visible selection collapses", () => {
    const seen: string[] = [];
    const ref = createRef<Editor | null>();
    render(
      <RichTextEditor label="Description" value="hello world" onChange={(md) => seen.push(md)} editorRef={ref} />,
    );
    expect(ref.current).toBeTruthy();
    act(() => {
      ref.current?.commands.setContent(markdownToTiptap("hello world"));
      ref.current?.commands.setTextSelection({ from: 7, to: 12 });
    });
    // Simulate toolbar focus loss: collapse the visible selection at the start.
    act(() => {
      ref.current?.commands.setTextSelection({ from: 1, to: 1 });
    });
    fireEvent.click(screen.getByRole("button", { name: "Italic" }));
    const last = seen[seen.length - 1] ?? "";
    expect(last).toBe("hello *world*");
  });

  it("applies the link to the pre-dialog range even though focus moved to the toolbar/dialog", () => {
    const seen: string[] = [];
    const ref = createRef<Editor | null>();
    render(
      <RichTextEditor label="Description" value="see map here" onChange={(md) => seen.push(md)} editorRef={ref} />,
    );
    act(() => {
      ref.current?.commands.setContent(markdownToTiptap("see map here"));
      ref.current?.commands.setTextSelection({ from: 5, to: 8 });
    });
    // Simulate focus loss to the toolbar before the link dialog opens.
    act(() => {
      ref.current?.commands.setTextSelection({ from: 13, to: 13 });
    });
    fireEvent.click(screen.getByRole("button", { name: "Link" }));
    expect(screen.getByRole("dialog", { name: "Add link" })).toBeTruthy();
    expect((screen.getByLabelText("Selected text") as HTMLInputElement).value).toBe("map");
    fireEvent.change(screen.getByLabelText("URL"), { target: { value: "https://example.com/map" } });
    fireEvent.click(screen.getByRole("button", { name: "Add link" }));
    const last = seen[seen.length - 1] ?? "";
    expect(last).toBe("see [map](https://example.com/map) here");
  });
});
