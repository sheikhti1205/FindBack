import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowDown, Check, ChevronDown, Copy } from "lucide-react";
import { MarkdownView } from "./MarkdownView";
import {
  fadeUpVariants,
  fadeVariants,
  listItemVariants,
  motionDurations,
  motionEasings,
  pressFeedback,
  shouldReduceMotion,
  useShouldReduceMotion,
} from "./uiMotion";

/**
 * How long the copy control stays in its confirmed (Check) state. This is a
 * state-revert timing, not an animation duration — the swap itself uses the
 * shared motion tokens.
 */
const COPY_CONFIRM_MS = 1500;

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
 * control / links / meaningful status (handled by callers). Follows the
 * latest message only while the user is near the bottom — scrolling up stops
 * auto-follow immediately — and offers a floating right-edge scroll-to-latest
 * control while away from the bottom.
 *
 * Motion: each turn enters once with a tiny rise/fade (restored history never
 * replays the entrance), streamed tokens never animate — only the bubble does —
 * and the busy row fades out cleanly as the finished answer arrives.
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
  // Floating scroll-to-latest state: visible only while the user is away from
  // the bottom; hidden while the finger is actively scrolling (reappears on
  // scroll idle); dotted when unseen response content arrived while away.
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const [scrolling, setScrolling] = useState(false);
  const [unseenResponse, setUnseenResponse] = useState(false);
  const scrollIdleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [detailsOpen, setDetailsOpen] = useState<string | null>(null);
  const reduceMotion = useShouldReduceMotion();
  // Entrance suppression: the turns already on screen (restored history)
  // render settled; only turns appended after mount rise in.
  const entranceReady = useRef(false);
  useEffect(() => {
    entranceReady.current = true;
  }, []);
  useEffect(
    () => () => {
      if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    },
    [],
  );

  function nearBottom(): boolean {
    const el = scrollRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 96;
  }

  // Imperative scroll cannot see MotionConfig: honor the OS setting here.
  // The hook supplies the reactive view of the preference; the live read is
  // re-queried at call time so a change the hook never observed (framer-motion
  // v13 does not subscribe) still collapses the travel to instant.
  function scrollToLatest() {
    const instant = reduceMotion || shouldReduceMotion();
    bottomRef.current?.scrollIntoView({ behavior: instant ? "auto" : "smooth" });
    setUnseenResponse(false);
  }

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    setAwayFromBottom(!nearBottom());
    // Hide the control while the finger is actively scrolling; an idle timer
    // brings it back ~200 ms after scrolling stops, if still away.
    setScrolling(true);
    if (scrollIdleTimer.current !== null) clearTimeout(scrollIdleTimer.current);
    scrollIdleTimer.current = setTimeout(() => {
      scrollIdleTimer.current = null;
      setScrolling(false);
    }, 200);
  }

  useEffect(
    () => () => {
      if (scrollIdleTimer.current !== null) clearTimeout(scrollIdleTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (messages.length === 0 && (partialText === null || partialText === "")) return;
    if (nearBottom()) {
      setAwayFromBottom(false);
      setUnseenResponse(false);
      scrollToLatest();
    } else if (messages[messages.length - 1]?.role === "assistant" || (partialText !== null && partialText !== "")) {
      // User scrolled up: never yank them back down. Mark the arrival so the
      // floating control can dot, and tapping it jumps to latest.
      setAwayFromBottom(true);
      setUnseenResponse(true);
    }
    // Keyed on content: scroll follows messages AND the throttled partial.
  }, [messages, partialText]);

  // Hardening (v0.9.0-beta.1): an empty/new conversation can never show the
  // scroll-to-latest control. Content keyed above bails early when there is
  // nothing to follow, so stale away/dot state from a previous chat is reset
  // on switch to an empty one.
  useEffect(() => {
    if (messages.length === 0) {
      setAwayFromBottom(false);
      setUnseenResponse(false);
    }
  }, [messages.length]);

  async function copyAnswer(message: TranscriptMessage) {
    const text = message.text;
    try {
      if (!navigator.clipboard?.writeText) return;
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard refused/unavailable: no confirmed state, no fake Check.
      return;
    }
    setCopiedId(message.id);
    if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopiedId(null), COPY_CONFIRM_MS);
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        data-testid="chat-transcript"
        role="log"
        aria-live="polite"
        aria-label="Assistant conversation"
        onScroll={handleScroll}
        className="relative flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto bg-surface px-4 py-4"
      >
        {messages.map((m) => (
          <motion.div
            key={m.id}
            data-testid="chat-message"
            variants={listItemVariants}
            initial={entranceReady.current ? "hidden" : false}
            animate="visible"
            transition={{ duration: motionDurations.fast, ease: motionEasings.out }}
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
                <p className="mb-1 text-xs text-on-surface-variant">
                  {sourceLabel(m.source, m.sourceDetail)}
                </p>
              )}
              {/* The bubble animates once; the tokens inside it never do. */}
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
                    <motion.button
                      key={a.id}
                      type="button"
                      onClick={() => onAction?.(a.id)}
                      whileTap={pressFeedback.button}
                      transition={{ duration: motionDurations.instant }}
                      className="min-h-[48px] rounded-full border border-outline px-3 text-xs font-medium text-on-surface"
                    >
                      {a.label}
                    </motion.button>
                  ))}
                </div>
              )}
              {m.role === "assistant" && (
                <div className="mt-2 flex items-center gap-1">
                  <motion.button
                    type="button"
                    data-testid={`chat-copy-${m.id}`}
                    onClick={() => void copyAnswer(m)}
                    whileTap={pressFeedback.iconButton}
                    transition={{ duration: motionDurations.instant }}
                    aria-label={copiedId === m.id ? "Copied" : "Copy answer"}
                    className="flex min-h-[48px] min-w-[48px] items-center justify-center rounded-full border border-outline-variant text-on-surface-variant hover:bg-surface-container"
                  >
                    {/* Overlapping grid cell so the icon swap never reflows. */}
                    <span className="grid place-items-center">
                      <AnimatePresence initial={false}>
                        {copiedId === m.id ? (
                          <motion.span
                            key="copied"
                            data-testid="chat-copy-icon-check"
                            initial={{ opacity: 0, scale: 0.9 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.9 }}
                            transition={{ duration: motionDurations.fast, ease: motionEasings.out }}
                            className="grid [grid-area:1/1]"
                            aria-hidden
                          >
                            <Check size={16} />
                          </motion.span>
                        ) : (
                          <motion.span
                            key="copy"
                            data-testid="chat-copy-icon-copy"
                            initial={{ opacity: 0, scale: 0.9 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.9 }}
                            transition={{ duration: motionDurations.fast, ease: motionEasings.out }}
                            className="grid [grid-area:1/1]"
                            aria-hidden
                          >
                            <Copy size={16} />
                          </motion.span>
                        )}
                      </AnimatePresence>
                    </span>
                  </motion.button>
                  {copiedId === m.id && (
                    <span role="status" className="text-xs text-on-surface-variant">
                      Copied
                    </span>
                  )}
                  {(m.sourceDetail !== undefined && m.sourceDetail !== null && m.sourceDetail.trim() !== "") ||
                  (m.attachments !== undefined && m.attachments > 0) ? (
                    <div className="flex min-h-[48px] items-center">
                      <motion.button
                        type="button"
                        data-testid={`chat-details-${m.id}`}
                        onClick={() => setDetailsOpen((prev) => (prev === m.id ? null : m.id))}
                        aria-expanded={detailsOpen === m.id}
                        aria-label="Response details"
                        whileTap={pressFeedback.iconButton}
                        transition={{ duration: motionDurations.instant }}
                        className="flex min-h-[48px] min-w-[48px] items-center justify-center rounded-full text-on-surface-variant hover:bg-surface-container"
                      >
                        <ChevronDown
                          size={16}
                          aria-hidden
                          className={`transition-transform ${detailsOpen === m.id ? "rotate-180" : ""}`}
                        />
                      </motion.button>
                    </div>
                  ) : null}
                </div>
              )}
              {m.role === "assistant" && detailsOpen === m.id && (
                <div
                  data-testid={`chat-details-panel-${m.id}`}
                  className="mt-1 flex flex-col gap-0.5 border-t border-outline-variant pt-1.5 text-xs text-on-surface-variant"
                >
                  {m.sourceDetail !== undefined && m.sourceDetail !== null && m.sourceDetail.trim() !== "" && (
                    <p>
                      <span className="font-medium">Source </span>
                      {m.sourceDetail}
                    </p>
                  )}
                  {m.attachments !== undefined && m.attachments > 0 && (
                    <p>
                      <span className="font-medium">Photos used </span>
                      {m.attachments}
                    </p>
                  )}
                </div>
              )}
              {m.failed === true && onRetry !== undefined && (
                <motion.button
                  type="button"
                  onClick={onRetry}
                  data-testid="chat-retry-inline"
                  whileTap={pressFeedback.button}
                  transition={{ duration: motionDurations.instant }}
                  className="mt-2 min-h-[48px] rounded-m3-xs px-3 text-xs font-semibold text-on-surface underline"
                >
                  Retry
                </motion.button>
              )}
            </div>
          </motion.div>
        ))}
        {partialText !== null && partialText !== "" && (
          <motion.div
            data-testid="chat-partial"
            variants={fadeVariants}
            initial="hidden"
            animate="visible"
            transition={{ duration: motionDurations.fast }}
            className="flex justify-start"
          >
            <div className="max-w-[85%] rounded-m3-md border border-outline-variant bg-surface-container-low px-3.5 py-2.5 text-sm leading-relaxed">
              <p className="mb-1 text-xs text-on-surface-variant">
                {partialLabel !== null && partialLabel !== "" ? partialLabel : "AI answer"}
              </p>
              {/* Streamed text grows here — never animated per token. */}
              <MarkdownView text={partialText} />
            </div>
          </motion.div>
        )}
        <AnimatePresence initial={false}>
          {busy && (
            <motion.div
              key="busy"
              data-testid="chat-busy"
              variants={fadeVariants}
              initial="hidden"
              animate="visible"
              exit="exit"
              transition={{ duration: motionDurations.fast }}
              className="flex items-center gap-2 text-xs text-on-surface-variant"
            >
              <span
                aria-hidden
                className="h-3 w-3 animate-spin rounded-full border border-outline border-t-on-surface"
              />
              {busyLabel}
              {onStop !== undefined && (
                <motion.button
                  type="button"
                  data-testid="chat-stop"
                  onClick={onStop}
                  aria-label={stopLabel}
                  whileTap={pressFeedback.button}
                  transition={{ duration: motionDurations.instant }}
                  className="min-h-[48px] rounded-m3-xs px-3 text-xs font-semibold text-on-surface underline"
                >
                  Stop
                </motion.button>
              )}
            </motion.div>
          )}
        </AnimatePresence>
        {notice !== null && notice !== "" && (
          <motion.p
            data-testid="chat-notice"
            variants={fadeUpVariants}
            initial="hidden"
            animate="visible"
            transition={{ duration: motionDurations.fast, ease: motionEasings.out }}
            className="text-xs text-on-surface-variant"
          >
            {notice}
          </motion.p>
        )}
        <AnimatePresence initial={false}>
          {error !== null && error !== "" && (
            <motion.div
              key="error"
              data-testid="chat-error"
              role="alert"
              variants={fadeUpVariants}
              initial="hidden"
              animate="visible"
              exit="exit"
              transition={{ duration: motionDurations.fast, ease: motionEasings.out }}
              className="flex flex-wrap items-center gap-2 rounded-m3-sm border border-outline-variant bg-surface-container-low px-3 py-2 text-xs text-on-surface"
            >
              <span className="flex-1">{error}</span>
              {onRetry !== undefined && (
                <motion.button
                  type="button"
                  data-testid="chat-retry"
                  onClick={onRetry}
                  whileTap={pressFeedback.button}
                  transition={{ duration: motionDurations.instant }}
                  className="min-h-[48px] rounded-m3-xs px-3 text-xs font-semibold text-on-surface underline"
                >
                  Retry
                </motion.button>
              )}
            </motion.div>
          )}
        </AnimatePresence>
        <div ref={bottomRef} data-testid="chat-bottom" aria-hidden />
      </div>
      {/* Floating right-edge scroll-to-latest: 40 dp visual inside a 48 dp
          touch target, 16 dp right inset, above the composer. Appears only
          while away from the bottom, hides during active scrolling, dots when
          unseen response content arrived while away. */}
      <AnimatePresence initial={false}>
        {awayFromBottom && !scrolling && (
          <motion.div
            key="scroll-latest"
            variants={fadeVariants}
            initial="hidden"
            animate="visible"
            exit="exit"
            transition={{ duration: motionDurations.fast }}
            className="pointer-events-none absolute bottom-3 right-3"
          >
            <motion.button
              type="button"
              data-testid="chat-scroll-latest"
              onClick={scrollToLatest}
              whileTap={pressFeedback.button}
              transition={{ duration: motionDurations.instant }}
              aria-label={unseenResponse ? "Scroll to latest response" : "Scroll to latest"}
              className="pointer-events-auto relative flex min-h-[48px] min-w-[48px] items-center justify-center rounded-full border border-outline bg-surface text-on-surface shadow"
            >
              <span className="grid h-10 w-10 place-items-center">
                <ArrowDown size={18} aria-hidden />
              </span>
              {unseenResponse && (
                <span
                  data-testid="chat-scroll-latest-dot"
                  aria-hidden
                  className="absolute right-2.5 top-2.5 h-2 w-2 rounded-full bg-on-surface"
                />
              )}
            </motion.button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
