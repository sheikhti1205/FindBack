import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
} from "react";

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

/**
 * Touch-based pull-to-refresh at scrollTop 0 only.
 *
 * Requirements:
 * - only at real scrollTop 0
 * - resistance (pull distance is dampened)
 * - threshold before refresh triggers
 * - visual indicator
 * - below-threshold cancel snaps back
 * - no duplicate refresh
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
    const touchRef = useRef({ startY: 0, startX: 0, locked: false, active: false });
    const scrollRef = useRef<HTMLDivElement>(null);

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
    }));

    const handleTouchStart = useCallback(
      (e: React.TouchEvent) => {
        if (disabled || refreshing) return;
        const el = scrollRef.current;
        if (el && el.scrollTop > 0) return;
        const t = e.touches[0]!;
        touchRef.current = { startY: t.clientY, startX: t.clientX, locked: false, active: true };
      },
      [disabled, refreshing],
    );

    const handleTouchMove = useCallback(
      (e: React.TouchEvent) => {
        const t = touchRef.current;
        if (!t.active) return;
        const touch = e.touches[0]!;
        const dy = touch.clientY - t.startY;
        const dx = touch.clientX - t.startX;

        // Lock out horizontal swipe (map gestures etc.)
        if (!t.locked && (Math.abs(dx) > 10 || Math.abs(dy) < 10)) {
          if (Math.abs(dx) > Math.abs(dy)) {
            t.active = false;
            setPullDistance(0);
            return;
          }
          t.locked = true;
        }

        if (dy <= 0) {
          setPullDistance(0);
          return;
        }

        const dampened = Math.min(dy * RESISTANCE, MAX_PULL);
        setPullDistance(dampened);

        // Prevent scroll while pulling down
        if (dampened > 0) e.preventDefault();
      },
      [],
    );

    const handleTouchEnd = useCallback(async () => {
      const t = touchRef.current;
      t.active = false;
      t.locked = false;

      if (pullDistance >= THRESHOLD && !refreshing) {
        setRefreshing(true);
        setPullDistance(THRESHOLD);
        try {
          await onRefresh();
        } finally {
          setRefreshing(false);
          setPullDistance(0);
        }
      } else {
        setPullDistance(0);
      }
    }, [pullDistance, refreshing, onRefresh]);

    const showIndicator = pullDistance > 0 || refreshing;
    const progress = refreshing ? 1 : Math.min(pullDistance / THRESHOLD, 1);

    return (
      <div
        ref={scrollRef}
        className={`relative flex flex-col overflow-y-auto ${className ?? ""}`}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
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
        {children}
      </div>
    );
  },
);