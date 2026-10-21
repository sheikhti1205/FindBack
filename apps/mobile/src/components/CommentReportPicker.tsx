import { useEffect, useId, useRef, useState } from "react";
import { X } from "lucide-react";
import { fetchPost } from "../services/posts";
import { parseReportLink } from "../utils/reportLinks";
import { friendlyError } from "../utils/friendlyErrors";

/** Inline disclosure, not a modal: Tab stays in document order; Escape returns to the trigger. */
export function CommentReportPicker({ disabled, onPick, onClose }: {
  disabled: boolean;
  onPick: (report: { id: string; title: string }) => void;
  onClose: () => void;
}) {
  const [link, setLink] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const request = useRef(0);
  const inputId = useId();
  useEffect(() => {
    inputRef.current?.focus();
    return () => { request.current += 1; };
  }, []);
  useEffect(() => {
    // A send/disabled transition invalidates pending selections, too.
    if (disabled) {
      request.current += 1;
      setLoading(false);
    }
  }, [disabled]);

  async function addReport() {
    if (disabled || loading) return;
    const parsed = parseReportLink(link.trim());
    if (!parsed) { setError("Paste a FindBack report link."); return; }
    const ticket = ++request.current;
    setError(null);
    setLoading(true);
    try {
      const report = await fetchPost(parsed.postId);
      if (ticket !== request.current) return;
      onPick({ id: report.id, title: report.title });
    } catch (err) {
      if (ticket !== request.current) return;
      setError(friendlyError(err).code === "NOT_FOUND"
        ? "Report unavailable"
        : "Couldn't load that report. Try again.");
    } finally {
      if (ticket === request.current) setLoading(false);
    }
  }

  return (
    <div role="group" aria-label="Attach a report" className="mt-1 border-t border-outline-variant py-2"
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
      }}>
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={inputId} className="text-xs font-medium text-on-surface">Report link</label>
        <button type="button" onClick={onClose} aria-label="Close report picker"
          className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full text-on-surface-variant hover:bg-surface-container focus-visible:outline-2 focus-visible:outline-on-surface">
          <X size={16} aria-hidden />
        </button>
      </div>
      <div className="flex min-w-0 flex-wrap gap-2">
        <input ref={inputRef} id={inputId} type="url" value={link} disabled={disabled || loading}
          placeholder="Paste a FindBack report link" autoComplete="off"
          onChange={(event) => { setLink(event.target.value); setError(null); }}
          onKeyDown={(event) => {
            if (event.key === "Enter") { event.preventDefault(); void addReport(); }
          }}
          className="min-h-[44px] min-w-0 flex-1 basis-40 rounded-m3-sm border border-outline-variant bg-surface px-3 text-sm text-on-surface focus-visible:outline-2 focus-visible:outline-on-surface" />
        <button type="button" onClick={() => void addReport()} disabled={disabled || loading || !link.trim()}
          className="min-h-[44px] rounded-full px-3 text-xs font-semibold text-on-surface hover:bg-surface-container disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-on-surface">
          Add report
        </button>
      </div>
      {loading && <p role="status" className="mt-1 text-xs text-on-surface-variant">Loading report…</p>}
      {error && <p role="alert" className="mt-1 text-xs text-error">{error}</p>}
    </div>
  );
}
