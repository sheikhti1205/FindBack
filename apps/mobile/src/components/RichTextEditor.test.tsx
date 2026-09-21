// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { createRef } from "react";
import type { Editor } from "@tiptap/react";
import {
  RICH_TEXT_DEBOUNCE_MS,
  RichTextEditor,
  markdownToTiptap,
  tiptapToMarkdown,
} from "./RichTextEditor";

afterEach(cleanup);

describe("richTextEditor converters", () => {
  it("round-trips supported markdown through tiptap JSON", () => {
    for (const md of [
      "**black wallet** near *Central Park*",
      "# Lost wallet",
      "## Details",
      "- lobby\n- gym",
      "> Ask at reception.",
      "[photo](https://example.com/photo)",
      "# Lost keys\n\nSilver keychain.\n\n- lobby\n- gym\n\n> Ask at reception.",
    ]) {
      expect(tiptapToMarkdown(markdownToTiptap(md))).toBe(md);
    }
  });

  it("drops unsafe link marks, keeps the display text", () => {
    const json = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "click", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] }],
        },
      ],
    };
    const md = tiptapToMarkdown(json);
    expect(md).toContain("click");
    expect(md).not.toContain("javascript:");
  });

  it("never throws on hostile JSON", () => {
    for (const bad of [null, undefined, 42, "nope", { type: "doc" }, { content: "nope" }, { content: [{ nope: true }] }]) {
      expect(() => tiptapToMarkdown(bad)).not.toThrow();
      expect(() => markdownToTiptap(bad as unknown as string)).not.toThrow();
    }
    expect(tiptapToMarkdown(null)).toBe("");
  });
});

describe("RichTextEditor", () => {
  it("renders the YAGNI toolbar and placeholder text", () => {
    render(<RichTextEditor label="Description" value="" onChange={() => {}} placeholder="Describe the item" />);
    for (const name of ["Paragraph", "Heading", "Bullet list", "Quote", "Bold", "Italic", "Link"]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
    expect(screen.getByText("Describe the item")).toBeTruthy();
    expect(screen.getByText("Description")).toBeTruthy();
  });

  it("shows the initial markdown value", () => {
    const { container } = render(<RichTextEditor label="Description" value="# Lost wallet" onChange={() => {}} />);
    expect(container.querySelector(".tiptap")?.textContent).toContain("Lost wallet");
  });

  it("emits debounced markdown after an edit", () => {
    const onChange = vi.fn();
    const ref = createRef<Editor | null>();
    render(<RichTextEditor label="Description" value="" onChange={onChange} editorRef={ref} />);
    expect(ref.current).toBeTruthy();
    vi.useFakeTimers();
    act(() => {
      ref.current?.commands.setContent(markdownToTiptap("**black wallet**"));
    });
    expect(onChange).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(RICH_TEXT_DEBOUNCE_MS + 50);
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("**black wallet**");
    vi.useRealTimers();
  });
});
