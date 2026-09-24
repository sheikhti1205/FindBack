// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import type { Editor } from "@tiptap/react";
import {
  RichTextEditor,
  markdownToTiptap,
  tiptapListsWereSimplified,
  tiptapToMarkdown,
} from "./RichTextEditor";

afterEach(cleanup);

describe("menu keyboard handling", () => {
  it("moves focus with ArrowDown/ArrowUp (wrapping) and Home/End in the Block menu", () => {
    render(<RichTextEditor label="Description" value="hello" onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Block type/i }));
    const menu = screen.getByRole("menu", { name: "Block type" });
    const body = screen.getByRole("menuitemradio", { name: "Body" });
    // Opening the menu moves focus to the current (checked) item.
    expect(document.activeElement).toBe(body);
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("menuitemradio", { name: "Heading 1" }));
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("menuitemradio", { name: "Heading 3" }));
    // Wraps past the end back to the start.
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(body);
    // ArrowUp from the first item wraps to the last.
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(document.activeElement).toBe(screen.getByRole("menuitemradio", { name: "Heading 3" }));
    fireEvent.keyDown(menu, { key: "Home" });
    expect(document.activeElement).toBe(body);
    fireEvent.keyDown(menu, { key: "End" });
    expect(document.activeElement).toBe(screen.getByRole("menuitemradio", { name: "Heading 3" }));
  });

  it("Escape closes the menu and restores focus to the menu button", () => {
    render(<RichTextEditor label="Description" value="hello" onChange={() => {}} />);
    const menuButton = screen.getByRole("button", { name: /Block type/i });
    fireEvent.click(menuButton);
    expect(screen.getByRole("menu", { name: "Block type" })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("menuitemradio", { name: "Heading 1" }), { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Block type" })).toBeNull();
    expect(document.activeElement).toBe(menuButton);
  });

  it("outside pointerdown closes an open menu", () => {
    render(<RichTextEditor label="Description" value="hello" onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    expect(screen.getByRole("menu", { name: "List" })).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu", { name: "List" })).toBeNull();
  });

  it("skips disabled items while arrowing through the More menu", () => {
    const ref = createRef<Editor | null>();
    render(<RichTextEditor label="Description" value="" onChange={() => {}} editorRef={ref} />);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    const menu = screen.getByRole("menu", { name: "More formatting options" });
    const quote = screen.getByRole("menuitem", { name: "Quote" });
    expect(document.activeElement).toBe(quote);
    // Undo/Redo are disabled in a fresh empty editor and must be skipped.
    expect((screen.getByRole("menuitem", { name: "Undo" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Clear all formatting" }));
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    // Skips disabled Undo/Redo and wraps to Quote.
    expect(document.activeElement).toBe(quote);
  });
});

describe("narrow-viewport/IME-safe popup positioning", () => {
  it("constrains menus to the viewport with internal scroll and keeps 48px targets", () => {
    render(<RichTextEditor label="Description" value="hello" onChange={() => {}} />);
    for (const buttonName of [/Block type/i, "List", "More"] as const) {
      fireEvent.click(screen.getByRole("button", { name: buttonName }));
      const menu = document.querySelector('[role="menu"]') as HTMLElement;
      expect(menu).toBeTruthy();
      // Never wider than the viewport (320–360dp Android) and never taller
      // than the visible area above the IME: internal scroll instead.
      expect(menu.className).toMatch(/max-w-\[calc\(100vw-2rem\)\]/);
      expect(menu.className).toMatch(/max-h-/);
      expect(menu.className).toMatch(/overflow-y-auto/);
      for (const item of Array.from(menu.querySelectorAll("button"))) {
        expect(item.className).toMatch(/min-h-\[48px\]/);
      }
      fireEvent.keyDown(menu, { key: "Escape" });
    }
  });
});

describe("ED-09 list-simplification honesty", () => {
  it("detects nested lists as simplified", () => {
    expect(
      tiptapListsWereSimplified({
        type: "doc",
        content: [
          {
            type: "orderedList",
            content: [
              {
                type: "listItem",
                content: [
                  { type: "paragraph", content: [{ type: "text", text: "outer" }] },
                  {
                    type: "bulletList",
                    content: [
                      { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "inner" }] }] },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
    ).toBe(true);
  });

  it("detects multi-paragraph list items as simplified", () => {
    expect(
      tiptapListsWereSimplified({
        type: "doc",
        content: [
          {
            type: "bulletList",
            content: [
              {
                type: "listItem",
                content: [
                  { type: "paragraph", content: [{ type: "text", text: "one" }] },
                  { type: "paragraph", content: [{ type: "text", text: "two" }] },
                ],
              },
            ],
          },
        ],
      }),
    ).toBe(true);
  });

  it("reports flat single-paragraph lists and list-free docs as not simplified", () => {
    expect(tiptapListsWereSimplified(markdownToTiptap("- one\n- two"))).toBe(false);
    expect(tiptapListsWereSimplified(markdownToTiptap("plain paragraph"))).toBe(false);
    expect(tiptapListsWereSimplified(null)).toBe(false);
  });

  it("shows a user-visible notice while the document simplifies lists", () => {
    const ref = createRef<Editor | null>();
    render(<RichTextEditor label="Description" value="hello" onChange={() => {}} editorRef={ref} />);
    expect(screen.queryByLabelText("List simplification notice")).toBeNull();
    act(() => {
      ref.current?.commands.setContent({
        type: "doc",
        content: [
          {
            type: "bulletList",
            content: [
              {
                type: "listItem",
                content: [
                  { type: "paragraph", content: [{ type: "text", text: "outer" }] },
                  {
                    type: "bulletList",
                    content: [
                      { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "inner" }] }] },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      });
    });
    const notice = screen.getByLabelText("List simplification notice");
    expect(notice.textContent).toMatch(/flat list/i);
    // Serialized output still preserves the words (no silent data loss).
    expect(tiptapToMarkdown(ref.current?.getJSON())).toContain("inner");
    act(() => {
      ref.current?.commands.setContent(markdownToTiptap("plain text now"));
    });
    expect(screen.queryByLabelText("List simplification notice")).toBeNull();
  });
});

describe("ED-07 link Open preview", () => {
  it("offers a safe Open link action when editing an existing link", () => {
    const ref = createRef<Editor | null>();
    render(<RichTextEditor label="Description" value="see map here" onChange={() => {}} editorRef={ref} />);
    act(() => {
      ref.current?.commands.setContent(markdownToTiptap("see [map](https://example.com/map) here"));
      ref.current?.commands.setTextSelection({ from: 6, to: 6 });
    });
    fireEvent.click(screen.getByRole("button", { name: "Link" }));
    const open = screen.getByRole("link", { name: /Open link/i });
    expect(open.getAttribute("href")).toBe("https://example.com/map");
    expect(open.getAttribute("target")).toBe("_blank");
    expect(open.getAttribute("rel")).toContain("noopener");
  });

  it("shows no Open link action when adding a fresh link", () => {
    const ref = createRef<Editor | null>();
    render(<RichTextEditor label="Description" value="see map here" onChange={() => {}} editorRef={ref} />);
    act(() => {
      ref.current?.commands.setContent(markdownToTiptap("see map here"));
      ref.current?.commands.setTextSelection({ from: 5, to: 8 });
    });
    fireEvent.click(screen.getByRole("button", { name: "Link" }));
    expect(screen.getByRole("dialog", { name: "Add link" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Open link/i })).toBeNull();
  });
});
