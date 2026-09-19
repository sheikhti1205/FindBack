import { useId, useLayoutEffect, useRef, useState } from "react";
import { Bold, Code, Italic, Link2, List, ListOrdered, Quote } from "lucide-react";
import { MarkdownView } from "./MarkdownView";

interface MarkdownComposerProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  inputId?: string;
  error?: string;
  maxLength?: number;
}

interface EditResult {
  text: string;
  selection: [number, number];
}

/** Wrap/annotate the current selection (or insert at cursor) inside a textarea. */
function applyWrap(
  el: HTMLTextAreaElement,
  value: string,
  before: string,
  after: string,
  placeholder: string,
): EditResult {
  const start = el.selectionStart ?? value.length;
  const end = el.selectionEnd ?? value.length;
  const selected = value.slice(start, end) || placeholder;
  const text = value.slice(0, start) + before + selected + after + value.slice(end);
  return {
    text,
    selection: [start + before.length, start + before.length + selected.length],
  };
}

function applyLinePrefix(el: HTMLTextAreaElement, value: string, prefix: string): EditResult {
  const start = el.selectionStart ?? value.length;
  const end = el.selectionEnd ?? value.length;
  const selected = value.slice(start, end) || "item";
  const prefixed = selected
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
  const text = value.slice(0, start) + prefixed + value.slice(end);
  return { text, selection: [start, start + prefixed.length] };
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
  error,
  maxLength,
}: MarkdownComposerProps) {
  const [tab, setTab] = useState<"write" | "preview">("write");
  const [area, setArea] = useState<HTMLTextAreaElement | null>(null);
  const baseId = useId();
  const writeTabId = `${baseId}-write-tab`;
  const previewTabId = `${baseId}-preview-tab`;
  const writePanelId = `${baseId}-write-panel`;
  const previewPanelId = `${baseId}-preview-panel`;
  const errorId = `${baseId}-error`;

  // Restore the caret/selection after a toolbar edit rewrites the controlled
  // value; otherwise React moves the cursor to the end.
  const pendingSelection = useRef<[number, number] | null>(null);
  useLayoutEffect(() => {
    if (!area || !pendingSelection.current) return;
    const [start, end] = pendingSelection.current;
    pendingSelection.current = null;
    area.focus();
    area.setSelectionRange(start, end);
  }, [value, area]);

  function edit(fn: (el: HTMLTextAreaElement) => EditResult) {
    if (!area) return;
    const { text, selection } = fn(area);
    pendingSelection.current = selection;
    onChange(text);
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
        <div
          role="tablist"
          aria-label={`${label} editing mode`}
          className="flex rounded-full border border-outline-variant p-0.5"
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
              e.preventDefault();
              setTab((t) => (t === "write" ? "preview" : "write"));
            }
          }}
        >
          <button
            type="button"
            role="tab"
            id={writeTabId}
            aria-selected={tab === "write"}
            aria-controls={writePanelId}
            tabIndex={tab === "write" ? 0 : -1}
            onClick={() => setTab("write")}
            className={`min-h-[48px] rounded-full px-4 text-xs font-medium ${
              tab === "write" ? "bg-on-surface text-surface" : "text-on-surface-variant"
            }`}
          >
            Write
          </button>
          <button
            type="button"
            role="tab"
            id={previewTabId}
            aria-selected={tab === "preview"}
            aria-controls={previewPanelId}
            tabIndex={tab === "preview" ? 0 : -1}
            onClick={() => setTab("preview")}
            className={`min-h-[48px] rounded-full px-4 text-xs font-medium ${
              tab === "preview" ? "bg-on-surface text-surface" : "text-on-surface-variant"
            }`}
          >
            Preview
          </button>
        </div>
      </div>

      {tab === "write" ? (
        <div role="tabpanel" id={writePanelId} aria-labelledby={writeTabId} className="flex flex-col gap-2">
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
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            maxLength={maxLength}
            className={`w-full rounded-m3-sm border bg-surface px-3.5 py-3 text-base placeholder:text-on-surface-variant focus:outline-none ${
              error ? "border-error" : "border-outline-variant focus:border-on-surface"
            }`}
          />
          {error ? (
            <p id={errorId} className="text-xs text-error" role="alert">
              {error}
            </p>
          ) : (
            <p className="text-xs text-on-surface-variant">Markdown supported</p>
          )}
        </div>
      ) : (
        <div
          role="tabpanel"
          id={previewPanelId}
          aria-labelledby={previewTabId}
          className="min-h-[120px] rounded-m3-sm border border-outline-variant bg-surface-container-low px-3.5 py-3"
        >
          {value.trim() ? <MarkdownView text={value} /> : <p className="text-sm text-on-surface-variant">Nothing to preview yet.</p>}
        </div>
      )}
    </div>
  );
}
