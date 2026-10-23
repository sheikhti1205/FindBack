import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Copy, Share2 } from "lucide-react";
import { copyReportLink, shareReport } from "../utils/shareReport";
import { announce } from "./LiveRegion";
import { BottomSheet } from "./BottomSheet";

/**
 * The one share control: the system share sheet plus the copy action.
 *
 * One icon slot opens an explicit Share / Copy menu. Menu keyboard handling
 * follows OwnerReportMenu: arrows/Home/End, Escape return, Tab leaves freely.
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
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const lastItem = useRef(false);

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
    triggerRef.current?.focus();
  }

  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current?.getBoundingClientRect();
    const menu = menuRef.current?.getBoundingClientRect();
    if (!trigger || !menu) return;
    const left = Math.max(8, Math.min(trigger.left, window.innerWidth - menu.width - 8));
    const below = trigger.bottom + 4;
    const top = Math.max(8, Math.min(
      below + menu.height <= window.innerHeight - 8 ? below : trigger.top - menu.height - 4,
      window.innerHeight - menu.height - 8,
    ));
    setPosition({ left, top });
    const items = menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    items?.[lastItem.current ? items.length - 1 : 0]?.focus();
  }, [open, error]);

  useEffect(() => {
    if (!open) return;
    const dismiss = () => setOpen(false);
    const outside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node) && !triggerRef.current?.contains(event.target as Node)) dismiss();
    };
    const scroll = (event: Event) => { if (!menuRef.current?.contains(event.target as Node)) dismiss(); };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", dismiss);
    document.addEventListener("scroll", scroll, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", dismiss);
      document.removeEventListener("scroll", scroll, true);
    };
  }, [open]);

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" || event.key === "Tab") {
      // Escape belongs to this menu, not an enclosing modal. Tab is not trapped:
      // restore the anchor so the browser can advance to the next row action.
      if (event.key === "Escape") event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    if (!items.length) return;
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 :
      (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
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
    <div className="relative shrink-0" onPointerDown={(event) => event.stopPropagation()}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false); }}>
        <button
          type="button"
          aria-label="Share report"
          ref={triggerRef}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          aria-busy={busy}
          aria-disabled={busy}
          className="fb-report-action"
          onClick={() => { if (!busy) { lastItem.current = false; setOpen((value) => !value); } }}
          onKeyDown={(event) => {
            if (!busy && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
              event.preventDefault();
              lastItem.current = event.key === "ArrowUp";
              setOpen(true);
            }
          }}
        >
          <Share2 size={18} aria-hidden /><span>Share</span>
        </button>
      {open ? <div id={menuId} role="menu" aria-label="Share options" ref={menuRef}
        onKeyDown={onMenuKeyDown}
        style={{ ...position, width: "min(14rem, calc(100vw - 16px))", maxHeight: "calc(100dvh - 16px)" }}
        className="fixed z-50 overflow-y-auto rounded-m3-md border border-outline-variant bg-surface p-1 shadow-lg">
        {error ? <p role="alert" className="px-3 py-1 text-xs text-error">{error}</p> : null}
        <button type="button" role="menuitem" onClick={() => void onShare()}
          className="flex min-h-[44px] w-full items-center gap-2 rounded-m3-sm px-3 py-2 text-left text-sm text-on-surface">
          <Share2 size={18} className="shrink-0" aria-hidden />Share report
        </button>
        <button type="button" role="menuitem" onClick={() => void onCopy()}
          className="flex min-h-[44px] w-full items-center gap-2 rounded-m3-sm px-3 py-2 text-left text-sm text-on-surface">
          <Copy size={18} className="shrink-0" aria-hidden />Copy link
        </button>
      </div> : null}
      {manualLink && typeof document !== "undefined" ? createPortal(
        <BottomSheet open onClose={() => setManualLink(null)} title="Copy link" height="large">
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
        </BottomSheet>, document.body,
      ) : null}
    </div>
  );
}
