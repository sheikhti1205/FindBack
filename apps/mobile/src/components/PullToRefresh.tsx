import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { friendlyError } from "../utils/friendlyErrors";

interface PullToRefreshProps {
  onRefresh: () => Promise<void>;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}

export interface PullToRefreshHandle {
  scrollToTop: (behavior?: ScrollBehavior) => void;
  scrollTop: number;
}

/** Gesture direction, decided from the first *decisive* move (not the first jitter). */
type PullDirection = "none" | "vertical" | "horizontal";

/**
 * Touch-based pull-to-refresh at scrollTop 0 only.
 *
 * Refresh contract (C4):
 * - only at real scrollTop 0
 * - resistance (pull distance is dampened)
 * - threshold before refresh triggers
 * - the pull reveals ONLY a compact pill/circular refresh glyph that
 *   animates with progress (rotation tracks the finger, the pill scales in).
 *   No text states for sighted users — position is exposed through the
 *   status role's accessible name and a visually-hidden label only.
 * - the list stays visually in place: the indicator floats in a zero-height
 *   sticky slot, so there is no yank, no push-down, and no blank flash
 * - the spinner persists on the pill for the whole request
 * - below-threshold cancel snaps back (pill unmounts)
 * - exactly ONE refresh per release: a release is consumed once per gesture,
 *   an in-flight refresh is guarded synchronously (no stale-closure double
 *   fire), and `disabled` is honoured at release so a gesture can never stack
 *   a second refresh on top of one that is already running
 * - children stay mounted for the whole refresh — items are never cleared
 * - a rejected refresh keeps those children and surfaces an honest error/retry
 *   state instead of failing silently
 * - a nested horizontal scroller (category rail, map pan) never triggers the
 *   vertical refresh: direction is locked only once a move is decisive, and a
 *   horizontal-dominant move cancels the pull outright
 * - a cancelled gesture leaves no stale pull distance behind
 * - P6: the finger-tracked visual is NEVER React state. Touch moves write a
 *   ref and paint the pill through one rAF callback; React commits only
 *   at gesture start (pill mount), release (unmount/refresh) and
 *   refresh settle. No setState — and no layout-height animation — runs per
 *   touch move.
 * - reduced motion: the refresh spinner resolves to a static glyph
 *   (`motion-reduce:animate-none`); finger-tracked progress is functional
 *   tracking and is never disabled.
 *
 * The component IS the scroll container; the parent can read scrollTop and
 * scroll to top through the forwarded handle.
 */
export const PullToRefresh = forwardRef<PullToRefreshHandle, PullToRefreshProps>(
  function PullToRefresh({ onRefresh, disabled, className, children }, ref) {
    const [pulling, setPulling] = useState(false);
    const [refreshing, setRefreshing] = useState(false);
    const [refreshError, setRefreshError] = useState<string | null>(null);
    const touchRef = useRef({
      startY: 0,
      startX: 0,
      direction: "none" as PullDirection,
      active: false,
    });
    const scrollRef = useRef<HTMLDivElement>(null);
    // Synchronous guards: React state can lag behind a second delivery of the
    // same release, so the decision must not depend on a re-render.
    const refreshingRef = useRef(false);
    const releaseConsumedRef = useRef(false);
    // P6: finger-tracked visual state. Never in React state — painted by rAF.
    const pullRef = useRef(0);
    const rafRef = useRef<number | null>(null);
    const pillRef = useRef<HTMLSpanElement | null>(null);
    const labelRef = useRef<HTMLDivElement | null>(null);
    const labelTextRef = useRef<HTMLSpanElement | null>(null);
    const iconRef = useRef<SVGSVGElement | null>(null);

    const THRESHOLD = 64;
    const MAX_PULL = 100;
    const RESISTANCE = 0.45;

    useImperativeHandle(ref, () => ({
      scrollToTop: (behavior: ScrollBehavior = "smooth") => {
        scrollRef.current?.scrollTo({ top: 0, behavior });
      },
      get scrollTop() {
        return scrollRef.current?.scrollTop ?? 0;
      },
      set scrollTop(value: number) {
        if (scrollRef.current) scrollRef.current.scrollTop = value;
      },
    }));

    const cancelPaint = useCallback(() => {
      if (rafRef.current !== null) {
        if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    }, []);

    // P6: the ONLY visual writer for the refresh pill. Reads refs, mutates
    // the mounted pill DOM directly, commits nothing to React. The pill
    // floats in a zero-height slot: painting here never moves the list.
    const paintVisual = useCallback(() => {
      rafRef.current = null;
      const pill = pillRef.current;
      if (!pill) return;
      const active = refreshingRef.current;
      const distance = active ? THRESHOLD : pullRef.current;
      const progress = active ? 1 : Math.min(distance / THRESHOLD, 1);
      pill.style.opacity = progress <= 0 && !active ? "0" : "1";
      pill.style.transform = `translate(-50%, 0) scale(${active ? 1 : 0.6 + 0.4 * progress})`;
      const label = active ? "Refreshing" : distance >= THRESHOLD ? "Release to refresh" : "Pull to refresh";
      labelRef.current?.setAttribute("aria-label", label);
      if (labelTextRef.current) labelTextRef.current.textContent = label;
      // Rotation tracks pull distance one-to-one (transform only, rAF-throttled).
      if (iconRef.current) iconRef.current.style.transform = `rotate(${progress * 360}deg)`;
    }, []);

    const schedulePaint = useCallback(() => {
      if (rafRef.current !== null) return;
      if (typeof requestAnimationFrame === "function") {
        rafRef.current = requestAnimationFrame(paintVisual);
      } else {
        paintVisual();
      }
    }, [paintVisual]);

    useEffect(() => cancelPaint, [cancelPaint]);

    const runRefresh = useCallback(async () => {
      if (refreshingRef.current) return;
      refreshingRef.current = true;
      setRefreshError(null);
      setRefreshing(true);
      pullRef.current = THRESHOLD;
      schedulePaint();
      try {
        await onRefresh();
      } catch (err) {
        // Keep the previous items and say what happened — never pretend the
        // refresh succeeded.
        setRefreshError(friendlyError(err).message);
      } finally {
        refreshingRef.current = false;
        cancelPaint();
        pullRef.current = 0;
        setRefreshing(false);
        setPulling(false);
      }
    }, [onRefresh, cancelPaint, schedulePaint]);

    const handleTouchStart = useCallback(
      (e: React.TouchEvent) => {
        // Every gesture starts a fresh release decision.
        releaseConsumedRef.current = false;
        if (disabled || refreshing) return;
        const el = scrollRef.current;
        if (el && el.scrollTop > 0) return;
        const t = e.touches[0]!;
        touchRef.current = { startY: t.clientY, startX: t.clientX, direction: "none", active: true };
        // No pull distance may leak in from an earlier (e.g. cancelled) gesture.
        pullRef.current = 0;
      },
      [disabled, refreshing],
    );

    const handleTouchMove = useCallback((e: React.TouchEvent) => {
      const t = touchRef.current;
      if (!t.active) return;
      const touch = e.touches[0]!;
      const dy = touch.clientY - t.startY;
      const dx = touch.clientX - t.startX;
      const absDx = Math.abs(dx);
      const absDy = Math.abs(dy);

      if (t.direction === "none") {
        if (absDx > absDy && absDx > 10) {
          // Horizontal-dominant from here on (nested category rail, map pan):
          // this is never a vertical pull, whatever the opener looked like.
          t.active = false;
          t.direction = "horizontal";
          pullRef.current = 0;
          return;
        }
        if (absDy > absDx && absDy > 10) {
          t.direction = "vertical";
          // Gesture start: the single React commit of the whole pull.
          // Everything after this is ref + rAF paint, never setState.
          setPulling(true);
        } else {
          // Ambiguous jitter: wait for a decisive move instead of guessing.
          return;
        }
      }
      if (t.direction !== "vertical") return;

      if (dy <= 0) {
        pullRef.current = 0;
        schedulePaint();
        return;
      }

      const dampened = Math.min(dy * RESISTANCE, MAX_PULL);
      pullRef.current = dampened;
      schedulePaint();

      // Prevent scroll while pulling down
      if (dampened > 0) e.preventDefault();
    }, [schedulePaint]);

    const handleTouchEnd = useCallback(() => {
      // One release = one decision, even if the browser delivers it twice
      // (second finger lifting, gesture + settle).
      if (releaseConsumedRef.current) return;
      releaseConsumedRef.current = true;
      const t = touchRef.current;
      t.active = false;
      t.direction = "none";

      if (disabled || refreshingRef.current) {
        // A refresh is already running (the parent disables the control for
        // exactly that reason): snap back, never stack a second one. Keep our
        // own indicator up while our refresh is still in flight.
        if (!refreshingRef.current) {
          cancelPaint();
          pullRef.current = 0;
          setPulling(false);
        }
        return;
      }

      // Release: the single state transition of the gesture end. The release
      // decision reads the ref — never a lagging state closure.
      cancelPaint();
      if (pullRef.current >= THRESHOLD) {
        void runRefresh();
      } else {
        pullRef.current = 0;
        setPulling(false);
      }
    }, [disabled, runRefresh, cancelPaint]);

    const handleTouchCancel = useCallback(() => {
      const t = touchRef.current;
      t.active = false;
      t.direction = "none";
      // The browser took the gesture over: it must not count as a release.
      releaseConsumedRef.current = true;
      cancelPaint();
      pullRef.current = 0;
      if (!refreshingRef.current) setPulling(false);
    }, [cancelPaint]);

    const handleRetry = useCallback(() => {
      if (disabled) return;
      void runRefresh();
    }, [disabled, runRefresh]);

    // P6: the pill mounts once per gesture (and for the whole refresh) and
    // unmounts at release/settle; its opacity/scale/rotation are painted by
    // rAF (see paintVisual), never by React state. The slot is zero-height
    // and sticky, so the list never shifts while the pill is visible.
    const showIndicator = pulling || refreshing;

    return (
      <div
        ref={scrollRef}
        className={`relative flex flex-col overflow-y-auto ${className ?? ""}`}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchCancel}
      >
        {showIndicator && (
          <div
            ref={labelRef}
            data-testid="refresh-pill-slot"
            className="pointer-events-none sticky top-2 z-10 flex h-0 justify-center overflow-visible"
            aria-live="polite"
            role="status"
            aria-label={refreshing ? "Refreshing" : "Pull to refresh"}
          >
            <span
              ref={pillRef}
              data-testid="refresh-pill"
              className="absolute left-1/2 inline-flex h-9 w-9 items-center justify-center rounded-full bg-surface-container-high text-on-surface shadow"
              style={{ opacity: 0, transform: "translate(-50%, 0) scale(0.6)" }}
            >
              <svg
                ref={iconRef}
                className={`h-4 w-4 ${refreshing ? "animate-spin motion-reduce:animate-none" : ""}`}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                aria-hidden
              >
                <path d="M21 12a9 9 0 11-6.219-8.56" />
              </svg>
              <span ref={labelTextRef} className="sr-only">{refreshing ? "Refreshing" : "Pull to refresh"}</span>
            </span>
          </div>
        )}
        {refreshError && !refreshing && (
          <div
            role="alert"
            className="flex items-center justify-between gap-2 border-b border-error px-4 py-2 text-sm text-error"
          >
            <span>{refreshError}</span>
            <button
              type="button"
              onClick={handleRetry}
              className="min-h-[48px] shrink-0 px-3 font-medium underline"
            >
              Retry
            </button>
          </div>
        )}
        {children}
      </div>
    );
  },
);
