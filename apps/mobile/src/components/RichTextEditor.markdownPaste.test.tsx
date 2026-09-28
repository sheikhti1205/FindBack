// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import type { Editor } from "@tiptap/react";
import { RichTextEditor, markdownToTiptap, tiptapToMarkdown } from "./RichTextEditor";

afterEach(cleanup);

// jsdom Range lacks getClientRects, which prosemirror-view's
// scrollToSelection calls (via textRange) on selection-changing dispatches.
// Polyfill it so paste/insert tests exercise the real dispatch path without
// unhandled errors (production browsers implement it natively).
if (typeof Range !== "undefined") {
  const zeroRect = () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 });
  if (!("getClientRects" in Range.prototype)) {
    Object.defineProperty(Range.prototype, "getClientRects", {
      value: () => [],
      configurable: true,
    });
  }
  if (!("getBoundingClientRect" in Range.prototype)) {
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      value: zeroRect,
      configurable: true,
    });
  }
}

const CHATGPT_MD = ["# Lost Wallet", "", "Found near the **library**.", "", "- Black", "- Empty"].join("\n");

function fakePasteEvent(text: string, html = ""): unknown {
  return {
    clipboardData: {
      getData: (type: string) => (type === "text/html" ? html : type === "text/plain" ? text : ""),
    },
    preventDefault: () => {},
  };
}

function runHandlePaste(ref: React.RefObject<Editor | null>, event: unknown): unknown {
  // NB: view.someProp swallows falsy handler results, so the tests call the
  // registered prop directly — the same function the view invokes on paste.
  let result: unknown;
  act(() => {
    const view = ref.current?.view;
    const handler = view?.props.handlePaste as
      | ((view: unknown, event: unknown) => boolean)
      | undefined;
    result = handler?.(view, event);
  });
  return result;
}

describe("RichTextEditor Markdown paste", () => {
  it("parses recognizably-Markdown plain text into formatted nodes", () => {
    const seen: string[] = [];
    const ref = createRef<Editor | null>();
    const { container } = render(
      <RichTextEditor label="Description" value="" onChange={(md) => seen.push(md)} editorRef={ref} />,
    );
    expect(ref.current).toBeTruthy();
    const handled = runHandlePaste(ref, fakePasteEvent(CHATGPT_MD));
    expect(handled).toBe(true);
    const stored = tiptapToMarkdown(ref.current?.getJSON());
    expect(stored).toContain("# Lost Wallet");
    expect(stored).toContain("Found near the **library**.");
    expect(stored).toContain("- Black");
    const editorEl = container.querySelector(".tiptap") as HTMLElement;
    expect(editorEl.querySelector("h1")).toBeTruthy();
    expect(editorEl.querySelector("strong")?.textContent).toBe("library");
    expect(editorEl.textContent).not.toContain("# Lost Wallet");
    expect(seen.length).toBeGreaterThan(0);
  });

  it("leaves rich clipboard (text/html) to the native path", () => {
    const ref = createRef<Editor | null>();
    render(<RichTextEditor label="Description" value="plain" onChange={() => {}} editorRef={ref} />);
    const handled = runHandlePaste(ref, fakePasteEvent(CHATGPT_MD, "<h1>rich</h1>"));
    expect(handled).toBe(false);
    expect(tiptapToMarkdown(ref.current?.getJSON())).toBe("plain");
  });

  it("leaves ordinary prose to the native path", () => {
    const ref = createRef<Editor | null>();
    render(<RichTextEditor label="Description" value="" onChange={() => {}} editorRef={ref} />);
    const handled = runHandlePaste(ref, fakePasteEvent("Pinkish wallet, kinda worn out"));
    expect(handled).toBe(false);
    expect(tiptapToMarkdown(ref.current?.getJSON())).toBe("");
  });

  it("replaces only the selected range, preserving surrounding text", () => {
    const ref = createRef<Editor | null>();
    render(
      <RichTextEditor label="Description" value="before after" onChange={() => {}} editorRef={ref} />,
    );
    act(() => {
      ref.current?.commands.setContent(markdownToTiptap("before after"));
      ref.current?.commands.setTextSelection({ from: 8, to: 13 });
    });
    const handled = runHandlePaste(ref, fakePasteEvent("# New\n\n- item"));
    expect(handled).toBe(true);
    const stored = tiptapToMarkdown(ref.current?.getJSON());
    expect(stored).toContain("before");
    expect(stored).toContain("# New");
    expect(stored).not.toContain("after");
  });

  it("offers Paste as Markdown on the rail and inserts clipboard content", async () => {
    const readText = vi.fn().mockResolvedValue(CHATGPT_MD);
    Object.defineProperty(navigator, "clipboard", { value: { readText }, configurable: true });
    try {
      const ref = createRef<Editor | null>();
      const { container } = render(
        <RichTextEditor label="Description" value="" onChange={() => {}} editorRef={ref} />,
      );
      const item = screen.getByRole("button", { name: "Paste as Markdown" });
      fireEvent.click(item);
      await waitFor(() => {
        expect(tiptapToMarkdown(ref.current?.getJSON())).toContain("# Lost Wallet");
      });
      const editorEl = container.querySelector(".tiptap") as HTMLElement;
      expect(editorEl.querySelector("h1")).toBeTruthy();
      expect(readText).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    }
  });

  it("reports an unavailable clipboard instead of failing silently", async () => {
    const readText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", { value: { readText }, configurable: true });
    try {
      render(<RichTextEditor label="Description" value="" onChange={() => {}} />);
      fireEvent.click(screen.getByRole("button", { name: "Paste as Markdown" }));
      await waitFor(() => {
        expect(screen.getByRole("status", { name: "Formatting status" }).textContent).toMatch(
          /unavailable/i,
        );
      });
    } finally {
      Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    }
  });
});

describe("RichTextEditor fullscreen scroller contract", () => {
  it("owns one scrolling region with min-height content and a safe-area header", () => {
    const { container } = render(
      <RichTextEditor label="Description" value="hello" onChange={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Expand description editor" }));
    const overlay = document.body.querySelector("#report-editor-overlay") as HTMLElement;
    expect(overlay).toBeTruthy();
    const scroller = screen.getByTestId("report-editor-scroller");
    expect(scroller.className).toMatch(/overflow-y-auto/);
    expect(scroller.className).toMatch(/min-h-0/);
    expect(scroller.className).toMatch(/flex-1/);
    const prose = overlay.querySelector(".tiptap") as HTMLElement;
    expect(prose.classList.contains("min-h-full")).toBe(true);
    expect(prose.classList.contains("h-full")).toBe(false);
    const header = overlay.querySelector("header") as HTMLElement;
    expect(header.style.paddingTop).toContain("safe-area-inset-top");
    expect(container.querySelector(".tiptap")).toBeNull();
  });
});
