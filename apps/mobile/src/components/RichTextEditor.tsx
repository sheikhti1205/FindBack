import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import type { JSONContent } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import type { Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { createPortal } from "react-dom";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { useModalBack } from "../hooks/useModalBack";
import { Bold, Italic, Link2, List, ListOrdered, Quote, Redo2, RemoveFormatting, Undo2, Expand, X } from "lucide-react";
import {
  fromMarkdown,
  isSafeRichTextHref,
  measureDescription,
  toMarkdown,
  type InlineNode,
  type RichTextDocument,
} from "../services/richText";
import {
  useFloating,
  autoUpdate,
  offset,
  flip,
  shift,
  size,
  FloatingPortal,
} from "@floating-ui/react";

export const RICH_TEXT_DEBOUNCE_MS = 300;

interface LinkSelection {
  from: number;
  to: number;
  text: string;
  doc: Editor["state"]["doc"];
  href: string;
}

function LinkSheet({ selection, onCancel, onSave, onRemove }: {
  selection: LinkSelection;
  onCancel: () => void;
  onSave: (url: string) => string | null;
  onRemove: () => void;
}) {
  const id = useId();
  const sheetRef = useRef<HTMLDivElement>(null);
  const editing = selection.href !== "";
  const [url, setUrl] = useState(selection.href || "https://");
  const [message, setMessage] = useState<string | null>(null);
  const [isImeOpen, setIsImeOpen] = useState(false);

  useFocusTrap(sheetRef, onCancel);
  useModalBack(true, onCancel);

  // Detect IME/keyboard open state using visualViewport
  useEffect(() => {
    const handleResize = () => {
      const viewport = window.visualViewport;
      if (viewport) {
        const heightRatio = viewport.height / window.innerHeight;
        setIsImeOpen(heightRatio < 0.75);
      }
    };
    window.visualViewport?.addEventListener("resize", handleResize);
    window.visualViewport?.addEventListener("scroll", handleResize);
    handleResize();
    return () => {
      window.visualViewport?.removeEventListener("resize", handleResize);
      window.visualViewport?.removeEventListener("scroll", handleResize);
    };
  }, []);

  const { refs, floatingStyles } = useFloating({
    open: true,
    onOpenChange: onCancel,
    placement: isImeOpen ? "bottom" : "top",
    middleware: [
      offset(8),
      flip({
        crossAxis: "alignment",
        fallbackAxisSideDirection: isImeOpen ? "none" : "start",
        padding: 8,
      }),
      shift({ padding: 8, crossAxis: true }),
      size({
        apply({ availableHeight, elements }: { availableHeight: number; elements: { floating: HTMLElement } }) {
          const maxHeight = Math.max(0, availableHeight - 16);
          elements.floating.style.maxHeight = `${maxHeight}px`;
          elements.floating.style.overflowY = "auto";
        },
      }),
    ],
    whileElementsMounted: autoUpdate,
  });

  return (
    <FloatingPortal>
      <div
        ref={(el) => {
          refs.setFloating(el);
          sheetRef.current = el;
        }}
        style={floatingStyles}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        className="z-50 w-full max-w-md rounded-m3-lg bg-surface shadow-xl"
        tabIndex={-1}
      >
        <div className="space-y-4 p-5">
          <h2 id={`${id}-title`} className="text-lg font-semibold">{editing ? "Edit link" : "Add link"}</h2>
          <label className="block text-sm" htmlFor={`${id}-text`}>Selected text</label>
          <input id={`${id}-text`} value={selection.text} readOnly className="w-full rounded-m3-xs border border-outline-variant bg-surface-container p-3" />
          <form onSubmit={(event) => {
            event.preventDefault();
            const error = onSave(url.trim());
            if (error) setMessage(error);
          }}>
            <label htmlFor={`${id}-url`} className="block text-sm">URL</label>
            <input id={`${id}-url`} type="url" value={url} onChange={(event) => setUrl(event.target.value)} aria-invalid={message != null} aria-describedby={message ? `${id}-error` : undefined} className="w-full rounded-m3-xs border border-outline-variant p-3" />
            {message && <p id={`${id}-error`} role="alert" className="text-sm text-error">{message}</p>}
            <div className="mt-4 flex justify-end gap-2">
              {editing && isSafeRichTextHref(selection.href) && (
                <a
                  href={selection.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Open link ${selection.href} in a new tab`}
                  className="mr-auto inline-flex min-h-[48px] min-w-[48px] items-center px-3 underline"
                >
                  Open link
                </a>
              )}
              <button type="button" onClick={onCancel} className="min-h-[48px] min-w-[48px] px-3">Cancel</button>
              {editing && (
                <button type="button" onClick={onRemove} aria-label="Remove link" className="min-h-[48px] min-w-[48px] rounded-m3-xs border border-outline-variant px-3">Remove link</button>
              )}
              <button type="submit" className="min-h-[48px] min-w-[48px] rounded-m3-xs bg-on-surface px-3 text-surface">{editing ? "Save link" : "Add link"}</button>
            </div>
          </form>
        </div>
      </div>
    </FloatingPortal>
  );
}

interface FloatingMenuProps {
  open: boolean;
  onClose: () => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
  children: React.ReactNode;
  label: string;
  placement?: "top" | "bottom";
}

function FloatingMenu({ open, onClose, triggerRef, children, label, placement = "top" }: FloatingMenuProps) {
  const floatingRef = useRef<HTMLDivElement>(null);
  const { refs, floatingStyles } = useFloating({
    open,
    onOpenChange: onClose,
    placement,
    middleware: [
      offset(4),
      flip({
        crossAxis: "alignment",
        fallbackAxisSideDirection: "start",
        padding: 8,
      }),
      shift({ padding: 8, crossAxis: true }),
      size({
        apply({ availableHeight, elements }: { availableHeight: number; elements: { floating: HTMLElement } }) {
          const maxHeight = Math.max(0, availableHeight - 16);
          elements.floating.style.maxHeight = `${maxHeight}px`;
          elements.floating.style.overflowY = "auto";
        },
      }),
    ],
    whileElementsMounted: autoUpdate,
  });

  // Auto-focus the selected/first menu item when menu opens - using ref callback for synchronous focus
  const setFloatingRef = (el: HTMLDivElement | null) => {
    refs.setFloating(el);
    floatingRef.current = el;
    if (el && open) {
      // Focus synchronously when element is mounted
      const checkedItem = el.querySelector('[role="menuitemradio"][aria-checked="true"]') as HTMLElement;
      const firstItem = el.querySelector('[role="menuitem"], [role="menuitemradio"]') as HTMLElement;
      const target = checkedItem || firstItem;
      if (target) {
        target.focus();
      }
    }
  };

  // Handle keyboard navigation within the menu
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const menu = event.currentTarget;
    const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"], [role="menuitemradio"]'));
    const enabledItems = items.filter(item => !item.disabled);
    const activeIndex = enabledItems.findIndex(item => item === document.activeElement);

    if (activeIndex === -1) return;

    let nextIndex = activeIndex;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        nextIndex = (activeIndex + 1) % enabledItems.length;
        break;
      case "ArrowUp":
        event.preventDefault();
        nextIndex = (activeIndex - 1 + enabledItems.length) % enabledItems.length;
        break;
      case "Home":
        event.preventDefault();
        nextIndex = 0;
        break;
      case "End":
        event.preventDefault();
        nextIndex = enabledItems.length - 1;
        break;
      case "Escape":
        event.preventDefault();
        onClose();
        triggerRef.current?.focus();
        return;
      default:
        return;
    }

    enabledItems[nextIndex]?.focus();
  };

  if (!open) return null;

  return (
    <FloatingPortal>
      <div
        ref={setFloatingRef}
        style={floatingStyles}
        role="menu"
        aria-label={label}
        className="z-50 max-w-[calc(100vw-2rem)] w-64 max-h-[min(20rem,40vh)] overflow-y-auto rounded-m3-sm border border-outline-variant bg-surface p-1 shadow-xl"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        {children}
      </div>
    </FloatingPortal>
  );
}

interface RichTextEditorProps {
  label: string;
  value: string;
  onChange: (markdown: string) => void;
  placeholder?: string;
  editorRef?: RefObject<Editor | null>;
  error?: string;
  required?: boolean;
  maxLength?: number;
  inputId?: string;
}

interface PMTextMark {
  type: string;
  attrs?: { href?: string };
}

interface PMNode {
  type: string;
  attrs?: { level?: number; href?: string; start?: number };
  text?: string;
  marks?: PMTextMark[];
  content?: PMNode[];
}

function markForRun(run: InlineNode): PMTextMark[] | undefined {
  switch (run.type) {
    case "Bold":
      return [{ type: "bold" }];
    case "Italic":
      return [{ type: "italic" }];
    case "BoldItalic":
      return [{ type: "bold" }, { type: "italic" }];
    case "Link":
      return isSafeRichTextHref(run.href) ? [{ type: "link", attrs: { href: run.href } }] : undefined;
    case "BoldLink":
      return isSafeRichTextHref(run.href)
        ? [
            { type: "bold" },
            { type: "link", attrs: { href: run.href } },
          ]
        : [{ type: "bold" }];
    case "ItalicLink":
      return isSafeRichTextHref(run.href)
        ? [
            { type: "italic" },
            { type: "link", attrs: { href: run.href } },
          ]
        : [{ type: "italic" }];
    case "BoldItalicLink":
      return isSafeRichTextHref(run.href)
        ? [{ type: "bold" }, { type: "italic" }, { type: "link", attrs: { href: run.href } }]
        : [{ type: "bold" }, { type: "italic" }];
    case "InlineText":
      return undefined;
  }
}

function runsToPM(runs: InlineNode[]): PMNode[] {
  const out: PMNode[] = [];
  for (const run of runs) {
    const segments = run.text.split("\n");
    segments.forEach((segment, index) => {
      if (index > 0) out.push({ type: "hardBreak" });
      if (segment !== "") {
        const node: PMNode = { type: "text", text: segment };
        const marks = markForRun(run);
        if (marks) node.marks = marks;
        out.push(node);
      }
    });
  }
  return out;
}

/** Markdown (interchange) -> Tiptap doc JSON. Never throws. */
export function markdownToTiptap(md: string): JSONContent {
  try {
    const doc = fromMarkdown(md);
    const content: PMNode[] = [];
    for (const block of doc.blocks) {
      switch (block.type) {
        case "Paragraph": {
          const inline = runsToPM(block.runs);
          content.push({ type: "paragraph", ...(inline.length > 0 ? { content: inline } : {}) });
          break;
        }
        case "Heading":
          content.push({ type: "heading", attrs: { level: block.level }, content: runsToPM(block.runs) });
          break;
        case "BulletList":
          content.push({
            type: "bulletList",
            content: block.items.map((item) => ({ type: "listItem", content: [{ type: "paragraph", content: runsToPM(item) }] })),
          });
          break;
        case "OrderedList":
          content.push({
            type: "orderedList",
            attrs: { start: block.start },
            content: block.items.map((item) => ({ type: "listItem", content: [{ type: "paragraph", content: runsToPM(item) }] })),
          });
          break;
        case "Quote": {
          const lines: Array<Array<{ text: string; marks: PMTextMark[] | undefined }>> = [[]];
          for (const run of block.runs) {
            const segments = run.text.split("\n");
            segments.forEach((segment, index) => {
              if (index > 0) lines.push([]);
              if (segment !== "") lines[lines.length - 1]?.push({ text: segment, marks: markForRun({ ...run, text: segment }) });
            });
          }
          const paras: PMNode[] = lines.map((parts) => {
            const node: PMNode = { type: "paragraph" };
            const children: PMNode[] = [];
            for (const part of parts) {
              const child: PMNode = { type: "text", text: part.text };
              if (part.marks) child.marks = part.marks;
              children.push(child);
            }
            if (children.length > 0) node.content = children;
            return node;
          });
          content.push({ type: "blockquote", content: paras.length > 0 ? paras : [{ type: "paragraph" }] });
          break;
        }
      }
    }
    return { type: "doc", content: content.length > 0 ? content : [{ type: "paragraph" }] };
  } catch {
    return { type: "doc", content: [{ type: "paragraph" }] };
  }
}

function nodeText(node: PMNode): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  return (node.content ?? []).map(nodeText).join("");
}

function inlineToRuns(content: PMNode[] | undefined): InlineNode[] {
  const runs: InlineNode[] = [];
  for (const node of content ?? []) {
    if (node.type === "hardBreak") {
      runs.push({ type: "InlineText", text: "\n" });
      continue;
    }
    if (node.type !== "text" || typeof node.text !== "string" || node.text === "") continue;
    const marks = node.marks ?? [];
    const link = marks.find((m) => m.type === "link");
    const linkHref = link?.attrs?.href;
    if (typeof linkHref === "string" && isSafeRichTextHref(linkHref)) {
      const href = linkHref.trim();
      if (marks.some((m) => m.type === "bold") && marks.some((m) => m.type === "italic")) runs.push({ type: "BoldItalicLink", href, text: node.text });
      else if (marks.some((m) => m.type === "bold")) runs.push({ type: "BoldLink", href, text: node.text });
      else if (marks.some((m) => m.type === "italic")) runs.push({ type: "ItalicLink", href, text: node.text });
      else runs.push({ type: "Link", href, text: node.text });
      continue;
    }
    if (marks.some((m) => m.type === "bold") && marks.some((m) => m.type === "italic")) runs.push({ type: "BoldItalic", text: node.text });
    else if (marks.some((m) => m.type === "bold")) runs.push({ type: "Bold", text: node.text });
    else if (marks.some((m) => m.type === "italic")) runs.push({ type: "Italic", text: node.text });
    else runs.push({ type: "InlineText", text: node.text });
  }
  const merged: InlineNode[] = [];
  for (const run of runs) {
    const prev = merged[merged.length - 1];
    if (prev?.type === "InlineText" && run.type === "InlineText") prev.text += run.text;
    else if (prev?.type === "Bold" && run.type === "Bold") prev.text += run.text;
    else if (prev?.type === "Italic" && run.type === "Italic") prev.text += run.text;
    else if (prev?.type === "BoldItalic" && run.type === "BoldItalic") prev.text += run.text;
    else if (prev?.type === "Link" && run.type === "Link" && prev.href === run.href) prev.text += run.text;
    else if (prev?.type === "BoldLink" && run.type === "BoldLink" && prev.href === run.href) prev.text += run.text;
    else if (prev?.type === "ItalicLink" && run.type === "ItalicLink" && prev.href === run.href) prev.text += run.text;
    else if (prev?.type === "BoldItalicLink" && run.type === "BoldItalicLink" && prev.href === run.href) prev.text += run.text;
    else merged.push({ ...run });
  }
  return merged.length > 0 ? merged : [{ type: "InlineText", text: "" }];
}

/**
 * Flatten one Tiptap list node to v1 codec items without losing text (ED-09).
 * Each listItem's direct paragraphs join with a single space; nested lists
 * recurse into sibling blocks appended after the parent list. Blank items
 * (no text, no nested content) are skipped. Never throws.
 */
function listNodeToItems(node: PMNode): { items: InlineNode[][]; nested: RichTextDocument["blocks"] } {
  const items: InlineNode[][] = [];
  const nested: RichTextDocument["blocks"] = [];
  try {
    for (const item of node.content ?? []) {
      if (typeof item !== "object" || item === null || item.type !== "listItem") continue;
      const paraChunks: PMNode[][] = [];
      for (const child of item.content ?? []) {
        if (typeof child !== "object" || child === null || typeof child.type !== "string") continue;
        if (child.type === "paragraph") {
          paraChunks.push(child.content ?? []);
        } else if (child.type === "bulletList" || child.type === "orderedList") {
          const inner = listNodeToItems(child);
          if (inner.items.length > 0) {
            nested.push(
              child.type === "bulletList"
                ? { type: "BulletList", items: inner.items }
                : { type: "OrderedList", start: child.attrs?.start ?? 1, items: inner.items },
            );
          }
          nested.push(...inner.nested);
        } else if (nodeText(child) !== "") {
          paraChunks.push([{ type: "text", text: nodeText(child) }]);
        }
      }
      const combined: PMNode[] = [];
      paraChunks.forEach((chunk, index) => {
        if (index > 0) combined.push({ type: "text", text: " " });
        combined.push(...chunk);
      });
      const runs = inlineToRuns(combined);
      if (runs.some((run) => run.text !== "")) items.push(runs);
    }
  } catch {
    // Fall through with whatever was collected; caller still emits text.
  }
  return { items, nested };
}

/**
 * Reports whether the given Tiptap doc JSON simplifies list structure when
 * saved through the flat v1 codec (ED-09): any list item with more than one
 * non-empty paragraph, any nested list, or any other text-bearing non-
 * paragraph child. Pure and never throws; used for the user-visible notice.
 */
export function tiptapListsWereSimplified(json: unknown): boolean {
  try {
    if (typeof json !== "object" || json === null || !Array.isArray((json as { content?: unknown }).content)) return false;
    const nodes = (json as { content: PMNode[] }).content;
    for (const node of nodes) {
      if (typeof node !== "object" || node === null) continue;
      if (node.type !== "bulletList" && node.type !== "orderedList") continue;
      for (const item of node.content ?? []) {
        if (typeof item !== "object" || item === null || item.type !== "listItem") continue;
        let textParagraphs = 0;
        for (const child of item.content ?? []) {
          if (typeof child !== "object" || child === null || typeof child.type !== "string") continue;
          if (child.type === "paragraph") {
            if (nodeText(child) !== "") textParagraphs += 1;
          } else if (child.type === "bulletList" || child.type === "orderedList") {
            return true;
          } else if (nodeText(child) !== "") {
            return true;
          }
        }
        if (textParagraphs > 1) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/** Tiptap doc JSON -> Markdown via the richText codec. Never throws. */
export function tiptapToMarkdown(json: unknown): string {
  try {
    if (typeof json !== "object" || json === null || !Array.isArray((json as { content?: unknown }).content)) return "";
    const nodes = (json as { content: PMNode[] }).content;
    const blocks: RichTextDocument["blocks"] = [];
    for (const node of nodes) {
      if (typeof node !== "object" || node === null || typeof node.type !== "string") continue;
      switch (node.type) {
        case "paragraph":
          blocks.push({ type: "Paragraph", runs: inlineToRuns(node.content) });
          break;
        case "heading":
          if (node.attrs?.level === 1 || node.attrs?.level === 2 || node.attrs?.level === 3) {
            blocks.push({ type: "Heading", level: node.attrs.level, runs: inlineToRuns(node.content) });
          } else {
            blocks.push({ type: "Paragraph", runs: inlineToRuns(node.content) });
          }
          break;
        case "bulletList": {
          // ED-09: the v1 codec is flat (one inline-run array per item), so a
          // list item with several paragraphs is joined with a space (never
          // concatenated word-to-word) and nested lists become following
          // sibling blocks. Text is always preserved; nesting flattens.
          const { items, nested } = listNodeToItems(node);
          if (items.length > 0) blocks.push({ type: "BulletList", items });
          blocks.push(...nested);
          break;
        }
        case "orderedList": {
          const { items, nested } = listNodeToItems(node);
          if (items.length > 0) blocks.push({ type: "OrderedList", start: node.attrs?.start ?? 1, items });
          blocks.push(...nested);
          break;
        }
        case "blockquote": {
          const runs = inlineToRuns(
            (node.content ?? [])
              .filter((child) => child.type === "paragraph")
              .flatMap((child, index) => (index > 0 ? [{ type: "hardBreak" } as PMNode, ...(child.content ?? [])] : (child.content ?? []))),
          );
          blocks.push({ type: "Quote", runs });
          break;
        }
        default:
          if (nodeText(node) !== "") blocks.push({ type: "Paragraph", runs: [{ type: "InlineText", text: nodeText(node) }] });
          break;
      }
    }
    if (blocks.length === 0) return "";
    while (blocks.length > 0) {
      const last = blocks[blocks.length - 1];
      if (last?.type !== "Paragraph" || !last.runs.every((run) => run.text === "")) break;
      blocks.pop();
    }
    if (blocks.length === 0) return "";
    return toMarkdown({ v: 1, blocks });
  } catch {
    return "";
  }
}

/**
 * YAGNI rich-text editor: Paragraph/Heading/BulletList/Quote blocks plus
 * Bold/Italic/Link marks. Markdown is the interchange format. Edits report to
 * the parent immediately so no keystroke is lost on submit or unmount, while
 * external value changes (draft restore, reset) replace the editor content.
 *
 * Toolbar (ED-02/ED-06): `Body ▾ | B | I | List ▾ | Link | More ⋯`.
 * Only controls with real choices (block type, list, link) open popups.
 *
 * Selection safety (ED-04): a toolbar `pointerdown` captures the pending range
 * before Android/WebView focus loss collapses the DOM selection; the stashed
 * range additionally guards with a doc-identity + text check, is cleared on
 * intentional editor pointer/keyboard navigation, external content
 * replacement, and after every operation. A collapsed caret with no pending
 * range only toggles the stored mark for future typing — never stale text.
 */
export function RichTextEditor({ label, value, onChange, placeholder, editorRef, error, required, maxLength, inputId }: RichTextEditorProps) {
  const [empty, setEmpty] = useState(true);
  const [counts, setCounts] = useState({ stored: 0, visible: 0 });
  const [, refreshSelection] = useState(0);
  const [linkSelection, setLinkSelection] = useState<LinkSelection | null>(null);
  const [openMenu, setOpenMenu] = useState<null | "block" | "list" | "more">(null);
  const [status, setStatus] = useState<string | null>(null);
  const [listNotice, setListNotice] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);
  const overlayPreviouslyFocusedRef = useRef<HTMLElement | null>(null);
  const expandButtonRef = useRef<HTMLButtonElement>(null);
  const setOverlayRef = useFocusTrap(overlayRef, () => setIsExpanded(false), isExpanded, overlayPreviouslyFocusedRef);
  useModalBack(isExpanded, () => setIsExpanded(false));

  // Restore focus to expand button when overlay closes
  useEffect(() => {
    if (!isExpanded && overlayPreviouslyFocusedRef.current) {
      const previous = overlayPreviouslyFocusedRef.current;
      overlayPreviouslyFocusedRef.current = null;
      if (document.contains(previous)) {
        previous.focus();
      } else if (expandButtonRef.current) {
        // Fallback: focus the expand button if the previous element is no longer in the document
        expandButtonRef.current.focus();
      }
    }
  }, [isExpanded]);
  const baseId = useId();
  const errorId = `${baseId}-error`;
  const countId = `${baseId}-count`;
  const statusId = `${baseId}-status`;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const valueRef = useRef(value);
  valueRef.current = value;
  interface RangedSelection { from: number; to: number; doc: Editor["state"]["doc"]; text: string; }
  // Last non-collapsed selection + the pending toolbar-capture range.
  // Native Android selection/clipboard behavior is untouched; these only
  // remember ProseMirror offsets to re-apply formatting to the right range.
  const savedRangeRef = useRef<RangedSelection | null>(null);
  const pendingToolbarRangeRef = useRef<RangedSelection | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const blockButtonRef = useRef<HTMLButtonElement>(null);
  const listButtonRef = useRef<HTMLButtonElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const lastMenuButtonRef = useRef<HTMLButtonElement | null>(null);

  const initialContent = useMemo(() => markdownToTiptap(value), []);

  function snapshotRange(from: number, to: number, doc: Editor["state"]["doc"]): RangedSelection | null {
    try {
      return { from, to, doc, text: doc.textBetween(from, to) };
    } catch {
      return null;
    }
  }

  function refreshCounts(ed: Editor) {
    try {
      const measured = measureDescription(tiptapToMarkdown(ed.getJSON()));
      setCounts({ stored: measured.storedLength, visible: measured.visibleLength });
    } catch {
      const text = ed.getText().length;
      setCounts({ stored: text, visible: text });
    }
    try {
      setListNotice(tiptapListsWereSimplified(ed.getJSON()));
    } catch {
      setListNotice(false);
    }
  }

  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({
          code: false,
          codeBlock: false,
          horizontalRule: false,
          strike: false,
          underline: false,
          heading: { levels: [1, 2, 3] },
          link: { openOnClick: false, autolink: true, isAllowedUri: (url) => isSafeRichTextHref(url) },
        }),
      ],
      content: initialContent,
      immediatelyRender: false,
      editorProps: {
        attributes: {
          "aria-label": label,
          class: `tiptap min-h-[120px] rounded-m3-sm border bg-surface px-3.5 py-3 text-base focus:border-on-surface focus:outline-none overflow-y-auto overscroll-contain ${error ? "border-error" : "border-outline-variant"}`,
        },
      },
      onCreate: ({ editor: created }) => {
        setEmpty(created.isEmpty);
        refreshCounts(created);
        if (editorRef) editorRef.current = created;
      },
      onUpdate: ({ editor: updated }) => {
        setEmpty(updated.isEmpty);
        refreshCounts(updated);
        const markdown = tiptapToMarkdown(updated.getJSON());
        if (markdown !== valueRef.current) onChangeRef.current(markdown);
      },
      onSelectionUpdate: ({ editor: updated }) => {
        const { from, to, empty: isEmpty } = updated.state.selection;
        if (!isEmpty) {
          const snapshot = snapshotRange(from, to, updated.state.doc);
          if (snapshot) savedRangeRef.current = snapshot;
        }
        refreshSelection((revision) => revision + 1);
      },
    },
    [],
  );

  useEffect(() => {
    if (!editor) return;
    if (editorRef) editorRef.current = editor;
    if (tiptapToMarkdown(editor.getJSON()) !== value) {
      editor.commands.setContent(markdownToTiptap(value));
      savedRangeRef.current = null;
      pendingToolbarRangeRef.current = null;
    }
    setEmpty(editor.isEmpty);
    refreshCounts(editor);
  }, [editor, value]);

  useEffect(() => {
    const dom = editor?.view.dom as HTMLElement | undefined;
    if (!dom) return;
    dom.setAttribute("aria-describedby", error ? `${errorId} ${countId}` : countId);
    if (error) dom.setAttribute("aria-invalid", "true");
    else dom.removeAttribute("aria-invalid");
    if (required) dom.setAttribute("aria-required", "true");
    else dom.removeAttribute("aria-required");
    if (inputId) dom.setAttribute("id", inputId);
    else dom.removeAttribute("id");
  }, [editor, error, required, inputId, errorId, countId]);

  // Close menus on outside tap or Escape, restoring focus to the menu button.
  useEffect(() => {
    if (!openMenu) return;
    function onDocPointerDown(event: PointerEvent) {
      if (toolbarRef.current && !toolbarRef.current.contains(event.target as Node)) setOpenMenu(null);
    }
    function onDocKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpenMenu(null);
        lastMenuButtonRef.current?.focus();
      }
    }
    document.addEventListener("pointerdown", onDocPointerDown);
    document.addEventListener("keydown", onDocKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onDocPointerDown);
      document.removeEventListener("keydown", onDocKeyDown);
    };
  }, [openMenu]);

  // Move focus into the open menu (checked item first) so keyboard and
  // screen-reader users land on the current choice, not behind the button.
  useEffect(() => {
    if (!openMenu || !toolbarRef.current) return;
    const menu = toolbarRef.current.querySelector('[role="menu"]');
    const target =
      menu?.querySelector('button[aria-checked="true"]:not([disabled])') ??
      menu?.querySelector("button:not([disabled])");
    (target as HTMLElement | null)?.focus();
  }, [openMenu]);

  /** Roving ArrowUp/Down (wrapping, skipping disabled), Home/End, Tab-close. */
  function handleMenuKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const panel = event.currentTarget;
    const items = Array.from(panel.querySelectorAll("button:not([disabled])")) as HTMLButtonElement[];
    if (items.length === 0) return;
    const active = document.activeElement as HTMLElement | null;
    const index = active ? items.indexOf(active as HTMLButtonElement) : -1;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      items[(index + 1 + items.length) % items.length]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      items[(index - 1 + items.length) % items.length]?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      items[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      items[items.length - 1]?.focus();
    } else if (event.key === "Tab") {
      setOpenMenu(null);
    }
    // Escape is handled by the document listener (close + focus restore).
  }

  function rangeSnapshotValid(snapshot: RangedSelection | null): { from: number; to: number } | null {
    if (!editor || !snapshot) return null;
    // Doc-version guard: any intervening edit/replacement invalidates positions.
    if (editor.state.doc !== snapshot.doc) return null;
    const max = editor.state.doc.content.size;
    if (snapshot.from < 0 || snapshot.to > max || snapshot.from >= snapshot.to) return null;
    try {
      if (editor.state.doc.textBetween(snapshot.from, snapshot.to) !== snapshot.text) return null;
    } catch {
      return null;
    }
    return { from: snapshot.from, to: snapshot.to };
  }

  function validSavedRange(): { from: number; to: number } | null {
    const valid = rangeSnapshotValid(savedRangeRef.current);
    if (!valid) savedRangeRef.current = null;
    return valid;
  }

  /** Capture the pending toolbar range BEFORE focus loss collapses the DOM
   * selection (pointer/mouse/touch capture on the toolbar root). Never clears
   * an already-captured pending range on failure. */
  function captureToolbarRange() {
    if (!editor) return;
    const { from, to, empty: isEmpty } = editor.state.selection;
    if (!isEmpty) {
      const snapshot = snapshotRange(from, to, editor.state.doc);
      if (snapshot) {
        savedRangeRef.current = snapshot;
        pendingToolbarRangeRef.current = snapshot;
      }
      return;
    }
    const saved = rangeSnapshotValid(savedRangeRef.current);
    if (saved && savedRangeRef.current) {
      pendingToolbarRangeRef.current = { ...savedRangeRef.current };
    }
  }

  function takePendingRange(): { from: number; to: number } | null {
    const pending = rangeSnapshotValid(pendingToolbarRangeRef.current);
    pendingToolbarRangeRef.current = null;
    return pending;
  }

  function resolveFormatRange(): { from: number; to: number } | null {
    if (!editor) return null;
    const pending = takePendingRange();
    if (pending) return pending;
    const { from, to, empty: isEmpty } = editor.state.selection;
    if (!isEmpty) {
      const snapshot = snapshotRange(from, to, editor.state.doc);
      if (snapshot) savedRangeRef.current = snapshot;
      return { from, to };
    }
    return validSavedRange();
  }

  /** Intentional editor pointer/keyboard navigation invalidates the stash. */
  function handleEditorIntentionalInteraction() {
    savedRangeRef.current = null;
    pendingToolbarRangeRef.current = null;
  }

  function finishOperation(message: string) {
    savedRangeRef.current = null;
    pendingToolbarRangeRef.current = null;
    setStatus(message);
  }

  /** Restore a stashed/captured range so block commands hit the right block. */
  function focusRangeOrCurrent(range: { from: number; to: number } | null) {
    if (!editor) return;
    if (range && editor.state.selection.empty) {
      try {
        editor.chain().focus().setTextSelection(range).run();
        return;
      } catch {
        // Fall through to plain focus.
      }
    }
    editor.commands.focus();
  }

  function toggleMarkWithSavedSelection(mark: "bold" | "italic") {
    if (!editor) return;
    const range = resolveFormatRange();
    if (range && editor.state.selection.empty) {
      if (mark === "bold") editor.chain().focus().setTextSelection(range).toggleBold().run();
      else editor.chain().focus().setTextSelection(range).toggleItalic().run();
    } else if (mark === "bold") editor.chain().focus().toggleBold().run();
    else editor.chain().focus().toggleItalic().run();
    finishOperation(mark === "bold" ? "Bold applied" : "Italic applied");
  }

  function applyBlock(kind: "body" | 1 | 2 | 3) {
    if (!editor) return;
    const range = resolveFormatRange();
    focusRangeOrCurrent(range);
    // setHeading (not toggle): re-choosing the current level keeps it (ED-02).
    if (kind === "body") editor.chain().focus().setParagraph().run();
    else editor.chain().focus().setHeading({ level: kind }).run();
    setOpenMenu(null);
    finishOperation(kind === "body" ? "Body style applied" : `Heading ${kind} applied`);
  }

  function applyList(kind: "bullet" | "ordered" | "remove") {
    if (!editor) return;
    const range = resolveFormatRange();
    focusRangeOrCurrent(range);
    if (kind === "bullet") editor.chain().focus().toggleBulletList().run();
    else if (kind === "ordered") editor.chain().focus().toggleOrderedList().run();
    else if (editor.isActive("bulletList")) editor.chain().focus().toggleBulletList().run();
    else if (editor.isActive("orderedList")) editor.chain().focus().toggleOrderedList().run();
    setOpenMenu(null);
    finishOperation(kind === "remove" ? "List removed" : kind === "bullet" ? "Bullet list applied" : "Numbered list applied");
  }

  function applyQuote() {
    if (!editor) return;
    const range = resolveFormatRange();
    focusRangeOrCurrent(range);
    editor.chain().focus().toggleBlockquote().run();
    setOpenMenu(null);
    finishOperation("Quote applied");
  }

  function applyClearAll() {
    if (!editor) return;
    // Clear-all targets the selection when present, else the current block.
    editor.chain().focus().clearNodes().unsetAllMarks().run();
    setOpenMenu(null);
    finishOperation("All formatting cleared");
  }

  function applyUndo() {
    if (!editor) return;
    editor.chain().focus().undo().run();
    setOpenMenu(null);
    finishOperation("Undone");
  }

  function applyRedo() {
    if (!editor) return;
    editor.chain().focus().redo().run();
    setOpenMenu(null);
    finishOperation("Redone");
  }

  function applyLink() {
    if (!editor) return;
    const { empty: collapsed } = editor.state.selection;
    // Caret inside an existing link opens the edit dialog (ED-07) —
    // never an instant destructive unset.
    if (collapsed && editor.isActive("link")) {
      try {
        editor.chain().focus().extendMarkRange("link").run();
      } catch {
        return;
      }
      const { from, to, empty: stillCollapsed } = editor.state.selection;
      if (stillCollapsed) return;
      let text: string;
      try {
        text = editor.state.doc.textBetween(from, to);
      } catch {
        return;
      }
      setLinkSelection({
        from, to, text, doc: editor.state.doc,
        href: (editor.getAttributes("link")["href"] as string | undefined) ?? "",
      });
      return;
    }
    const range = resolveFormatRange();
    if (!range) {
      setStatus("Select text to add a link");
      return;
    }
    let text: string;
    try {
      text = editor.state.doc.textBetween(range.from, range.to);
    } catch {
      return;
    }
    setLinkSelection({
      from: range.from, to: range.to, text, doc: editor.state.doc,
      href: (editor.getAttributes("link")["href"] as string | undefined) ?? "",
    });
  }

  function saveLink(href: string): string | null {
    if (!editor || !linkSelection) return "Selection is no longer available.";
    if (!isSafeRichTextHref(href) || /\s/.test(href) || Array.from(href).some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)) return "Enter a safe HTTP(S) URL.";
    const { from, to, doc, text } = linkSelection;
    if (editor.state.doc !== doc) {
      return "The selected text changed. Cancel and select it again.";
    }
    try {
      if (editor.state.doc.textBetween(from, to) !== text) {
        return "The selected text changed. Cancel and select it again.";
      }
    } catch {
      return "The selected text changed. Cancel and select it again.";
    }
    editor.chain().focus().setTextSelection({ from, to }).setLink({ href }).run();
    setLinkSelection(null);
    finishOperation("Link saved");
    queueMicrotask(() => editor.commands.focus());
    return null;
  }

  function removeLink() {
    if (!editor || !linkSelection) return;
    const { from, to, doc, text } = linkSelection;
    if (editor.state.doc === doc) {
      try {
        if (editor.state.doc.textBetween(from, to) === text) {
          editor.chain().focus().setTextSelection({ from, to }).unsetLink().run();
        }
      } catch {
        // Keep display text untouched when the range is stale.
      }
    }
    setLinkSelection(null);
    finishOperation("Link removed");
    queueMicrotask(() => editor.commands.focus());
  }

  const canUndo = editor?.can().chain().focus().undo().run() ?? false;
  const canRedo = editor?.can().chain().focus().redo().run() ?? false;
  // Keep Link enabled when a stashed word-range survives toolbar focus loss;
  // otherwise a collapsed visible selection would disable the button and the
  // pre-dialog range could never be applied.
  const linkDisabled = editor
    ? editor.state.selection.empty && !editor.isActive("link") && !validSavedRange()
    : true;

  const currentBlock: "Body" | "Heading 1" | "Heading 2" | "Heading 3" =
    editor?.isActive("heading", { level: 1 }) ? "Heading 1"
    : editor?.isActive("heading", { level: 2 }) ? "Heading 2"
    : editor?.isActive("heading", { level: 3 }) ? "Heading 3"
    : "Body";
  const bulletActive = editor?.isActive("bulletList") ?? false;
  const orderedActive = editor?.isActive("orderedList") ?? false;
  const quoteActive = editor?.isActive("blockquote") ?? false;
  const boldActive = editor?.isActive("bold") ?? false;
  const italicActive = editor?.isActive("italic") ?? false;
  const linkActive = editor?.isActive("link") ?? false;

  const toolButtonCls = (active: boolean) =>
    `flex min-h-[48px] min-w-[48px] shrink-0 items-center justify-center gap-1 rounded-m3-xs px-2 text-on-surface-variant hover:bg-surface-container ${
      active ? "bg-surface-container-high text-on-surface outline outline-1 outline-outline" : ""
    }`;
  const menuItemCls =
    "flex min-h-[48px] w-full items-center gap-2 rounded-m3-xs px-3 text-left text-on-surface hover:bg-surface-container";

  function toggleMenu(kind: "block" | "list" | "more", button: RefObject<HTMLButtonElement | null>) {
    if (openMenu === kind) {
      setOpenMenu(null);
    } else {
      lastMenuButtonRef.current = button.current;
      setOpenMenu(kind);
    }
  }

  const blockOptions: Array<{ name: "Body" | "Heading 1" | "Heading 2" | "Heading 3"; kind: "body" | 1 | 2 | 3; preview: { fontSize: string; fontWeight: number } }> = [
    { name: "Body", kind: "body", preview: { fontSize: "1rem", fontWeight: 400 } },
    { name: "Heading 1", kind: 1, preview: { fontSize: "1.5rem", fontWeight: 700 } },
    { name: "Heading 2", kind: 2, preview: { fontSize: "1.25rem", fontWeight: 600 } },
    { name: "Heading 3", kind: 3, preview: { fontSize: "1.1rem", fontWeight: 600 } },
  ];

  const countText =
    maxLength !== undefined
      ? `${counts.stored} / ${maxLength} ${counts.stored === 1 ? "character" : "characters"}${counts.stored !== counts.visible ? ` (${counts.visible} visible)` : ""}`
      : `${counts.stored} ${counts.stored === 1 ? "character" : "characters"}${counts.stored !== counts.visible ? ` (${counts.visible} visible)` : ""}`;

  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium text-on-surface">{label}</span>
      <div
        className="relative"
        onPointerDown={handleEditorIntentionalInteraction}
        onTouchStart={handleEditorIntentionalInteraction}
        onKeyDown={handleEditorIntentionalInteraction}
      >
        {!isExpanded && <EditorContent editor={editor} />}
        {(!editor || empty) && placeholder && !isExpanded ? (
          <div aria-hidden className="pointer-events-none absolute inset-0 px-3.5 py-3 text-base text-on-surface-variant">
            {placeholder}
          </div>
        ) : null}
      </div>
      {!isExpanded && (
        <div ref={toolbarRef} className="relative">
          <div
            role="toolbar"
            aria-label={`${label} formatting`}
            className="flex flex-nowrap gap-1 overflow-x-auto pb-1"
            onPointerDownCapture={captureToolbarRange}
            onMouseDownCapture={captureToolbarRange}
            onTouchStartCapture={captureToolbarRange}
          >
          <button
            ref={blockButtonRef}
            type="button"
            title={`Block type: ${currentBlock}`}
            aria-label={`Block type: ${currentBlock}`}
            aria-haspopup="menu"
            aria-expanded={openMenu === "block"}
            disabled={!editor}
            onClick={() => toggleMenu("block", blockButtonRef)}
            className={toolButtonCls(currentBlock !== "Body")}
          >
            <span aria-hidden>{currentBlock} ▾</span>
          </button>
          <button
            type="button"
            title="Bold"
            aria-label="Bold"
            aria-pressed={boldActive}
            disabled={!editor}
            onClick={() => toggleMarkWithSavedSelection("bold")}
            className={toolButtonCls(boldActive)}
          >
            <Bold size={17} aria-hidden />
          </button>
          <button
            type="button"
            title="Italic"
            aria-label="Italic"
            aria-pressed={italicActive}
            disabled={!editor}
            onClick={() => toggleMarkWithSavedSelection("italic")}
            className={toolButtonCls(italicActive)}
          >
            <Italic size={17} aria-hidden />
          </button>
          <button
            ref={listButtonRef}
            type="button"
            title="List"
            aria-label="List"
            aria-haspopup="menu"
            aria-expanded={openMenu === "list"}
            disabled={!editor}
            onClick={() => toggleMenu("list", listButtonRef)}
            className={toolButtonCls(bulletActive || orderedActive)}
          >
            <List size={17} aria-hidden />
            <span aria-hidden className="text-xs">▾</span>
          </button>
          <button
            type="button"
            title={linkDisabled ? "Select text to add a link" : "Link"}
            aria-label="Link"
            aria-pressed={linkActive}
            disabled={!editor || linkDisabled}
            onClick={applyLink}
            className={toolButtonCls(linkActive)}
          >
            <Link2 size={17} aria-hidden />
          </button>
          <button
            ref={moreButtonRef}
            type="button"
            title="More"
            aria-label="More"
            aria-haspopup="menu"
            aria-expanded={openMenu === "more"}
            disabled={!editor}
            onClick={() => toggleMenu("more", moreButtonRef)}
            className={toolButtonCls(false)}
          >
            <span aria-hidden>⋯</span>
            <span className="sr-only">More formatting options</span>
          </button>
          <button
            ref={expandButtonRef}
            type="button"
            title="Expand description editor"
            aria-label="Expand description editor"
            disabled={!editor}
            onClick={() => {
              // Capture focus before expanding so we can restore it on close
              const activeEl = document.activeElement instanceof HTMLElement ? document.activeElement : null;
              overlayPreviouslyFocusedRef.current = activeEl;
              setIsExpanded(true);
            }}
            className={toolButtonCls(false)}
          >
            <Expand size={17} aria-hidden />
            <span className="sr-only">Expand description editor</span>
          </button>
        </div>
        <FloatingMenu
          open={openMenu === "block"}
          onClose={() => setOpenMenu(null)}
          triggerRef={blockButtonRef}
          label="Block type"
          placement="top"
        >
          <div onKeyDown={handleMenuKeyDown}>
            {blockOptions.map((option) => {
              const checked = currentBlock === option.name;
              return (
                <button
                  key={option.name}
                  type="button"
                  role="menuitemradio"
                  aria-checked={checked}
                  aria-label={option.name}
                  onClick={() => applyBlock(option.kind)}
                  className={menuItemCls}
                >
                  <span aria-hidden className="w-5 shrink-0">{checked ? "✓" : ""}</span>
                  <span style={option.preview}>{option.name}</span>
                </button>
              );
            })}
          </div>
        </FloatingMenu>
        <FloatingMenu
          open={openMenu === "list"}
          onClose={() => setOpenMenu(null)}
          triggerRef={listButtonRef}
          label="List"
          placement="top"
        >
          <div onKeyDown={handleMenuKeyDown}>
            <button
              type="button"
              role="menuitemradio"
              aria-checked={bulletActive}
              aria-label="Bullets"
              onClick={() => applyList("bullet")}
              className={menuItemCls}
            >
              <span aria-hidden className="w-5 shrink-0">{bulletActive ? "✓" : ""}</span>
              <List size={17} aria-hidden />
              <span>Bullets</span>
            </button>
            <button
              type="button"
              role="menuitemradio"
              aria-checked={orderedActive}
              aria-label="Numbers"
              onClick={() => applyList("ordered")}
              className={menuItemCls}
            >
              <span aria-hidden className="w-5 shrink-0">{orderedActive ? "✓" : ""}</span>
              <ListOrdered size={17} aria-hidden />
              <span>Numbers</span>
            </button>
            <button
              type="button"
              role="menuitem"
              aria-label="Remove list"
              onClick={() => applyList("remove")}
              className={menuItemCls}
            >
              <span aria-hidden className="w-5 shrink-0" />
              <span>Remove list</span>
            </button>
          </div>
        </FloatingMenu>
        <FloatingMenu
          open={openMenu === "more"}
          onClose={() => setOpenMenu(null)}
          triggerRef={moreButtonRef}
          label="More formatting options"
          placement="top"
        >
          <div onKeyDown={handleMenuKeyDown}>
            <button
              type="button"
              role="menuitem"
              aria-label="Quote"
              aria-pressed={quoteActive}
              onClick={applyQuote}
              className={menuItemCls}
            >
              <span aria-hidden className="w-5 shrink-0">{quoteActive ? "✓" : ""}</span>
              <Quote size={17} aria-hidden />
              <span>Quote</span>
            </button>
            <button
              type="button"
              role="menuitem"
              aria-label="Clear all formatting"
              title="Removes block styles (heading, list, quote) and inline styles (bold, italic, link)"
              onClick={applyClearAll}
              className={menuItemCls}
            >
              <span aria-hidden className="w-5 shrink-0" />
              <RemoveFormatting size={17} aria-hidden />
              <span>Clear all formatting</span>
            </button>
            <button
              type="button"
              role="menuitem"
              aria-label="Undo"
              disabled={!canUndo}
              onClick={applyUndo}
              className={menuItemCls}
            >
              <span aria-hidden className="w-5 shrink-0" />
              <Undo2 size={17} aria-hidden />
              <span>Undo</span>
            </button>
            <button
              type="button"
              role="menuitem"
              aria-label="Redo"
              disabled={!canRedo}
              onClick={applyRedo}
              className={menuItemCls}
            >
              <span aria-hidden className="w-5 shrink-0" />
              <Redo2 size={17} aria-hidden />
              <span>Redo</span>
            </button>
          </div>
        </FloatingMenu>
      </div>
      )}
      {linkSelection && <LinkSheet selection={linkSelection} onCancel={() => setLinkSelection(null)} onSave={saveLink} onRemove={removeLink} />}
      {listNotice ? (
        <p role="status" aria-label="List simplification notice" className="text-xs text-on-surface-variant">
          Nested or multi-part list items are saved as a simple flat list.
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-xs text-error" role="alert">
          {error}
        </p>
      ) : null}
      <span id={countId} role="status" aria-label="Character count" className="text-xs text-on-surface-variant">
        {countText}
      </span>
      {status ? (
        <span id={statusId} role="status" aria-label="Formatting status" className="text-xs text-on-surface-variant">
          {status}
        </span>
      ) : null}
      {isExpanded && createPortal(
        <div
          ref={setOverlayRef}
          id="report-editor-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="report-editor-overlay-title"
          className="fixed inset-0 z-50 flex flex-col bg-surface"
          style={{
            height: "var(--fb-visible-height, 100vh)",
            top: "var(--fb-visible-top, 0)",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <header className="flex items-center justify-between px-4 py-3 border-b border-outline-variant flex-shrink-0">
            <button
              type="button"
              aria-label="Close full-screen editor"
              onClick={() => setIsExpanded(false)}
              className="min-h-[48px] min-w-[48px] flex items-center justify-center"
            >
              <X size={20} aria-hidden />
            </button>
            <h2 id="report-editor-overlay-title" className="text-lg font-semibold">Description</h2>
            <button
              type="button"
              title="Done"
              aria-label="Done"
              onClick={() => setIsExpanded(false)}
              className="min-h-[48px] min-w-[48px] flex items-center justify-center rounded-m3-xs bg-on-surface px-3 text-surface"
            >
              Done
            </button>
          </header>
          <div className="flex-1 overflow-auto" onPointerDown={handleEditorIntentionalInteraction} onTouchStart={handleEditorIntentionalInteraction} onKeyDown={handleEditorIntentionalInteraction}>
            <EditorContent editor={editor} />
          </div>
          <div ref={toolbarRef} className="relative flex-shrink-0">
            <div
              role="toolbar"
              aria-label={`${label} formatting`}
              className="flex flex-nowrap gap-1 overflow-x-auto pb-1 px-4"
              onPointerDownCapture={captureToolbarRange}
              onMouseDownCapture={captureToolbarRange}
              onTouchStartCapture={captureToolbarRange}
            >
              <button
                ref={blockButtonRef}
                type="button"
                title={`Block type: ${currentBlock}`}
                aria-label={`Block type: ${currentBlock}`}
                aria-haspopup="menu"
                aria-expanded={openMenu === "block"}
                disabled={!editor}
                onClick={() => toggleMenu("block", blockButtonRef)}
                className={toolButtonCls(currentBlock !== "Body")}
              >
                <span aria-hidden>{currentBlock} ▾</span>
              </button>
              <button
                type="button"
                title="Bold"
                aria-label="Bold"
                aria-pressed={boldActive}
                disabled={!editor}
                onClick={() => toggleMarkWithSavedSelection("bold")}
                className={toolButtonCls(boldActive)}
              >
                <Bold size={17} aria-hidden />
              </button>
              <button
                type="button"
                title="Italic"
                aria-label="Italic"
                aria-pressed={italicActive}
                disabled={!editor}
                onClick={() => toggleMarkWithSavedSelection("italic")}
                className={toolButtonCls(italicActive)}
              >
                <Italic size={17} aria-hidden />
              </button>
              <button
                ref={listButtonRef}
                type="button"
                title="List"
                aria-label="List"
                aria-haspopup="menu"
                aria-expanded={openMenu === "list"}
                disabled={!editor}
                onClick={() => toggleMenu("list", listButtonRef)}
                className={toolButtonCls(bulletActive || orderedActive)}
              >
                <List size={17} aria-hidden />
                <span aria-hidden className="text-xs">▾</span>
              </button>
              <button
                type="button"
                title={linkDisabled ? "Select text to add a link" : "Link"}
                aria-label="Link"
                aria-pressed={linkActive}
                disabled={!editor || linkDisabled}
                onClick={applyLink}
                className={toolButtonCls(linkActive)}
              >
                <Link2 size={17} aria-hidden />
              </button>
              <button
                ref={moreButtonRef}
                type="button"
                title="More"
                aria-label="More"
                aria-haspopup="menu"
                aria-expanded={openMenu === "more"}
                disabled={!editor}
                onClick={() => toggleMenu("more", moreButtonRef)}
                className={toolButtonCls(false)}
              >
                <span aria-hidden>⋯</span>
                <span className="sr-only">More formatting options</span>
              </button>
            </div>
            <FloatingMenu
              open={openMenu === "block"}
              onClose={() => setOpenMenu(null)}
              triggerRef={blockButtonRef}
              label="Block type"
              placement="top"
            >
              <div onKeyDown={handleMenuKeyDown}>
                {blockOptions.map((option) => {
                  const checked = currentBlock === option.name;
                  return (
                    <button
                      key={option.name}
                      type="button"
                      role="menuitemradio"
                      aria-checked={checked}
                      aria-label={option.name}
                      onClick={() => applyBlock(option.kind)}
                      className={menuItemCls}
                    >
                      <span aria-hidden className="w-5 shrink-0">{checked ? "✓" : ""}</span>
                      <span style={option.preview}>{option.name}</span>
                    </button>
                  );
                })}
              </div>
            </FloatingMenu>
            <FloatingMenu
              open={openMenu === "list"}
              onClose={() => setOpenMenu(null)}
              triggerRef={listButtonRef}
              label="List"
              placement="top"
            >
              <div onKeyDown={handleMenuKeyDown}>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={bulletActive}
                  aria-label="Bullets"
                  onClick={() => applyList("bullet")}
                  className={menuItemCls}
                >
                  <span aria-hidden className="w-5 shrink-0">{bulletActive ? "✓" : ""}</span>
                  <List size={17} aria-hidden />
                  <span>Bullets</span>
                </button>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={orderedActive}
                  aria-label="Numbers"
                  onClick={() => applyList("ordered")}
                  className={menuItemCls}
                >
                  <span aria-hidden className="w-5 shrink-0">{orderedActive ? "✓" : ""}</span>
                  <ListOrdered size={17} aria-hidden />
                  <span>Numbers</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  aria-label="Remove list"
                  onClick={() => applyList("remove")}
                  className={menuItemCls}
                >
                  <span aria-hidden className="w-5 shrink-0" />
                  <span>Remove list</span>
                </button>
              </div>
            </FloatingMenu>
            <FloatingMenu
              open={openMenu === "more"}
              onClose={() => setOpenMenu(null)}
              triggerRef={moreButtonRef}
              label="More formatting options"
              placement="top"
            >
              <div onKeyDown={handleMenuKeyDown}>
                <button
                  type="button"
                  role="menuitem"
                  aria-label="Quote"
                  aria-pressed={quoteActive}
                  onClick={applyQuote}
                  className={menuItemCls}
                >
                  <span aria-hidden className="w-5 shrink-0">{quoteActive ? "✓" : ""}</span>
                  <Quote size={17} aria-hidden />
                  <span>Quote</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  aria-label="Clear all formatting"
                  title="Removes block styles (heading, list, quote) and inline styles (bold, italic, link)"
                  onClick={applyClearAll}
                  className={menuItemCls}
                >
                  <span aria-hidden className="w-5 shrink-0" />
                  <RemoveFormatting size={17} aria-hidden />
                  <span>Clear all formatting</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  aria-label="Undo"
                  disabled={!canUndo}
                  onClick={applyUndo}
                  className={menuItemCls}
                >
                  <span aria-hidden className="w-5 shrink-0" />
                  <Undo2 size={17} aria-hidden />
                  <span>Undo</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  aria-label="Redo"
                  disabled={!canRedo}
                  onClick={applyRedo}
                  className={menuItemCls}
                >
                  <span aria-hidden className="w-5 shrink-0" />
                  <Redo2 size={17} aria-hidden />
                  <span>Redo</span>
                </button>
              </div>
            </FloatingMenu>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
