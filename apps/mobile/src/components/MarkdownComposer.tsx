import { useState } from "react";
import { Bold, Code, Italic, Link2, List, ListOrdered, Quote } from "lucide-react";
import { MarkdownView } from "./MarkdownView";

interface MarkdownComposerProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  inputId?: string;
}

/** Wrap/annotate the current selection (or insert at cursor) inside a textarea. */
function applyWrap(
  el: HTMLTextAreaElement,
  value: string,
  before: string,
  after: string,
  placeholder: string,
): string {
  const start = el.selectionStart ?? value.length;
  const end = el.selectionEnd ?? value.length;
  const selected = value.slice(start, end) || placeholder;
  return value.slice(0, start) + before + selected + after + value.slice(end);
}

function applyLinePrefix(el: HTMLTextAreaElement, value: string, prefix: string): string {
  const start = el.selectionStart ?? value.length;
  const end = el.selectionEnd ?? value.length;
  const selected = value.slice(start, end) || "item";
  const prefixed = selected
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
  return value.slice(0, start) + prefixed + value.slice(end);
}

/**
 * Lightweight Markdown authoring: selection-aware toolbar + Write/Preview tabs.
 * Toggling never loses content; preview is fully offline.
 */
export function MarkdownComposer({
  label,
  value,
  onChange,
  placeholder,
  required,
  inputId,
}: MarkdownComposerProps) {
  const [tab, setTab] = useState<"write" | "preview">("write");
  const [area, setArea] = useState<HTMLTextAreaElement | null>(null);

  function edit(fn: (el: HTMLTextAreaElement) => string) {
    if (!area) return;
    onChange(fn(area));
    area.focus();
  }

  const tools = [
    { label: "Bold", icon: Bold, run: (el: HTMLTextAreaElement) => applyWrap(el, value, "**", "**", "text") },
    { label: "Italic", icon: Italic, run: (el: HTMLTextAreaElement) => applyWrap(el, value, "*", "*", "text") },
    { label: "Bullet list", icon: List, run: (el: HTMLTextAreaElement) => applyLinePrefix(el, value, "- ") },
    { label: "Numbered list", icon: ListOrdered, run: (el: HTMLTextAreaElement) => applyLinePrefix(el, value, "1. ") },
    { label: "Quote", icon: Quote, run: (el: HTMLTextAreaElement) => applyLinePrefix(el, value, "> ") },
    { label: "Inline code", icon: Code, run: (el: HTMLTextAreaElement) => applyWrap(el, value, "`", "`", "code") },
    { label: "Link", icon: Link2, run: (el: HTMLTextAreaElement) => applyWrap(el, value, "[", "](https://)", "link text") },
  ];

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-on-surface" id={inputId ? `${inputId}-label` : undefined}>
          {label}
        </span>
        <div role="tablist" aria-label={`${label} editing mode`} className="flex rounded-full border border-outline-variant p-0.5">
          {(["write", "preview"] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={`min-h-[48px] rounded-full px-4 text-xs font-medium ${
                tab === t ? "bg-on-surface text-surface" : "text-on-surface-variant"
              }`}
            >
              {t === "write" ? "Write" : "Preview"}
            </button>
          ))}
        </div>
      </div>

      {tab === "write" ? (
        <>
          <div role="toolbar" aria-label={`${label} formatting`} className="flex flex-wrap gap-1">
            {tools.map(({ label: toolLabel, icon: Icon, run }) => (
              <button
                key={toolLabel}
                type="button"
                title={toolLabel}
                aria-label={toolLabel}
                onClick={() => edit(run)}
                className="flex min-h-[48px] min-w-[48px] items-center justify-center rounded-m3-xs text-on-surface-variant hover:bg-surface-container"
              >
                <Icon size={17} aria-hidden />
              </button>
            ))}
          </div>
          <textarea
            ref={setArea}
            id={inputId}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            rows={4}
            placeholder={placeholder}
            required={required}
            aria-label={label}
            className="w-full rounded-m3-sm border border-outline-variant bg-surface px-3.5 py-3 text-base placeholder:text-on-surface-variant focus:border-on-surface focus:outline-none"
          />
          <p className="text-xs text-on-surface-variant">Markdown supported</p>
        </>
      ) : (
        <div
          role="tabpanel"
          aria-label={`${label} preview`}
          className="min-h-[120px] rounded-m3-sm border border-outline-variant bg-surface-container-low px-3.5 py-3"
        >
          {value.trim() ? <MarkdownView text={value} /> : <p className="text-sm text-on-surface-variant">Nothing to preview yet.</p>}
        </div>
      )}
    </div>
  );
}
