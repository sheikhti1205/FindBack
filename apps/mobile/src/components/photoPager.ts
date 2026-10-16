import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { shouldReduceMotion } from "./uiMotion";

/**
 * Shared continuous-paging behavior (C1 unification).
 *
 * The Home `FeedMediaCarousel` is canonical: a native horizontal scroll-snap
 * track gives one-finger continuous paging for free (finger-tracked motion,
 * snap settle, vertical page scroll untouched, short drags snap back). The
 * detail hero gallery and the photo lightbox (at fit zoom) page exactly the
 * same way through this hook — no touchEnd→index→fade image replacement on
 * spatial surfaces.
 *
 * Tap-vs-swipe stays separated everywhere: a press that moves beyond
 * {@link PAGER_TAP_MOVE_SLOP_PX} is a page gesture and never opens a viewer,
 * so swiping can never navigate or open.
 */

/** Movement beyond this many px between press and release is a swipe, not a tap. */
export const PAGER_TAP_MOVE_SLOP_PX = 8;

export interface SnapPager {
  trackRef: RefObject<HTMLDivElement | null>;
  /** Index of the snapped (visible) page. Survives ordinary rerenders. */
  active: number;
  /** Attach to the track's onScroll: derives `active` from scroll position. */
  onScroll: () => void;
  /** Programmatic page jump (dots, arrows, keyboard): smooth, instant under reduced motion. */
  goTo: (index: number) => void;
}

export function useSnapPager(count: number): SnapPager {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [active, setActive] = useState(0);

  // A shorter image list (edit/refetch) clamps the reader's place instead of
  // resetting it — ordinary rerenders leave it untouched.
  useEffect(() => {
    setActive((current) => (current >= count ? Math.max(0, count - 1) : current));
  }, [count]);

  const onScroll = useCallback(() => {
    const el = trackRef.current;
    if (!el) return;
    const width = el.clientWidth || 1;
    const next = Math.max(0, Math.min(count - 1, Math.round(el.scrollLeft / width)));
    setActive((current) => (current === next ? current : next));
  }, [count]);

  const goTo = useCallback(
    (index: number) => {
      const clamped = Math.max(0, Math.min(count - 1, index));
      setActive(clamped);
      const el = trackRef.current;
      if (!el) return;
      const width = el.clientWidth || el.offsetWidth || 0;
      const left = clamped * width;
      const behavior: ScrollBehavior = shouldReduceMotion() ? "auto" : "smooth";
      const target = el as HTMLElement & { scrollTo?: (opts: ScrollToOptions) => void };
      if (typeof target.scrollTo === "function") target.scrollTo({ left, behavior });
      else el.scrollLeft = left;
    },
    [count],
  );

  return { trackRef, active, onScroll, goTo };
}

export interface PagerTapEvent {
  clientX: number;
  clientY: number;
  /**
   * `MouseEvent.detail`: 0 when no pointer produced this click — i.e. a
   * keyboard activation (Enter/Space on a button).
   */
  detail?: number;
}

export interface PagerTap {
  /** Record a press origin (mouse down / touch start). */
  pressStart: (x: number, y: number) => void;
  /**
   * Consume the press for a click/release event: true when the pointer stayed
   * within slop (a real tap → open), false when it travelled (a swipe → page
   * only, never open). Always consumes, like the canonical carousel.
   */
  isTap: (event: PagerTapEvent) => boolean;
}

/** Tap-vs-swipe separation shared by every paging surface. */
export function usePagerTap(): PagerTap {
  const pressRef = useRef<{ x: number; y: number } | null>(null);

  const pressStart = useCallback((x: number, y: number) => {
    pressRef.current = { x, y };
  }, []);

  const isTap = useCallback((event: PagerTapEvent) => {
    const start = pressRef.current;
    pressRef.current = null;
    // A keyboard activation is never a swipe. Enter/Space on a slide button
    // fires a click with no pointer behind it (detail 0, coordinates at the
    // origin), so geometry cannot judge it — and a press left over from an
    // earlier gesture that never released a click would otherwise reject it
    // and make the viewer unreachable without a pointer.
    if (event.detail === 0 && event.clientX === 0 && event.clientY === 0) return true;
    if (start) {
      const dx = Math.abs(event.clientX - start.x);
      const dy = Math.abs(event.clientY - start.y);
      if (dx > PAGER_TAP_MOVE_SLOP_PX || dy > PAGER_TAP_MOVE_SLOP_PX) return false;
    }
    return true;
  }, []);

  return { pressStart, isTap };
}
