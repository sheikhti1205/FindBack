import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Scroll-reactive chrome (CF-010, packet 09 §3).
 *
 * The Home chrome (brand, count line, search field, filter chips) collapses
 * upward once the reader intentionally scrolls down the feed, so the feed gains
 * real vertical room, and comes back on the first intentional upward move. The
 * decision is a pure function of the feed's scroll offset, deliberately shaped
 * so a reader can never see it flicker:
 *
 * - **Hysteresis.** Hiding needs {@link CHROME_HIDE_TRAVEL} of downward travel;
 *   revealing needs only {@link CHROME_SHOW_TRAVEL}. The asymmetry is the point:
 *   a single reverse flick restores the chrome while a few pixels of rubber-band
 *   jitter cannot make it strobe.
 * - **Jitter filter.** Movement under {@link CHROME_JITTER} is not intent and
 *   never accumulates, so sub-pixel scroll noise (momentum tails, a trackpad's
 *   residual motion) leaves the state alone.
 * - **Jumps are not swipes.** A single delta of {@link CHROME_JUMP} or more is a
 *   programmatic move — a restored scroll offset after Post Detail, an anchor,
 *   a jump — and only re-bases the tracker. Chrome state survives it, so a
 *   reader who returns to a deep offset still sees the chrome.
 * - **Top zone.** At or above {@link CHROME_TOP_ZONE} the chrome is always fully
 *   visible, whatever the travel history.
 * - **Pinned.** While a control the reader is actively using is open or focused
 *   (search field, filter sheet, Nearby sheet, map picker) the chrome stays
 *   visible: the packet requires that active controls are never hidden.
 */

/** At or above this offset the chrome is always fully visible. */
export const CHROME_TOP_ZONE = 24;
/** The chrome cannot hide until the feed is this far down, so short lists and
 * a nudge of the wheel never move the chrome. */
export const CHROME_HIDE_AFTER = 56;
/** Downward travel that must accumulate before the chrome hides. */
export const CHROME_HIDE_TRAVEL = 24;
/** Upward travel that must accumulate before the chrome returns. Smaller than
 * the hide travel on purpose — that asymmetry is the hysteresis. */
export const CHROME_SHOW_TRAVEL = 12;
/** Movement smaller than this is jitter, not intent. */
export const CHROME_JITTER = 3;
/** A single delta this large is a programmatic jump, never a swipe. */
export const CHROME_JUMP = 320;

export interface ScrollChromeState {
  /** Whether the chrome is collapsed right now. */
  hidden: boolean;
  /** The offset the last decision was taken against. */
  lastY: number;
  /** Signed travel accumulated in the current direction since that decision. */
  travel: number;
}

export function initialScrollChrome(): ScrollChromeState {
  return { hidden: false, lastY: 0, travel: 0 };
}

/**
 * The next chrome state for a scroll offset. Pure: no DOM, no timers, so the
 * hysteresis is testable without a browser.
 */
export function nextScrollChrome(
  state: ScrollChromeState,
  scrollTop: number,
  pinned = false,
): ScrollChromeState {
  const y = Number.isFinite(scrollTop) ? Math.max(0, scrollTop) : state.lastY;
  if (pinned) return { hidden: false, lastY: y, travel: 0 };
  if (y <= CHROME_TOP_ZONE) return { hidden: false, lastY: y, travel: 0 };

  const delta = y - state.lastY;
  if (Math.abs(delta) >= CHROME_JUMP) return { hidden: state.hidden, lastY: y, travel: 0 };
  if (Math.abs(delta) < CHROME_JITTER) return { ...state, lastY: y };

  // Same direction as the travel already accumulated, or a fresh direction.
  const travel = state.travel * delta > 0 ? state.travel + delta : delta;
  if (travel >= CHROME_HIDE_TRAVEL && y > CHROME_HIDE_AFTER) {
    return { hidden: true, lastY: y, travel: 0 };
  }
  if (-travel >= CHROME_SHOW_TRAVEL) return { hidden: false, lastY: y, travel: 0 };
  return { hidden: state.hidden, lastY: y, travel };
}

export interface ScrollChrome {
  /** Whether the chrome should be collapsed. */
  hidden: boolean;
  /** Feed this every scroll event of the feed scroller. */
  onScroll: (scrollTop: number) => void;
}

/**
 * Tracks the chrome state across scroll events. `pinned` is the caller's
 * "a control is active, never hide" signal; when it turns true the chrome is
 * revealed immediately (a reader who opens search expects to see it) and it is
 * restored the next time the caller reads `hidden`.
 *
 * Only the hiding boolean is React state, so a scroll cannot rerender the feed
 * per pixel.
 */
export function useScrollChrome(pinned: boolean): ScrollChrome {
  const stateRef = useRef<ScrollChromeState>(initialScrollChrome());
  const pinnedRef = useRef(pinned);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    pinnedRef.current = pinned;
    if (!pinned) return;
    stateRef.current = { hidden: false, lastY: stateRef.current.lastY, travel: 0 };
    setHidden(false);
  }, [pinned]);

  const onScroll = useCallback((scrollTop: number) => {
    const next = nextScrollChrome(stateRef.current, scrollTop, pinnedRef.current);
    stateRef.current = next;
    setHidden((prev) => (prev === next.hidden ? prev : next.hidden));
  }, []);

  return { hidden, onScroll };
}
