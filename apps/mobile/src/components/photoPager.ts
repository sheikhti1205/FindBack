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

/**
 * Keys that move a focused scroll container. A keyboard (or assistive
 * technology driving the same path) scroll is a person choosing a position, so
 * it releases an in-flight programmatic jump exactly like a pointer gesture.
 */
const PAGER_SCROLL_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " ",
]);

/**
 * Arrival tolerance for a programmatic jump. A native smooth scroll stops on
 * the page boundary; one pixel of slack absorbs fractional layout widths
 * without letting a genuinely different page count as arrived.
 */
const PAGER_NAV_ARRIVE_PX = 1;

export interface SnapPager {
  trackRef: RefObject<HTMLDivElement | null>;
  /** Index of the snapped (visible) page. Survives ordinary rerenders. */
  active: number;
  /** Attach to the track's onScroll: derives `active` from scroll position. */
  onScroll: () => void;
  /** Programmatic page jump (dots, arrows, keyboard): smooth, instant under reduced motion. */
  goTo: (index: number) => void;
  /**
   * Abandon an in-flight programmatic jump because the person took the track.
   * Attach to the track's pointer-down, touch-start and wheel: a real gesture
   * always outranks the dot/arrow animation, and a jump the person interrupted
   * must never keep the action row bound to a page that is no longer coming.
   */
  cancelJump: () => void;
}

export function useSnapPager(count: number): SnapPager {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [active, setActive] = useState(0);

  // A programmatic jump owns the logical page until the track arrives. Smooth
  // scrolling reports every intermediate position; those frames are animation,
  // not selection, and must never rebind `active` — and with it the action row,
  // which always acts on the active photo — to a different photo under a fast
  // dot/arrow → action tap (CF-020 rapid dot → Move).
  //
  // The armed value is the PIXEL target the browser is actually animating to,
  // captured with the width used to compute it. Comparing against a freshly
  // measured width would mean the guard can never be satisfied after a resize
  // (rotation, keyboard) and would latch the action row onto a photo that is no
  // longer on screen.
  const jumpRef = useRef<{ left: number; width: number } | null>(null);

  /**
   * Native releases that are not pointer gestures: a keyboard/AT scroll on the
   * focused track, and the browser's own `scrollend`. Both mean "the track has
   * stopped somewhere"; if that somewhere is not the armed pixel target, the
   * jump lost and the position decides. `scrollend` is the only event that
   * distinguishes a *stopped* scroll from an intermediate animation frame
   * without a timer, and a keydown precedes every keyboard-driven scroll.
   */
  const listenersRef = useRef<{ el: HTMLDivElement; cleanup: () => void } | null>(null);

  const ensureListeners = useCallback(() => {
    const el = trackRef.current;
    if (!el || listenersRef.current?.el === el) return;
    listenersRef.current?.cleanup();

    const release = () => {
      jumpRef.current = null;
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (PAGER_SCROLL_KEYS.has(event.key)) release();
    };

    const onScrollEnd = () => {
      const jump = jumpRef.current;
      if (!jump) return;
      const measured = el.clientWidth || el.offsetWidth || 0;
      jumpRef.current = null;
      if (measured <= 0) return;
      if (Math.abs(el.scrollLeft - jump.left) <= PAGER_NAV_ARRIVE_PX) return;
      // Stopped short of (or past) the armed page: this was not our animation,
      // so report the page the track actually landed on immediately.
      const next = Math.max(0, Math.min(count - 1, Math.round(el.scrollLeft / measured)));
      setActive((current) => (current === next ? current : next));
    };

    el.addEventListener("keydown", onKeyDown);
    el.addEventListener("scrollend", onScrollEnd);
    listenersRef.current = {
      el,
      cleanup: () => {
        el.removeEventListener("keydown", onKeyDown);
        el.removeEventListener("scrollend", onScrollEnd);
      },
    };
  }, [count]);

  useEffect(() => {
    ensureListeners();
    return () => {
      listenersRef.current?.cleanup();
      listenersRef.current = null;
    };
  }, [ensureListeners]);

  // A shorter image list (edit/refetch) clamps the reader's place instead of
  // resetting it — ordinary rerenders leave it untouched. A pending jump is
  // abandoned with it: its target page may no longer exist.
  useEffect(() => {
    jumpRef.current = null;
    setActive((current) => (current >= count ? Math.max(0, count - 1) : current));
  }, [count]);

  const onScroll = useCallback(() => {
    const el = trackRef.current;
    if (!el) return;
    const measured = el.clientWidth || el.offsetWidth || 0;
    if (measured <= 0) {
      // Nothing is laid out to select, and a jump cannot be measured either.
      // Holding the guard here would swallow the first frame after the track
      // becomes visible again (a hidden panel, a tab switch, display:none).
      jumpRef.current = null;
      return;
    }
    const jump = jumpRef.current;
    if (jump && measured !== jump.width) {
      // The layout changed under an in-flight jump, so its pixel target is stale
      // and the browser's own snap decides which page is really shown. Report
      // that page instead of holding a selection the track is not going to reach.
      jumpRef.current = null;
    } else if (jump) {
      if (Math.abs(el.scrollLeft - jump.left) > PAGER_NAV_ARRIVE_PX) return;
      jumpRef.current = null;
    }
    const next = Math.max(0, Math.min(count - 1, Math.round(el.scrollLeft / measured)));
    setActive((current) => (current === next ? current : next));
  }, [count]);

  const goTo = useCallback(
    (index: number) => {
      const clamped = Math.max(0, Math.min(count - 1, index));
      setActive(clamped);
      const el = trackRef.current;
      if (!el) return;
      ensureListeners();
      const width = el.clientWidth || el.offsetWidth || 0;
      const left = clamped * width;
      // A jump that does not travel must guard nothing: asking for the page
      // already shown would otherwise swallow the next scroll-derived change.
      jumpRef.current =
        Math.abs(el.scrollLeft - left) > PAGER_NAV_ARRIVE_PX ? { left, width } : null;
      const behavior: ScrollBehavior = shouldReduceMotion() ? "auto" : "smooth";
      const target = el as HTMLElement & { scrollTo?: (opts: ScrollToOptions) => void };
      if (typeof target.scrollTo === "function") target.scrollTo({ left, behavior });
      else el.scrollLeft = left;
    },
    [count],
  );

  const cancelJump = useCallback(() => {
    jumpRef.current = null;
  }, []);

  return { trackRef, active, onScroll, goTo, cancelJump };
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
