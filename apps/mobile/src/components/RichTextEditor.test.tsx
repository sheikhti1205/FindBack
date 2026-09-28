// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import type { Editor } from "@tiptap/react";
import { RichTextEditor, markdownToTiptap, tiptapToMarkdown } from "./RichTextEditor";

afterEach(cleanup);

describe("richTextEditor converters", () => {
  it("round-trips supported markdown through tiptap JSON", () => {
    for (const md of [
      "**black wallet** near *Central Park*",
      "# Lost wallet",
      "## Details",
      "- lobby\n- gym",
      "> Ask at reception.",
      "> Guard said *it was found Tuesday*",
      "[photo](https://example.com/photo)",
      "**[photo](https://example.com/photo)**",
      "*[map](https://example.com/map)*",
      "***black*** ***[case](https://example.com/c)***",
      "3. one\n4. two",
      "# Lost keys\n\nSilver keychain.\n\n- lobby\n- gym\n\n> Ask at reception.",
    ]) {
      expect(tiptapToMarkdown(markdownToTiptap(md))).toBe(md);
    }
  });

  it("keeps a mixed quote in a single block", () => {
    const md = "> Guard said *it was found Tuesday*";
    const json = markdownToTiptap(md);
    expect(json.content).toHaveLength(1);
    expect(json.content?.[0]?.type).toBe("blockquote");
    expect(json.content?.[0]?.content).toHaveLength(1);
    expect(tiptapToMarkdown(json)).toBe(md);
  });

  it("preserves bold+link and italic+link editor marks", () => {
    const json = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "photo",
              marks: [{ type: "bold" }, { type: "link", attrs: { href: "https://example.com/p" } }],
            },
            { type: "text", text: " and " },
            {
              type: "text",
              text: "map",
              marks: [{ type: "italic" }, { type: "link", attrs: { href: "https://example.com/m" } }],
            },
          ],
        },
      ],
    };
    expect(tiptapToMarkdown(json)).toBe("**[photo](https://example.com/p)** and *[map](https://example.com/m)*");
  });

  it("keeps escaped metacharacters literal", () => {
    const md = "100\\* sure \\[not a link\\] \\(parens\\) \\\\ backslash";
    expect(tiptapToMarkdown(markdownToTiptap(md))).toBe(md);
  });

  it("preserves hard breaks inside a paragraph", () => {
    const md = "line one\nline two";
    const json = markdownToTiptap(md);
    expect(json.content).toHaveLength(1);
    expect(json.content?.[0]?.type).toBe("paragraph");
    expect(tiptapToMarkdown(json)).toBe(md);
  });

  it("keeps adjacent marks intact", () => {
    const md = "**black***wallet*[photo](https://example.com/p)";
    expect(tiptapToMarkdown(markdownToTiptap(md))).toBe(md);
  });

  it("persists numbered lists as real Markdown list blocks", () => {
    const json = {
      type: "doc",
      content: [
        {
          type: "orderedList",
          content: [
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }] },
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "two" }] }] },
          ],
        },
      ],
    };
    expect(tiptapToMarkdown(json)).toBe("1. one\n2. two");
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
  it("renders grouped formatting actions, placeholder text, and character count", () => {
    render(<RichTextEditor label="Description" value="" onChange={() => {}} placeholder="Describe the item" />);
    for (const name of ["Bold", "Italic", "Link", "Bullets", "Numbered", "Quote", "Clear all formatting", "Undo", "Redo", "Paste as Markdown"]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
    expect(screen.getByRole("button", { name: /Block type/i })).toBeTruthy();
    // Block menu options.
    fireEvent.click(screen.getByRole("button", { name: /Block type/i }));
    for (const name of ["Body", "Heading 1", "Heading 2", "Heading 3"]) {
      expect(screen.getByRole("menuitemradio", { name })).toBeTruthy();
    }
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Body" }));
    expect(screen.getByText("Describe the item")).toBeTruthy();
    expect(screen.getByText("Description")).toBeTruthy();
    expect(screen.getByLabelText("Character count").textContent).toBe("0 characters");
  });

  it("shows the initial markdown value", () => {
    const { container } = render(<RichTextEditor label="Description" value="# Lost wallet" onChange={() => {}} />);
    expect(container.querySelector(".tiptap")?.textContent).toContain("Lost wallet");
  });

  it("reports edits immediately so submit/unmount keeps final keystrokes", () => {
    const seen: string[] = [];
    const ref = createRef<Editor | null>();
    const { unmount } = render(
      <RichTextEditor label="Description" value="" onChange={(md) => seen.push(md)} editorRef={ref} />,
    );
    expect(ref.current).toBeTruthy();
    act(() => {
      ref.current?.commands.setContent(markdownToTiptap("final keystrokes"));
    });
    expect(seen).toContain("final keystrokes");
    unmount();
    expect(seen[seen.length - 1]).toBe("final keystrokes");
  });

  it("applies external value changes without change loops", () => {
    const onChange = vi.fn();
    const ref = createRef<Editor | null>();
    const { rerender } = render(
      <RichTextEditor label="Description" value="first" onChange={onChange} editorRef={ref} />,
    );
    expect(ref.current?.getText()).toContain("first");
    onChange.mockClear();
    rerender(<RichTextEditor label="Description" value="second" onChange={onChange} editorRef={ref} />);
    expect(ref.current?.getText()).toContain("second");
    expect(ref.current?.getText()).not.toContain("first");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not reset the editor when the parent echoes the emitted value", () => {
    let emitted = "";
    const onChange = vi.fn((md: string) => {
      emitted = md;
    });
    const ref = createRef<Editor | null>();
    const { rerender } = render(
      <RichTextEditor label="Description" value="" onChange={onChange} editorRef={ref} />,
    );
    act(() => {
      ref.current?.commands.setContent(markdownToTiptap("**typed**"));
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("**typed**");
    rerender(<RichTextEditor label="Description" value={emitted} onChange={onChange} editorRef={ref} />);
    expect(ref.current?.getText()).toContain("typed");
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("resets to empty on external clear", () => {
    const onChange = vi.fn();
    const ref = createRef<Editor | null>();
    const { rerender } = render(
      <RichTextEditor label="Description" value="**typed**" onChange={onChange} editorRef={ref} />,
    );
    expect(ref.current?.getText()).toContain("typed");
    rerender(<RichTextEditor label="Description" value="" onChange={onChange} editorRef={ref} />);
    expect(tiptapToMarkdown(ref.current?.getJSON())).toBe("");
  });

  it("shows a live character count", () => {
    const ref = createRef<Editor | null>();
    render(<RichTextEditor label="Description" value="hi" onChange={() => {}} editorRef={ref} />);
    expect(screen.getByLabelText("Character count").textContent).toBe("2 characters");
    act(() => {
      ref.current?.commands.setContent(markdownToTiptap("hello world"));
    });
    expect(screen.getByLabelText("Character count").textContent).toBe("11 characters");
  });

  it("supports undo and redo from the toolbar", () => {
    const ref = createRef<Editor | null>();
    render(<RichTextEditor label="Description" value="" onChange={() => {}} editorRef={ref} />);
    act(() => {
      ref.current?.commands.insertContent("hello");
    });
    expect(ref.current?.getText()).toContain("hello");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(ref.current?.getText()).not.toContain("hello");
    fireEvent.click(screen.getByRole("button", { name: "Redo" }));
    expect(ref.current?.getText()).toContain("hello");
  });

  it("clears formatting back to plain text", () => {
    const ref = createRef<Editor | null>();
    render(<RichTextEditor label="Description" value="" onChange={() => {}} editorRef={ref} />);
    act(() => {
      ref.current?.commands.setContent(markdownToTiptap("**bold** and *italic*"));
      ref.current?.commands.selectAll();
    });
    fireEvent.click(screen.getByRole("button", { name: "Clear all formatting" }));
    expect(tiptapToMarkdown(ref.current?.getJSON())).toBe("bold and italic");
  });

  it("toggles a numbered list from the toolbar", () => {
    const ref = createRef<Editor | null>();
    render(<RichTextEditor label="Description" value="" onChange={() => {}} editorRef={ref} />);
    act(() => {
      ref.current?.commands.insertContent("item");
    });
    fireEvent.click(screen.getByRole("button", { name: "Numbered" }));
    expect(ref.current?.isActive("orderedList")).toBe(true);
    expect(tiptapToMarkdown(ref.current?.getJSON())).toBe("1. item");
  });
});

describe("RichTextEditor security", () => {
  it("drops unsafe link targets from markdown, keeps display text", () => {
    const cases: Array<[string, string]> = [
      ["[evil](javascript:alert(1))", "evil"],
      ["[d](data:text/html,hi)", "d"],
      ["[f](file:///etc/passwd)", "f"],
      ["[v](vbscript:msgbox(1))", "v"],
      ["**[evil](javascript:alert(1))**", "evil"],
      ["*[evil](javascript:alert(1))*", "evil"],
    ];
    for (const [md, text] of cases) {
      const out = tiptapToMarkdown(markdownToTiptap(md));
      expect(out).not.toMatch(/\[[^\]]*\]\(\s*(javascript|data|file|vbscript):/i);
      expect(out).toContain(text);
    }
    expect(tiptapToMarkdown(markdownToTiptap("[evil](javascript:alert(1))"))).toBe("evil");
    expect(tiptapToMarkdown(markdownToTiptap("**[evil](javascript:alert(1))**"))).toBe("**evil**");
  });

  it("treats malformed links as inert text", () => {
    for (const md of [
      "[text](javascript:alert(1)",
      "[text]()",
      "[text](   )",
      "[unclosed",
      "[](https://example.com)",
      "[[nested]](https://example.com)",
    ]) {
      const out = tiptapToMarkdown(markdownToTiptap(md));
      expect(out).not.toMatch(/\[[^\]]*\]\(\s*javascript:/i);
      expect(out.length).toBeGreaterThan(0);
    }
  });

  it("neutralizes pasted HTML and script-like content", () => {
    const ref = createRef<Editor | null>();
    render(<RichTextEditor label="Description" value="" onChange={() => {}} editorRef={ref} />);
    act(() => {
      ref.current?.commands.insertContent(
        '<p>Hello <script>alert("x")</script> <b>raw</b> <img src="x" onerror="alert(1)"></p><p><a href="javascript:alert(1)">evil</a> <a href="https://example.com">safe</a></p>',
      );
    });
    const out = tiptapToMarkdown(ref.current?.getJSON() ?? null);
    expect(out).not.toMatch(/<script|<img|onerror|javascript:/i);
    expect(out).toContain("Hello");
    expect(out).toContain("evil");
    expect(out).toContain("[safe](https://example.com)");
  });

  it("keeps script-like markdown inert", () => {
    const out = tiptapToMarkdown(markdownToTiptap('<script>alert("x")</script>'));
    expect(out).not.toMatch(/<script/i);
    expect(out).toContain("script");
  });
});
