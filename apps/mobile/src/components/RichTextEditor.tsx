import { useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import type { JSONContent } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import type { Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Bold, Heading2, Italic, Link2, List, Pilcrow, Quote } from "lucide-react";
import {
  fromMarkdown,
  isSafeRichTextHref,
  toMarkdown,
  type InlineNode,
  type RichTextDocument,
} from "../services/richText";

export const RICH_TEXT_DEBOUNCE_MS = 300;

interface RichTextEditorProps {
  label: string;
  value: string;
  onChange: (markdown: string) => void;
  placeholder?: string;
  editorRef?: RefObject<Editor | null>;
}

interface PMTextMark {
  type: string;
  attrs?: { href?: string };
}

interface PMNode {
  type: string;
  attrs?: { level?: number; href?: string };
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
    case "Link":
      return isSafeRichTextHref(run.href) ? [{ type: "link", attrs: { href: run.href } }] : undefined;
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
        case "Quote": {
          const paras: PMNode[] = [];
          for (const run of block.runs) {
            for (const line of run.text.split("\n")) {
              const node: PMNode = { type: "paragraph" };
              if (line !== "") {
                const marks = markForRun({ ...run, text: line });
                node.content = marks ? [{ type: "text", text: line, marks }] : [{ type: "text", text: line }];
              }
              paras.push(node);
            }
          }
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
    if (link?.attrs?.href !== undefined && isSafeRichTextHref(link.attrs.href)) {
      runs.push({ type: "Link", href: link.attrs.href.trim(), text: node.text });
      continue;
    }
    if (marks.some((m) => m.type === "bold")) runs.push({ type: "Bold", text: node.text });
    else if (marks.some((m) => m.type === "italic")) runs.push({ type: "Italic", text: node.text });
    else runs.push({ type: "InlineText", text: node.text });
  }
  const merged: InlineNode[] = [];
  for (const run of runs) {
    const prev = merged[merged.length - 1];
    if (prev?.type === "InlineText" && run.type === "InlineText") prev.text += run.text;
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
    return toMarkdown({ v: 1, blocks });
  } catch {
    return "";
  }
}

/**
 * YAGNI rich-text editor: Paragraph/Heading/BulletList/Quote blocks plus
 * Bold/Italic/Link marks. Markdown is the interchange format; output is
 * debounced so parent state updates don't fight the editor.
 */
export function RichTextEditor({ label, value, onChange, placeholder, editorRef }: RichTextEditorProps) {
  const [empty, setEmpty] = useState(true);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const timer = useRef<number | null>(null);

  const initialContent = useMemo(() => markdownToTiptap(value), []);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({
          code: false,
          codeBlock: false,
          horizontalRule: false,
          orderedList: false,
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
          class: "tiptap min-h-[120px] rounded-m3-sm border border-outline-variant bg-surface px-3.5 py-3 text-base focus:outline-none",
        },
      },
      onCreate: ({ editor: created }) => {
        setEmpty(created.isEmpty);
        if (editorRef) editorRef.current = created;
      },
      onUpdate: ({ editor: updated }) => {
        setEmpty(updated.isEmpty);
        const markdown = tiptapToMarkdown(updated.getJSON());
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => onChangeRef.current(markdown), RICH_TEXT_DEBOUNCE_MS);
      },
    },
    [],
  );

  useEffect(() => {
    if (editorRef) editorRef.current = editor;
  }, [editor, editorRef]);

  function applyLink() {
    if (!editor) return;
    if (editor.isActive("link")) {
      editor.chain().focus().unsetLink().run();
      return;
    }
    const href = window.prompt("Link URL", "https://");
    if (!href) return;
    const clean = href.trim();
    if (!isSafeRichTextHref(clean)) return;
    editor.chain().focus().setLink({ href: clean }).run();
  }

  const tools = [
    { label: "Paragraph", icon: Pilcrow, active: editor?.isActive("paragraph") ?? false, run: () => editor?.chain().focus().setParagraph().run() },
    { label: "Heading", icon: Heading2, active: editor?.isActive("heading", { level: 2 }) ?? false, run: () => editor?.chain().focus().toggleHeading({ level: 2 }).run() },
    { label: "Bullet list", icon: List, active: editor?.isActive("bulletList") ?? false, run: () => editor?.chain().focus().toggleBulletList().run() },
    { label: "Quote", icon: Quote, active: editor?.isActive("blockquote") ?? false, run: () => editor?.chain().focus().toggleBlockquote().run() },
    { label: "Bold", icon: Bold, active: editor?.isActive("bold") ?? false, run: () => editor?.chain().focus().toggleBold().run() },
    { label: "Italic", icon: Italic, active: editor?.isActive("italic") ?? false, run: () => editor?.chain().focus().toggleItalic().run() },
    { label: "Link", icon: Link2, active: editor?.isActive("link") ?? false, run: applyLink },
  ];

  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium text-on-surface">{label}</span>
      <div role="toolbar" aria-label={`${label} formatting`} className="flex flex-wrap gap-1">
        {tools.map(({ label: toolLabel, icon: Icon, active, run }) => (
          <button
            key={toolLabel}
            type="button"
            title={toolLabel}
            aria-label={toolLabel}
            aria-pressed={active}
            disabled={!editor}
            onClick={run}
            className={`flex min-h-[48px] min-w-[48px] items-center justify-center rounded-m3-xs text-on-surface-variant hover:bg-surface-container ${
              active ? "bg-surface-container-high text-on-surface" : ""
            }`}
          >
            <Icon size={17} aria-hidden />
          </button>
        ))}
      </div>
      <div className="relative">
        <EditorContent editor={editor} />
        {(!editor || empty) && placeholder ? (
          <div aria-hidden className="pointer-events-none absolute inset-0 px-3.5 py-3 text-base text-on-surface-variant">
            {placeholder}
          </div>
        ) : null}
      </div>
    </div>
  );
}
