// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import type { Editor } from "@tiptap/react";
import { RichTextEditor, markdownToTiptap, tiptapToMarkdown } from "./RichTextEditor";
import { MarkdownView } from "./MarkdownView";
import { measureDescription } from "../services/richText";

afterEach(cleanup);

describe("ED-02/ED-06 heading + toolbar menus", () => {
  it("offers Body/H1/H2/H3 menu with current-block label and aria-expanded", () => {
    render(<RichTextEditor label="Description" value="hello" onChange={() => {}} />);
    const bodyMenu = screen.getByRole("button", { name: /Body|Block type|Heading/i });
    expect(bodyMenu.getAttribute("aria-haspopup")).toMatch(/menu|listbox|dialog/);
    fireEvent.click(bodyMenu);
    expect(bodyMenu.getAttribute("aria-expanded")).toBe("true");
    for (const name of ["Body", "Heading 1", "Heading 2", "Heading 3"]) {
      expect(screen.getByRole("menuitemradio", { name })).toBeTruthy();
    }
  });

  it("sets H1 via menu and keeps H2 when re-chosen (no toggle-off)", () => {
    const ref = createRef<Editor | null>();
    render(<RichTextEditor label="Description" value="hello" onChange={() => {}} editorRef={ref} />);
    fireEvent.click(screen.getByRole("button", { name: /Body|Block type|Heading/i }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Heading 1" }));
    expect(ref.current?.isActive("heading", { level: 1 })).toBe(true);
    expect(tiptapToMarkdown(ref.current?.getJSON())).toBe("# hello");
    // Re-choose H2 twice: stays H2.
    fireEvent.click(screen.getByRole("button", { name: /Body|Block type|Heading|Heading 1/i }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Heading 2" }));
    expect(tiptapToMarkdown(ref.current?.getJSON())).toBe("## hello");
    fireEvent.click(screen.getByRole("button", { name: /Heading 2|Block type|Body/i }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Heading 2" }));
    expect(tiptapToMarkdown(ref.current?.getJSON())).toBe("## hello");
    // Body converts back to paragraph.
    fireEvent.click(screen.getByRole("button", { name: /Heading 2|Block type|Body/i }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Body" }));
    expect(tiptapToMarkdown(ref.current?.getJSON())).toBe("hello");
  });

  it("groups directly accessible structure and cleanup actions", () => {
    render(<RichTextEditor label="Description" value="" onChange={() => {}} />);
    expect(screen.getByRole("group", { name: "Structure" })).toBeTruthy();
    for (const name of ["Bullets", "Numbered", "Quote", "Clear all formatting"]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
  });
});

describe("ED-04 stale selection safety", () => {
  it("does NOT bold stale text after intentional editor navigation (tap + caret move)", () => {
    const seen: string[] = [];
    const ref = createRef<Editor | null>();
    const { container } = render(
      <RichTextEditor label="Description" value="hello world" onChange={(md) => seen.push(md)} editorRef={ref} />,
    );
    act(() => {
      ref.current?.commands.setContent(markdownToTiptap("hello world"));
      ref.current?.commands.setTextSelection({ from: 1, to: 6 });
    });
    // Intentional tap inside the editor invalidates the stashed range.
    const editorEl = container.querySelector(".tiptap") as HTMLElement;
    fireEvent.pointerDown(editorEl);
    act(() => {
      ref.current?.commands.setTextSelection({ from: 12, to: 12 });
    });
    fireEvent.click(screen.getByRole("button", { name: "Bold" }));
    const last = seen[seen.length - 1] ?? tiptapToMarkdown(ref.current?.getJSON());
    expect(last).not.toContain("**hello**");
  });

  it("invalidates stashed range after draft restore replaces content", () => {
    const ref = createRef<Editor | null>();
    const seen: string[] = [];
    const { rerender } = render(
      <RichTextEditor label="Description" value="hello world" onChange={(md) => seen.push(md)} editorRef={ref} />,
    );
    act(() => {
      ref.current?.commands.setContent(markdownToTiptap("hello world"));
      ref.current?.commands.setTextSelection({ from: 1, to: 6 });
    });
    rerender(<RichTextEditor label="Description" value="completely different draft text here" onChange={(md) => seen.push(md)} editorRef={ref} />);
    act(() => {
      // Collapse (as toolbar focus loss would) after restore.
      try { ref.current?.commands.setTextSelection({ from: 1, to: 1 }); } catch { /* noop */ }
    });
    const before = tiptapToMarkdown(ref.current?.getJSON());
    fireEvent.click(screen.getByRole("button", { name: "Bold" }));
    const after = tiptapToMarkdown(ref.current?.getJSON());
    // Must not re-apply bold to the old "hello" range in the new doc.
    expect(after).not.toContain("**hello**");
    expect(before).toContain("completely different");
  });
});

describe("ED-05 truthful counting", () => {
  it("measures stored markdown length, not just visible text", () => {
    const visible = "a".repeat(2995);
    const md = `## ${visible} **[x](https://example.com/very/long/path?query=1234567890)**`;
    const m = measureDescription(md);
    expect(m.visibleLength).toBeLessThanOrEqual(3100);
    expect(m.storedLength).toBeGreaterThan(m.visibleLength);
    expect(m.storedLength).toBe(md.trim().length);
  });

  it("flags a massive URL with short display text as over-limit storage", () => {
    const md = `[tap](${`https://example.com/${"a".repeat(4000)}`})`;
    const m = measureDescription(md);
    expect(m.visibleLength).toBeLessThan(10);
    expect(m.storedLength).toBeGreaterThan(3000);
  });

  it("editor count reflects stored size when formatting is present", () => {
    const ref = createRef<Editor | null>();
    render(<RichTextEditor label="Description" value="hello" onChange={() => {}} editorRef={ref} maxLength={3000} />);
    act(() => {
      ref.current?.commands.setContent(markdownToTiptap("**hello** world"));
    });
    const count = screen.getByLabelText("Character count").textContent ?? "";
    // Stored "**hello** world" is 15 chars, visible "hello world" is 11.
    expect(count).toMatch(/15\s*\/\s*3000/);
  });
});

describe("ED-07 safe link edit/remove", () => {
  it("opens an edit dialog (not instant delete) at a collapsed caret inside a link", () => {
    const ref = createRef<Editor | null>();
    render(<RichTextEditor label="Description" value="see map here" onChange={() => {}} editorRef={ref} />);
    act(() => {
      ref.current?.commands.setContent(markdownToTiptap("see [map](https://example.com/map) here"));
      // Caret inside "map" (collapsed).
      ref.current?.commands.setTextSelection({ from: 6, to: 6 });
    });
    fireEvent.click(screen.getByRole("button", { name: "Link" }));
    expect(screen.getByRole("dialog", { name: "Edit link" })).toBeTruthy();
    // Link still present (not instantly removed).
    expect(tiptapToMarkdown(ref.current?.getJSON())).toContain("https://example.com/map");
  });

  it("removes the link via explicit Remove action but keeps display text", () => {
    const ref = createRef<Editor | null>();
    render(<RichTextEditor label="Description" value="see map here" onChange={() => {}} editorRef={ref} />);
    act(() => {
      ref.current?.commands.setContent(markdownToTiptap("see [map](https://example.com/map) here"));
      ref.current?.commands.setTextSelection({ from: 6, to: 6 });
    });
    fireEvent.click(screen.getByRole("button", { name: "Link" }));
    fireEvent.click(screen.getByRole("button", { name: /Remove link/i }));
    expect(tiptapToMarkdown(ref.current?.getJSON())).toBe("see map here");
  });
});

describe("ED-09 no multiline/nested list data loss", () => {
  it("preserves text across multi-paragraph list items without merging words", () => {
    const json = {
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "first para" }] },
                { type: "paragraph", content: [{ type: "text", text: "second para" }] },
              ],
            },
          ],
        },
      ],
    };
    const md = tiptapToMarkdown(json);
    expect(md).toContain("first para");
    expect(md).toContain("second para");
    expect(md).not.toMatch(/first parasecond para/);
  });

  it("preserves nested list text instead of dropping it", () => {
    const json = {
      type: "doc",
      content: [
        {
          type: "orderedList",
          attrs: { start: 1 },
          content: [
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "outer" }] },
                {
                  type: "bulletList",
                  content: [
                    { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "inner nested" }] }] },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const md = tiptapToMarkdown(json);
    expect(md).toContain("outer");
    expect(md).toContain("inner nested");
  });

  it("keeps surrounding items when a blank list item exists", () => {
    const json = {
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }] },
            { type: "listItem", content: [{ type: "paragraph" }] },
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "three" }] }] },
          ],
        },
      ],
    };
    const md = tiptapToMarkdown(json);
    expect(md).toContain("one");
    expect(md).toContain("three");
  });
});

describe("ED-03 published heading hierarchy", () => {
  it("renders three distinct heading levels (no H2/H3 collapse)", () => {
    const { container } = render(<MarkdownView text={"# H1\n\n## H2\n\n### H3"} />);
    expect(container.querySelector("h1")).toBeNull();
    expect(container.querySelector("h2")).toBeTruthy();
    expect(container.querySelector("h3")).toBeTruthy();
    expect(container.querySelector("h4")).toBeTruthy();
    expect(container.querySelector("h2")?.textContent).toBe("H1");
    expect(container.querySelector("h3")?.textContent).toBe("H2");
    expect(container.querySelector("h4")?.textContent).toBe("H3");
  });
});
