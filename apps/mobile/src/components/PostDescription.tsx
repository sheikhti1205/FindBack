import { useId, useLayoutEffect, useRef, useState } from "react";
import { stripMarkdown } from "../utils/stripMarkdown";
import { MarkdownView } from "./MarkdownView";

/** Visual disclosure, never a character-budget truncation or a navigation link. */
export function PostDescription({ text, lines = 2 }: { text: string; lines?: 2 | 5 }) {
  return <DescriptionDisclosure key={text} text={text} lines={lines} />;
}

function DescriptionDisclosure({ text, lines }: { text: string; lines: 2 | 5 }) {
  const id = useId();
  const summary = stripMarkdown(text);
  const ref = useRef<HTMLParagraphElement>(null);
  const [truncated, setTruncated] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setTruncated(el.scrollHeight > el.clientHeight);
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(el);
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, [summary, lines]);
  if (!summary) return null;
  return <div className="relative min-w-0">
    {/* The noninteractive probe stays mounted at the same width while the rich
        body expands. Font/container changes never collapse an active reader. */}
    <p ref={ref} aria-hidden="true" className={`${lines === 2 ? "line-clamp-2" : "line-clamp-5"} pointer-events-none invisible absolute inset-x-0 top-0 whitespace-pre-line break-words text-sm leading-relaxed`}>
      {summary}
    </p>
    <div id={id}>
      {expanded || !truncated ? <div data-testid="post-description"><MarkdownView text={text} /></div> : <p data-testid="post-description"
        className={`${lines === 2 ? "line-clamp-2" : "line-clamp-5"} whitespace-pre-line break-words text-sm leading-relaxed text-on-surface-variant`}>
        {summary}
      </p>}
    </div>
    {(truncated || expanded) && <button type="button" data-testid="post-description-more"
      aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(!expanded)}
      className="min-h-[44px] rounded-sm text-sm font-semibold text-on-surface underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-on-surface">
      {expanded ? "Show less" : "See more"}
    </button>}
  </div>;
}
