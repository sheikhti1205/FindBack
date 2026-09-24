import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import type { JSONContent } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import type { Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { useModalBack } from "../hooks/useModalBack";
import { Bold, Heading2, Italic, Link2, List, ListOrdered, Pilcrow, Quote, Redo2, RemoveFormatting, Undo2 } from "lucide-react";
import {
  fromMarkdown,
  isSafeRichTextHref,
  toMarkdown,
  type InlineNode,
  type RichTextDocument,
} from "../services/richText";

export const RICH_TEXT_DEBOUNCE_MS = 300;

interface LinkSelection {
  from: number;
  to: number;
  text: string;
  doc: Editor["state"]["doc"];
  href: string;
}

function LinkSheet({ selection, onCancel, onSave }: {
  selection: LinkSelection;
  onCancel: () => void;
  onSave: (url: string) => string | null;
}) {
  const id = useId();
  const sheetRef = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState(selection.href || "https://");
  const [message, setMessage] = useState<string | null>(null);
  useFocusTrap(sheetRef, onCancel);
  useModalBack(true, onCancel);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4" role="presentation">
      <div ref={sheetRef} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} className="w-full max-w-md space-y-4 rounded-m3-lg bg-surface p-5 shadow-xl">
        <h2 id={`${id}-title`} className="text-lg font-semibold">{selection.href ? "Edit link" : "Add link"}</h2>
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
            <button type="button" onClick={onCancel} className="min-h-[48px] min-w-[48px] px-3">Cancel</button>
            <button type="submit" className="min-h-[48px] min-w-[48px] rounded-m3-xs bg-on-surface px-3 text-surface">{selection.href ? "Save link" : "Add link"}</button>
          </div>
        </form>
      </div>
    </div>
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
          const items = (node.content ?? [])
            .filter((item) => item.type === "listItem")
            .map((item) =>
              inlineToRuns(
                (item.content ?? []).filter((child) => child.type === "paragraph").flatMap((child) => child.content ?? []),
              ),
            )
            .filter((runs) => runs.some((run) => run.text !== ""));
          if (items.length > 0) blocks.push({ type: "BulletList", items });
          break;
        }
        case "orderedList": {
          const items = (node.content ?? [])
            .filter((item) => item.type === "listItem")
            .map((item) =>
              inlineToRuns(
                (item.content ?? []).filter((child) => child.type === "paragraph").flatMap((child) => child.content ?? []),
              ),
            )
            .filter((runs) => runs.some((run) => run.text !== ""));
          if (items.length > 0) blocks.push({ type: "OrderedList", start: node.attrs?.start ?? 1, items });
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
 */
export function RichTextEditor({ label, value, onChange, placeholder, editorRef, error, required, maxLength, inputId }: RichTextEditorProps) {
  const [empty, setEmpty] = useState(true);
  const [charCount, setCharCount] = useState(0);
  const [, refreshSelection] = useState(0);
  const [linkSelection, setLinkSelection] = useState<LinkSelection | null>(null);
  const baseId = useId();
  const errorId = `${baseId}-error`;
  const countId = `${baseId}-count`;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const valueRef = useRef(value);
  valueRef.current = value;

  const initialContent = useMemo(() => markdownToTiptap(value), []);

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
          class: `tiptap min-h-[120px] rounded-m3-sm border bg-surface px-3.5 py-3 text-base focus:border-on-surface focus:outline-none ${error ? "border-error" : "border-outline-variant"}`,
        },
      },
      onCreate: ({ editor: created }) => {
        setEmpty(created.isEmpty);
        setCharCount(created.getText().length);
        if (editorRef) editorRef.current = created;
      },
      onUpdate: ({ editor: updated }) => {
        setEmpty(updated.isEmpty);
        setCharCount(updated.getText().length);
        const markdown = tiptapToMarkdown(updated.getJSON());
        if (markdown !== valueRef.current) onChangeRef.current(markdown);
      },
      onSelectionUpdate: () => refreshSelection((revision) => revision + 1),
    },
    [],
  );

  useEffect(() => {
    if (!editor) return;
    if (editorRef) editorRef.current = editor;
    if (tiptapToMarkdown(editor.getJSON()) !== value) {
      editor.commands.setContent(markdownToTiptap(value));
    }
    setEmpty(editor.isEmpty);
    setCharCount(editor.getText().length);
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

  function applyLink() {
    if (!editor) return;
    const { from, to, empty: collapsed } = editor.state.selection;
    if (collapsed && editor.isActive("link")) {
      editor.chain().focus().unsetLink().run();
      return;
    }
    if (collapsed) return;
    setLinkSelection({
      from, to, text: editor.state.doc.textBetween(from, to), doc: editor.state.doc,
      href: (editor.getAttributes("link")["href"] as string | undefined) ?? "",
    });
  }

  function saveLink(href: string): string | null {
    if (!editor || !linkSelection) return "Selection is no longer available.";
    if (!isSafeRichTextHref(href) || /\s/.test(href) || Array.from(href).some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)) return "Enter a safe HTTP(S) URL.";
    const { from, to, doc, text } = linkSelection;
    if (editor.state.doc !== doc || editor.state.doc.textBetween(from, to) !== text) {
      return "The selected text changed. Cancel and select it again.";
    }
    editor.chain().focus().setTextSelection({ from, to }).setLink({ href }).run();
    setLinkSelection(null);
    queueMicrotask(() => editor.commands.focus());
    return null;
  }

  const canUndo = editor?.can().chain().focus().undo().run() ?? false;
  const canRedo = editor?.can().chain().focus().redo().run() ?? false;

  const tools = [
    { label: "Paragraph", icon: Pilcrow, active: editor?.isActive("paragraph") ?? false, disabled: false, run: () => editor?.chain().focus().setParagraph().run() },
    { label: "Heading", icon: Heading2, active: editor?.isActive("heading", { level: 2 }) ?? false, disabled: false, run: () => editor?.chain().focus().toggleHeading({ level: 2 }).run() },
    { label: "Bold", icon: Bold, active: editor?.isActive("bold") ?? false, disabled: false, run: () => editor?.chain().focus().toggleBold().run() },
    { label: "Italic", icon: Italic, active: editor?.isActive("italic") ?? false, disabled: false, run: () => editor?.chain().focus().toggleItalic().run() },
    { label: "Bullet list", icon: List, active: editor?.isActive("bulletList") ?? false, disabled: false, run: () => editor?.chain().focus().toggleBulletList().run() },
    { label: "Numbered list", icon: ListOrdered, active: editor?.isActive("orderedList") ?? false, disabled: false, run: () => editor?.chain().focus().toggleOrderedList().run() },
    { label: "Quote", icon: Quote, active: editor?.isActive("blockquote") ?? false, disabled: false, run: () => editor?.chain().focus().toggleBlockquote().run() },
    { label: "Link", icon: Link2, active: editor?.isActive("link") ?? false, disabled: (editor?.state.selection.empty ?? true) && !(editor?.isActive("link") ?? false), run: applyLink },
    { label: "Clear formatting", icon: RemoveFormatting, active: false, disabled: false, run: () => editor?.chain().focus().clearNodes().unsetAllMarks().run() },
    { label: "Undo", icon: Undo2, active: false, disabled: !canUndo, run: () => editor?.chain().focus().undo().run() },
    { label: "Redo", icon: Redo2, active: false, disabled: !canRedo, run: () => editor?.chain().focus().redo().run() },
  ];

  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium text-on-surface">{label}</span>
      <div className="relative">
        <EditorContent editor={editor} />
        {(!editor || empty) && placeholder ? (
          <div aria-hidden className="pointer-events-none absolute inset-0 px-3.5 py-3 text-base text-on-surface-variant">
            {placeholder}
          </div>
        ) : null}
      </div>
      <div role="toolbar" aria-label={`${label} formatting`} className="flex flex-nowrap gap-1 overflow-x-auto pb-1">
        {tools.map(({ label: toolLabel, icon: Icon, active, disabled, run }) => (
          <button
            key={toolLabel}
            type="button"
            title={toolLabel}
            aria-label={toolLabel}
            aria-pressed={active}
            disabled={!editor || disabled}
            onClick={run}
            className={`flex min-h-[48px] min-w-[48px] shrink-0 items-center justify-center rounded-m3-xs text-on-surface-variant hover:bg-surface-container ${
              active ? "bg-surface-container-high text-on-surface" : ""
            }`}
          >
            <Icon size={17} aria-hidden />
          </button>
        ))}
      </div>
      {linkSelection && <LinkSheet selection={linkSelection} onCancel={() => setLinkSelection(null)} onSave={saveLink} />}
      {error ? (
        <p id={errorId} className="text-xs text-error" role="alert">
          {error}
        </p>
      ) : null}
      <span id={countId} role="status" aria-label="Character count" className="text-xs text-on-surface-variant">
        {maxLength !== undefined
          ? `${charCount} / ${maxLength} ${charCount === 1 ? "character" : "characters"}`
          : `${charCount} ${charCount === 1 ? "character" : "characters"}`}
      </span>
    </div>
  );
}
