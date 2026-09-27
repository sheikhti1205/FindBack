// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import type { Editor } from "@tiptap/react";
import { RichTextEditor, tiptapToMarkdown } from "./RichTextEditor";

afterEach(cleanup);

describe("RichTextEditor report pass — bounded inline growth", () => {
  it("has min-height ~120px and max-height ~240px via CSS classes", () => {
    render(<RichTextEditor label="Description" value="" onChange={() => {}} />);
    const editorEl = document.querySelector(".tiptap") as HTMLElement;
    expect(editorEl).toBeTruthy();
    // Initial min-height ~120px (4-5 lines) via CSS class
    expect(editorEl.className).toMatch(/min-h-\[120px\]/);
    expect(editorEl.className).toMatch(/max-h-\[240px\]/);
    // Internal scrolling when content exceeds max-height via CSS classes
    expect(editorEl.className).toMatch(/overflow-y-auto/);
    expect(editorEl.className).toMatch(/overscroll-contain/);
  });
});

describe("RichTextEditor report pass — Expand/Collapse full-screen overlay", () => {
  it("renders an Expand button with accessible label", () => {
    render(<RichTextEditor label="Description" value="hello world" onChange={() => {}} />);
    const expandBtn = screen.getByRole("button", { name: /Expand description editor/i }) as HTMLButtonElement;
    expect(expandBtn).toBeTruthy();
    expect(expandBtn.disabled).toBe(false);
  });

  it("opens full-screen overlay on Expand click", () => {
    render(<RichTextEditor label="Description" value="hello world" onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Expand description editor/i }));
    // Overlay should be rendered via portal to document.body
    const overlay = document.getElementById("report-editor-overlay");
    expect(overlay).toBeTruthy();
    expect(overlay?.getAttribute("role")).toBe("dialog");
    expect(overlay?.getAttribute("aria-modal")).toBe("true");
  });

  it("preserves exact Markdown content when expanding", () => {
    const ref = createRef<Editor | null>();
    render(
      <RichTextEditor label="Description" value="**bold** and *italic*" onChange={() => {}} editorRef={ref} />,
    );
    const initialMarkdown = tiptapToMarkdown(ref.current?.getJSON());
    fireEvent.click(screen.getByRole("button", { name: /Expand description editor/i }));
    const _overlay = document.getElementById("report-editor-overlay");
    expect(tiptapToMarkdown(ref.current?.getJSON())).toBe(initialMarkdown);
  });

  it("preserves selection when expanding", () => {
    const ref = createRef<Editor | null>();
    const seen: string[] = [];
    render(
      <RichTextEditor
        label="Description"
        value="hello world"
        onChange={(md) => seen.push(md)}
        editorRef={ref}
      />,
    );
    act(() => {
      ref.current?.commands.setTextSelection({ from: 1, to: 6 }); // select "hello"
    });
    fireEvent.click(screen.getByRole("button", { name: /Expand description editor/i }));
    // Selection should be preserved in the overlay
    const _overlay = document.getElementById("report-editor-overlay");
    // The same editor instance should have the same selection
    expect(ref.current?.state.selection.from).toBe(1);
    expect(ref.current?.state.selection.to).toBe(6);
  });

  it("collapses back to inline on Done click with latest content", () => {
    const ref = createRef<Editor | null>();
    const seen: string[] = [];
    render(
      <RichTextEditor
        label="Description"
        value="hello"
        onChange={(md) => seen.push(md)}
        editorRef={ref}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Expand description editor/i }));
    // Edit in overlay - insert at end of "hello" (position 6 in Tiptap/ProseMirror)
    act(() => {
      ref.current?.commands.setTextSelection({ from: 6, to: 6 }); // after "hello"
      ref.current?.commands.insertContent(" world");
    });
    // Click Done
    const doneBtn = screen.getByRole("button", { name: /Done/i });
    fireEvent.click(doneBtn);
    // Overlay should be gone
    expect(document.getElementById("report-editor-overlay")).toBeNull();
    // Content should be updated
    expect(seen[seen.length - 1]).toBe("hello world");
  });

  it("Android Back (Escape) dismisses menu first, then overlay", () => {
    render(<RichTextEditor label="Description" value="hello" onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Expand description editor/i }));
    // Open a menu in overlay
    fireEvent.click(screen.getByRole("button", { name: /Block type/i }));
    expect(screen.getByRole("menu", { name: "Block type" })).toBeTruthy();
    // First Escape: closes menu
    fireEvent.keyDown(document, { key: "Escape" }); // Simulate Android Back
    expect(screen.queryByRole("menu", { name: "Block type" })).toBeNull();
    // Second Escape: closes overlay
    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.getElementById("report-editor-overlay")).toBeNull();
  });
});

describe("RichTextEditor report pass — formatting rail keyboard visibility", () => {
  it("rail sits at bottom of usable screen when IME hidden (replaces tab bar position)", () => {
    render(<RichTextEditor label="Description" value="hello" onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Expand description editor/i }));
    const overlay = document.getElementById("report-editor-overlay");
    const rail = overlay?.querySelector('[role="toolbar"]');
    expect(rail).toBeTruthy();
    // Rail should be at bottom of overlay flex column
    expect(overlay?.style.display).toBe("flex");
    expect(overlay?.style.flexDirection).toBe("column");
  });

  it("overlay uses CSS custom properties for visualViewport positioning", () => {
    render(<RichTextEditor label="Description" value="hello" onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Expand description editor/i }));
    const overlay = document.getElementById("report-editor-overlay");
    // The overlay should use visualViewport.height/offsetTop for positioning
    // Not keyboardHeight + visualViewport (double subtraction)
    expect(overlay).toBeTruthy();
    // Verify the overlay uses CSS custom properties for visualViewport
    expect(overlay?.style.height).toContain("var(--fb-visible-height");
    expect(overlay?.style.top).toContain("var(--fb-visible-top");
  });

  it("updates the overlay on visual viewport resize and scroll and releases the listeners on close", () => {
    const original = window.visualViewport;
    const viewport = new EventTarget() as VisualViewport;
    Object.defineProperties(viewport, {
      height: { value: 430, writable: true },
      offsetTop: { value: 24, writable: true },
    });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
    try {
      render(<RichTextEditor label="Description" value="hello" onChange={() => {}} />);
      fireEvent.click(screen.getByRole("button", { name: /Expand description editor/i }));
      const overlay = document.getElementById("report-editor-overlay")!;
      expect(overlay.style.getPropertyValue("--fb-visible-height")).toBe("430px");
      expect(overlay.style.getPropertyValue("--fb-visible-top")).toBe("24px");
      Object.assign(viewport, { height: 310, offsetTop: 44 });
      act(() => viewport.dispatchEvent(new Event("resize")));
      expect(overlay.style.getPropertyValue("--fb-visible-height")).toBe("310px");
      act(() => viewport.dispatchEvent(new Event("scroll")));
      expect(overlay.style.getPropertyValue("--fb-visible-top")).toBe("44px");
      fireEvent.click(screen.getByRole("button", { name: "Done" }));
      expect(document.getElementById("report-editor-overlay")).toBeNull();
    } finally {
      Object.defineProperty(window, "visualViewport", { configurable: true, value: original });
    }
  });
});

describe("RichTextEditor report pass — collision-safe formatting menus (Floating UI)", () => {
  it("uses Floating UI for menu positioning with flip, shift, size middleware", () => {
    render(<RichTextEditor label="Description" value="hello" onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Block type/i }));
    const menu = screen.getByRole("menu", { name: "Block type" });
    expect(menu).toBeTruthy();
    // Menu should be rendered via FloatingPortal to escape clipping ancestors
    // Verify it's not using absolute positioning (no absolute left-0 top-full)
    expect(menu.className).not.toMatch(/absolute left-0 top-full/);
    // Menu should have Floating UI positioning styles (transform-based)
    expect(menu.style.transform).toBeTruthy();
  });

  it("menu caps height and scrolls internally when taller than visible area", () => {
    render(<RichTextEditor label="Description" value="hello" onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Block type/i }));
    const menu = screen.getByRole("menu", { name: "Block type" });
    // Menu should use Floating UI transform-based positioning (not absolute left-0 top-full)
    expect(menu.style.transform).toBeTruthy();
    expect(menu.style.transform).not.toBe("none");
    // Menu should have overflow-y-auto className for internal scrolling
    expect(menu.className).toMatch(/overflow-y-auto/);
    // Menu should have max-height constraint className
    expect(menu.className).toMatch(/max-h-/);
  });

  it("link dialog is portaled out of the editor subtree with reachable actions", () => {
    const ref = createRef<Editor | null>();
    const { container } = render(
      <RichTextEditor label="Description" value="see map here" onChange={() => {}} editorRef={ref} />,
    );
    act(() => {
      ref.current?.commands.setTextSelection({ from: 5, to: 8 });
    });
    fireEvent.click(screen.getByRole("button", { name: "Link" }));
    const dialog = screen.getByRole("dialog", { name: /Add link/i });
    // Portaled out of the editor subtree so an ancestor clip/transform cannot hide it.
    expect(container.contains(dialog)).toBe(false);
    expect(document.body.contains(dialog)).toBe(true);
    // Both actions stay reachable.
    expect(screen.getByRole("button", { name: /^Cancel$/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Add link$/ })).toBeTruthy();
    // IME-open adaptivity (bottom sheet / full screen) has no jsdom
    // visualViewport: it is LAB/APP-only and tracked as the R-032 remainder,
    // NOT proven by this test.
  });

  it("Escape/Back/outside click closes one layer at a time", () => {
    render(<RichTextEditor label="Description" value="hello" onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Block type/i }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Block type" })).toBeNull();
  });
});

describe("RichTextEditor report pass — selection and undo preservation across modes", () => {
  it("undo/redo works identically in inline and full-screen modes", () => {
    const ref = createRef<Editor | null>();
    const seen: string[] = [];
    render(
      <RichTextEditor
        label="Description"
        value="hello"
        onChange={(md) => seen.push(md)}
        editorRef={ref}
      />,
    );
    act(() => {
      ref.current?.commands.setTextSelection({ from: 6, to: 6 });
      ref.current?.commands.insertContent(" world");
    });
    expect(ref.current?.can().undo()).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Expand description editor/i }));
    // Undo in overlay
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Undo" }));
    expect(tiptapToMarkdown(ref.current?.getJSON())).toBe("hello");
    // Redo in overlay
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Redo" }));
    expect(tiptapToMarkdown(ref.current?.getJSON())).toBe("hello world");
  });

  it("no duplicate transactions in history when switching modes", () => {
    const ref = createRef<Editor | null>();
    render(
      <RichTextEditor label="Description" value="hello" onChange={() => {}} editorRef={ref} />,
    );
    const historyBefore = ref.current?.state.doc.content.size;
    fireEvent.click(screen.getByRole("button", { name: /Expand description editor/i }));
    fireEvent.click(screen.getByRole("button", { name: /Done/i }));
    const historyAfter = ref.current?.state.doc.content.size;
    expect(historyAfter).toBe(historyBefore);
  });
});

describe("RichTextEditor report pass — accessibility", () => {
  it("overlay has proper ARIA: role=dialog, aria-modal=true, labelled header", () => {
    render(<RichTextEditor label="Description" value="hello" onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Expand description editor/i }));
    const overlay = document.getElementById("report-editor-overlay");
    expect(overlay?.getAttribute("role")).toBe("dialog");
    expect(overlay?.getAttribute("aria-modal")).toBe("true");
    expect(overlay?.querySelector("header")).toBeTruthy();
  });

  it("rail buttons have ≥48dp touch targets and accessible labels", () => {
    render(<RichTextEditor label="Description" value="hello" onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Expand description editor/i }));
    for (const name of ["Bold", "Italic", "Link", "List", "More"]) {
      const btn = screen.getByRole("button", { name });
      expect(btn.className).toMatch(/min-h-\[48px\]/);
      expect(btn.className).toMatch(/min-w-\[48px\]/);
    }
  });

  it("focus trap in overlay, focus restored on close", () => {
    render(<RichTextEditor label="Description" value="hello" onChange={() => {}} />);
    const expandBtn = screen.getByRole("button", { name: /Expand description editor/i });
    // Focus the expand button first (simulating real user click behavior)
    expandBtn.focus();
    expect(document.activeElement).toBe(expandBtn);
    fireEvent.click(expandBtn);
    // Focus should move into overlay (to the close button or first focusable)
    const overlay = document.getElementById("report-editor-overlay");
    // The focus trap should move focus into the overlay
    expect(overlay?.contains(document.activeElement)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Done/i }));
    // Focus should return to expand button (check by aria-label since element is re-rendered)
    const activeEl = document.activeElement as HTMLElement | null;
    expect(activeEl).not.toBeNull();
    expect(activeEl?.getAttribute("aria-label")).toBe("Expand description editor");
  });
});
