import { useEffect, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";
import { MarkdownView } from "./MarkdownView";

export interface TranscriptAction {
  id: string;
  label: string;
}

export type TranscriptSource = "llm" | "fallback" | "model" | "grounded";

export interface TranscriptMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** Omitted when unknown (e.g. restored turns carry no provenance). No badge then. */
  source?: TranscriptSource;
  /**
   * Actual provenance when known (e.g. "openrouter · llama-3.2"). Rendered
   * verbatim instead of the generic label; never fabricated.
   */
  sourceDetail?: string | null;
  failed?: boolean;
  actions?: TranscriptAction[];
  /** Count of attached photos on this turn; renders an honest caption. */
  attachments?: number;
}

export interface ChatTranscriptProps {
  messages: readonly TranscriptMessage[];
  busy?: boolean;
  busyLabel?: string;
  onStop?: () => void;
  stopLabel?: string;
  /** Data-only status line (e.g. compaction notice). Never markup. */
  notice?: string | null;
  /** Send failure text; paired with onRetry. */
  error?: string | null;
  onRetry?: () => void;
  onAction?: (id: string) => void;
  /** In-flight streamed text (throttled upstream); null/empty hides the bubble. */
  partialText?: string | null;
  /** Provenance for the partial bubble; defaults to the generic AI label. */
  partialLabel?: string | null;
}

/**
 * G08 fix: a stored turn that only says "llm" no longer claims a specific
 * provider — the label is the actual provenance when known, else generic AI.
 */
function sourceLabel(source: TranscriptSource, detail?: string | null): string {
  if (detail !== undefined && detail !== null && detail.trim() !== "") return detail;
  return source === "llm" || source === "model" ? "AI answer" : "Built-in answer";
}

/**
 * Scrollable conversation log. Grayscale surfaces; colour only on the send
 * control / links / meaningful status (handled by callers). Sticks to the
 * latest message and offers a "New response" pill when the user scrolled up.
 */
export function ChatTranscript({
  messages,
  busy = false,
  busyLabel = "Thinking…",
  onStop,
  stopLabel = "Stop generating",
  notice = null,
  error = null,
  onRetry,
  onAction,
  partialText = null,
  partialLabel = null,
}: ChatTranscriptProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [showNewResponse, setShowNewResponse] = useState(false);

  function nearBottom(): boolean {
    const el = scrollRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 96;
  }

  function scrollToLatest() {
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    bottomRef.current?.scrollIntoView({ behavior: reduce ? "auto" : "smooth" });
    setShowNewResponse(false);
  }

  useEffect(() => {
    if (messages.length === 0 && (partialText === null || partialText === "")) return;
    if (nearBottom()) {
      scrollToLatest();
    } else if (messages[messages.length - 1]?.role === "assistant" || (partialText !== null && partialText !== "")) {
      setShowNewResponse(true);
    }
    // Keyed on content: scroll follows messages AND the throttled partial.
  }, [messages, partialText]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        data-testid="chat-transcript"
        role="log"
        aria-live="polite"
        aria-label="Assistant conversation"
        className="relative flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto bg-surface px-4 py-4"
      >
        {messages.map((m) => (
          <div
            key={m.id}
            data-testid="chat-message"
            className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[85%] rounded-m3-md px-3.5 py-2.5 text-sm leading-relaxed ${
                m.role === "user"
                  ? "bg-on-surface text-surface"
                  : "border border-outline-variant bg-surface-container-low"
              }`}
            >
              {m.role === "assistant" && m.source !== undefined && (
                <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-on-surface-variant">
                  {sourceLabel(m.source, m.sourceDetail)}
                </p>
              )}
              {m.role === "assistant" ? (
                <MarkdownView text={m.text} />
              ) : (
                <p className="whitespace-pre-wrap">{m.text}</p>
              )}
              {m.attachments !== undefined && m.attachments > 0 && (
                <p className="mt-1 text-[11px] text-on-surface-variant">
                  {m.attachments === 1 ? "1 photo attached" : `${m.attachments} photos attached`}
                </p>
              )}
              {m.actions !== undefined && m.actions.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {m.actions.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => onAction?.(a.id)}
                      className="min-h-[48px] rounded-full border border-outline px-3 text-xs font-medium text-on-surface"
                    >
                      {a.label}
                    </button>
                  ))}
                </div>
              )}
              {m.failed === true && onRetry !== undefined && (
                <button
                  type="button"
                  onClick={onRetry}
                  data-testid="chat-retry-inline"
                  className="mt-2 min-h-[48px] rounded-m3-xs px-3 text-xs font-semibold text-on-surface underline"
                >
                  Retry
                </button>
              )}
            </div>
          </div>
        ))}
        {partialText !== null && partialText !== "" && (
          <div className="flex justify-start">
            <div
              data-testid="chat-partial"
              className="max-w-[85%] rounded-m3-md border border-outline-variant bg-surface-container-low px-3.5 py-2.5 text-sm leading-relaxed"
            >
              <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-on-surface-variant">
                {partialLabel !== null && partialLabel !== "" ? partialLabel : "AI answer"}
              </p>
              <MarkdownView text={partialText} />
            </div>
          </div>
        )}
        {busy && (
          <div className="flex items-center gap-2 text-xs text-on-surface-variant">
            <span
              aria-hidden
              className="h-3 w-3 animate-spin rounded-full border border-outline border-t-on-surface"
            />
            {busyLabel}
            {onStop !== undefined && (
              <button
                type="button"
                data-testid="chat-stop"
                onClick={onStop}
                aria-label={stopLabel}
                className="min-h-[48px] rounded-m3-xs px-3 text-xs font-semibold text-on-surface underline"
              >
                Stop
              </button>
            )}
          </div>
        )}
        {notice !== null && notice !== "" && (
          <p data-testid="chat-notice" className="text-[11px] text-on-surface-variant">
            {notice}
          </p>
        )}
        {error !== null && error !== "" && (
          <div
            data-testid="chat-error"
            role="alert"
            className="flex flex-wrap items-center gap-2 rounded-m3-sm border border-outline-variant bg-surface-container-low px-3 py-2 text-xs text-on-surface"
          >
            <span className="flex-1">{error}</span>
            {onRetry !== undefined && (
              <button
                type="button"
                data-testid="chat-retry"
                onClick={onRetry}
                className="min-h-[48px] rounded-m3-xs px-3 text-xs font-semibold text-on-surface underline"
              >
                Retry
              </button>
            )}
          </div>
        )}
        <div ref={bottomRef} data-testid="chat-bottom" aria-hidden />
      </div>
      {showNewResponse && (
        <div className="flex justify-center bg-surface px-4 pb-2">
          <button
            type="button"
            data-testid="chat-new-response"
            onClick={scrollToLatest}
            className="flex min-h-[48px] items-center gap-1 rounded-full border border-outline bg-surface px-4 text-xs font-semibold text-on-surface shadow"
          >
            <ArrowDown size={14} aria-hidden /> New response
          </button>
        </div>
      )}
    </div>
  );
}
