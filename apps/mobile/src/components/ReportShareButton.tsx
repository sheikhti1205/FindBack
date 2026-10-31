import { useEffect, useId, useRef, useState } from "react";
import { Copy, Share2 } from "lucide-react";
import { copyReportLink, shareReport } from "../utils/shareReport";
import { announce } from "./LiveRegion";
import { AdaptiveTaskSurface } from "./AdaptiveTaskSurface";
import { ActionMenu } from "./ActionMenu";

/**
 * The one share control: the system share sheet plus the copy action.
 *
 * One icon slot opens the shared anchored Share / Copy menu. React Aria owns
 * focus/keyboard/positioning; the overlay bridge consumes nested Back/Escape.
 *
 * HONESTY: a capability that is missing is never dressed up as a success.
 * The share path reports what actually happened (shared / dismissed / copied)
 * and the copy path falls back to a selectable field when the platform
 * exposes no working clipboard — it never claims a copy it did not make.
 */
export function ReportShareButton({ postId, title }: { postId: string; title: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualLink, setManualLink] = useState<string | null>(null);
  const fieldId = useId();
  const [open, setOpen] = useState(false);

  // Lifetime: an async share/copy may finish after this control has been
  // reused for another report or removed from the screen. Neither the
  // previous report's manual link nor its announcement may leak into the
  // current one. The epoch moves on both identity replacement and unmount.
  const epoch = useRef(0);
  const identity = useRef(postId);
  const mounted = useRef(true);
  if (identity.current !== postId) {
    identity.current = postId;
    epoch.current += 1;
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      epoch.current += 1;
    };
  }, []);

  useEffect(() => {
    setBusy(false);
    setError(null);
    setManualLink(null);
    setOpen(false);
  }, [postId]);

  function close() {
    setOpen(false);
  }

  async function onShare() {
    if (busy) return;
    const startedAt = epoch.current;
    const reportId = postId;
    const live = () => mounted.current && identity.current === reportId && epoch.current === startedAt;
    close();
    setBusy(true);
    setError(null);
    try {
      const message = await shareReport(reportId, title);
      if (!live()) return;
      announce(message);
    } catch {
      if (!live()) return;
      const message = "Couldn't share this report here. Use Copy link instead.";
      setError(message);
      setOpen(true);
      announce(message);
    } finally {
      if (live()) setBusy(false);
    }
  }

  async function onCopy() {
    if (busy) return;
    const startedAt = epoch.current;
    const reportId = postId;
    const live = () => mounted.current && identity.current === reportId && epoch.current === startedAt;
    close();
    setBusy(true);
    setError(null);
    try {
      const result = await copyReportLink(reportId);
      if (!live()) return;
      if (result.status === "copied") {
        setManualLink(null);
        announce("Link copied.");
      } else {
        // No working clipboard on this platform: show the link so the user
        // can copy it by hand instead of pretending it was copied.
        setManualLink(result.url);
        announce("Copying isn't available here. Tap the link and copy it.");
      }
    } catch {
      if (!live()) return;
      setError("Couldn't build the link for this report.");
      setOpen(true);
      announce("Couldn't build the link for this report.");
    } finally {
      if (live()) setBusy(false);
    }
  }

  return (
    <div className="relative shrink-0" onPointerDown={(event) => event.stopPropagation()}>
      <ActionMenu label="Share report" open={open} onOpenChange={setOpen} disabled={busy} triggerClassName="fb-report-action"
        feedback={error && <p role="alert" className="max-w-56 px-3 py-2 text-xs text-error">{error}</p>}
        icon={<><Share2 size={18} aria-hidden /><span>Share</span></>} items={[
          { id: "share", label: "Share report", icon: <Share2 size={18} aria-hidden />, onAction: () => { void onShare(); } },
          { id: "copy", label: "Copy link", icon: <Copy size={18} aria-hidden />, onAction: () => { void onCopy(); } },
        ]} />
      {manualLink && <AdaptiveTaskSurface open onClose={() => setManualLink(null)} title="Copy link">
        <div className="mt-1 flex min-w-0 flex-col gap-1">
          <label htmlFor={fieldId} className="text-xs text-on-surface-variant">
            Report link
          </label>
          <input
            id={fieldId}
            readOnly
            value={manualLink}
            onFocus={(event) => {
              try { event.currentTarget.select(); }
              catch { announce("Automatic selection isn't available. Press and hold the link to select it."); }
            }}
            className="min-h-[44px] w-full min-w-0 rounded-m3-sm border border-outline-variant bg-surface px-2 text-sm text-on-surface"
          />
          <p className="text-xs text-on-surface-variant">Select the link to copy it.</p>
        </div>
      </AdaptiveTaskSurface>}
    </div>
  );
}
