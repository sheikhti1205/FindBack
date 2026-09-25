import {
  forwardRef,
  useCallback,
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
 * Requirements:
 * - only at real scrollTop 0
 * - resistance (pull distance is dampened)
 * - threshold before refresh triggers
 * - visual indicator
 * - below-threshold cancel snaps back
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
 * - no map gesture conflict (horizontal swipe locks out)
 * - respects prefers-reduced-motion
 *
 * The component IS the scroll container; the parent can read scrollTop and
 * scroll to top through the forwarded handle.
 */
export const PullToRefresh = forwardRef<PullToRefreshHandle, PullToRefreshProps>(
  function PullToRefresh({ onRefresh, disabled, className, children }, ref) {
    const [pullDistance, setPullDistance] = useState(0);
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

    const THRESHOLD = 64;
    const MAX_PULL = 100;
    const RESISTANCE = 0.45;

    const reducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    useImperativeHandle(ref, () => ({
      scrollToTop: (behavior: ScrollBehavior = reducedMotion ? "auto" : "smooth") => {
        scrollRef.current?.scrollTo({ top: 0, behavior });
      },
      get scrollTop() {
        return scrollRef.current?.scrollTop ?? 0;
      },
      set scrollTop(value: number) {
        if (scrollRef.current) scrollRef.current.scrollTop = value;
      },
    }));

    const runRefresh = useCallback(async () => {
      if (refreshingRef.current) return;
      refreshingRef.current = true;
      setRefreshError(null);
      setRefreshing(true);
      setPullDistance(THRESHOLD);
      try {
        await onRefresh();
      } catch (err) {
        // Keep the previous items and say what happened — never pretend the
        // refresh succeeded.
        setRefreshError(friendlyError(err).message);
      } finally {
        refreshingRef.current = false;
        setRefreshing(false);
        setPullDistance(0);
      }
    }, [onRefresh]);

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
        setPullDistance(0);
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
          setPullDistance(0);
          return;
        }
        if (absDy > absDx && absDy > 10) {
          t.direction = "vertical";
        } else {
          // Ambiguous jitter: wait for a decisive move instead of guessing.
          return;
        }
      }
      if (t.direction !== "vertical") return;

      if (dy <= 0) {
        setPullDistance(0);
        return;
      }

      const dampened = Math.min(dy * RESISTANCE, MAX_PULL);
      setPullDistance(dampened);

      // Prevent scroll while pulling down
      if (dampened > 0) e.preventDefault();
    }, []);

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
        if (!refreshingRef.current) setPullDistance(0);
        return;
      }

      if (pullDistance >= THRESHOLD) {
        void runRefresh();
      } else {
        setPullDistance(0);
      }
    }, [disabled, pullDistance, runRefresh]);

    const handleTouchCancel = useCallback(() => {
      const t = touchRef.current;
      t.active = false;
      t.direction = "none";
      // The browser took the gesture over: it must not count as a release.
      releaseConsumedRef.current = true;
      if (!refreshingRef.current) setPullDistance(0);
    }, []);

    const handleRetry = useCallback(() => {
      if (disabled) return;
      void runRefresh();
    }, [disabled, runRefresh]);

    const showIndicator = pullDistance > 0 || refreshing;
    const progress = refreshing ? 1 : Math.min(pullDistance / THRESHOLD, 1);

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
            className="flex items-center justify-center overflow-hidden transition-[height]"
            style={{
              // Reduced motion removes the animated expansion, not the
              // indicator itself: the user must still see pull/release/refresh.
              height: pullDistance,
              transitionDuration: reducedMotion ? "0ms" : "200ms",
            }}
            aria-live="polite"
            role="status"
          >
            <span
              className="inline-flex items-center gap-1.5 text-xs text-on-surface-variant"
              aria-label={
                refreshing
                  ? "Refreshing feed"
                  : pullDistance >= THRESHOLD
                    ? "Release to refresh"
                    : "Pull to refresh"
              }
            >
              <svg
                className={`h-4 w-4 ${refreshing && !reducedMotion ? "animate-spin" : ""}`}
                style={reducedMotion ? undefined : { transform: `rotate(${progress * 360}deg)` }}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                aria-hidden
              >
                <path d="M21 12a9 9 0 11-6.219-8.56" />
              </svg>
              {refreshing
                ? "Refreshing…"
                : pullDistance >= THRESHOLD
                  ? "Release to refresh"
                  : "Pull to refresh"}
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
