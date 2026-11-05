import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Scroll-reactive chrome (CF-010, packet 09 §3).
 *
 * The Home chrome (brand, count line, search field, filter chips) collapses
 * upward once the reader intentionally scrolls down the feed, so the feed gains
 * real vertical room, and comes back on the first intentional upward move. The
 * decision is a pure function of the feed's scroll offset, deliberately shaped
 * so a finger wobble cannot make it flutter. A symmetric oscillation at the
 * feed's middle below the bar's own hide travel (24px) moves the bar not at all
 * and the wordmark at most once. Beyond that, **no single sentence describes
 * which shapes move the wordmark alone with the bar steady** — five attempts at
 * one have been falsified by measurement — so the honest form is this machine's
 * own gate order, which is the specification and what a reader should reason
 * from:
 *
 * 1. `pinned` returns early leaving **both stages false** — the packet requires
 *    that an active control is never hidden;
 * 2. a **layout clamp** — the offset fell by the same distance the scrollable
 *    range shrank — keeps both stages and re-bases the travel to zero. This gate
 *    is deliberately **before** the top zone: collapsing the chrome gives its
 *    height back to the feed, so on a short feed the browser pulls the offset all
 *    the way to the top. That pull is the layout moving the offset, not the
 *    reader swiping up, and reading it as intent revealed the chrome, re-grew the
 *    range, and hid it again. A real upward swipe moves the offset while the range
 *    stays put, so it is never mistaken for a clamp;
 * 3. `y <= {@link CHROME_TOP_ZONE}` returns early leaving **both stages false** —
 *    the top-zone return is why a bounce at the very top brings the wordmark back
 *    with no up-travel at all;
 * 4. `|delta| >= {@link CHROME_JUMP}` keeps the state and re-bases the travel to
 *    zero, so a jump evaluates neither stage;
 * 5. `|delta| < {@link CHROME_JITTER}` keeps the state **and the travel**, so a
 *    1–2px nudge can carry banked travel past a threshold with neither stage
 *    evaluated at all;
 * 6. otherwise the travel accumulates — added to while the direction holds, and
 *    **replaced** by the fresh delta when the direction reverses
 *    (`state.travel * delta > 0 ? state.travel + delta : delta`) — and the two
 *    stages read it: the wordmark
 *    collapses at {@link WORD_COLLAPSE_TRAVEL} and comes back at
 *    {@link WORD_RESTORE_TRAVEL}; the bar hides at {@link CHROME_HIDE_TRAVEL}
 *    **and** `y > {@link CHROME_HIDE_AFTER}`, and returns at
 *    {@link CHROME_SHOW_TRAVEL}. A **bar** stage that transitions — a change of
 *    the `hidden` flag — re-bases the accumulator, and a decision that leaves
 *    `hidden` alone keeps it: the hide keeps the travel it already held while the
 *    chrome was hidden, and the show re-bases on the way out. The wordmark's
 *    branch never re-bases anything; it reads the travel the bar's branches leave.
 *    That discipline is not a detail: a threshold placed above a branch that
 *    zeroes the accumulator is unreachable by construction, which was the
 *    independent review's BLOCKER-1 (`WORD_RESTORE_TRAVEL` was 20 and never
 *    fired).
 *
 * The input is normalised before any gate: `scrollTop` is clamped to `>= 0` and a
 * non-finite value keeps `lastY`, so a rubber-band overscroll lands in gate 1 and
 * brings both stages back.
 *
 * So the wordmark alternates while the bar does not whenever it gets a collapse
 * and a restore — or a gate-1 reset (the top zone, or `pinned`) — while the bar's
 * hide never evaluates true. The measured shapes are listed in the wave's evidence as **instances,
 * not as a complete list**: the gate order above is the specification, and the
 * list is evidence. On Android the feed scroller is `overscroll-y-contain`, so
 * whether a finger can produce every listed shape is a device question, carried
 * to the acceptance pass:
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
 * - **Clamps are not swipes.** Collapsing the chrome returns its height to the
 *   feed, so the scrollable range shrinks by that height. At the bottom the
 *   browser pulls `scrollTop` down to the new maximum, and that pull is an
 *   upward delta. Treating it as intent showed the chrome, which re-grew the
 *   range, and the next downward pixel collapsed it again: the bottom-of-feed
 *   flicker. When the offset falls by the same distance the range shrank, the
 *   layout moved the offset, so the tracker only re-bases.
 * - **Top zone.** At or above {@link CHROME_TOP_ZONE} the chrome is always fully
 *   visible, whatever the travel history.
 * - **Pinned.** While a control the reader is actively using is open or focused
 *   (search field, filter sheet, Nearby sheet, map picker) the chrome stays
 *   visible: the packet requires that active controls are never hidden.
 * - **Two stages, one decision.** The brand row's wordmark collapses to the mark
 *   alone on less travel than the bar takes to leave (10 down against 24), and
 *   returns on more travel than the bar takes to come back (28 up against 12),
 *   so the reveal reads as "the bar, then the name" (owner ruling 2026-10-19).
 *   It is one state machine, so the stages can never disagree about direction.
 *   Both stages are reachable for every uniform drag step of
 *   {@link CHROME_JITTER} or more, because a branch only re-bases the
 *   accumulator when it actually changes the state.
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
/**
 * Downward travel before the brand row's **wordmark** collapses to the mark
 * alone (owner ruling 2026-10-19, the Threads behaviour). Deliberately smaller
 * than {@link CHROME_HIDE_TRAVEL}: the word goes first, and the bar itself
 * follows if the reader keeps going.
 */
export const WORD_COLLAPSE_TRAVEL = 10;
/**
 * Upward travel before the wordmark comes back. Larger than the bar's own
 * {@link CHROME_HIDE_TRAVEL} (24), not merely larger than
 * {@link CHROME_SHOW_TRAVEL}: the bar returns with the mark alone, the name
 * arrives as the reader keeps pulling back. It is the largest travel in the
 * file, so a symmetric oscillation **at the feed's middle** that leaves the bar
 * steady leaves the wordmark settled too — but that qualifier is load-bearing,
 * not decorative. The wordmark can move on its own because the two stages read
 * one accumulator with different thresholds, and because the bar's hide carries
 * an extra condition (`y > {@link CHROME_HIDE_AFTER}`) behind early returns of
 * its own. **The module docstring's gate order is the specification**; an
 * earlier attempt here to state the discriminator as a two-clause disjunction
 * was falsified twice (an asymmetric pull, then the sub-jitter nudge). The
 * wave's evidence carries the measured instances.
 *
 * It is only reachable at all because the show branch re-bases the accumulator
 * on a *transition* rather than on the event — see `nextScrollChrome`. Setting
 * a threshold above the branch that zeroes the accumulator was the independent
 * review's BLOCKER-1: with the accumulator reset every 12px, no uniform drag
 * step could ever hold 20.
 */
export const WORD_RESTORE_TRAVEL = 28;
/** Movement smaller than this is jitter, not intent. */
export const CHROME_JITTER = 3;
/** A single delta this large is a programmatic jump, never a swipe. */
export const CHROME_JUMP = 320;
/**
 * How closely a lost scroll offset must match the shrink of the scrollable
 * range before it is treated as a layout adjustment rather than a gesture.
 * Layout rounding is sub-pixel; a real swipe never matches this.
 */
export const CHROME_LAYOUT_TOLERANCE = 2;

export interface ScrollChromeState {
  /** Whether the chrome is collapsed right now. */
  hidden: boolean;
  /**
   * Whether the brand row is down to the mark alone. Only ever true while the
   * reader is scrolled away from the top.
   */
  compact: boolean;
  /** The offset the last decision was taken against. */
  lastY: number;
  /** Signed travel accumulated in the current direction since that decision. */
  travel: number;
  /**
   * The scrollable range (`scrollHeight - clientHeight`) at that decision, or
   * `-1` when the caller has not supplied geometry yet. It exists to tell a
   * browser clamp apart from a gesture — see `nextScrollChrome`.
   */
  lastMaxY: number;
}

export function initialScrollChrome(): ScrollChromeState {
  return { hidden: false, compact: false, lastY: 0, travel: 0, lastMaxY: -1 };
}

/**
 * The next chrome state for a scroll offset. Pure: no DOM, no timers, so the
 * hysteresis is testable without a browser.
 *
 * `maxY` is the feed's scrollable range (`scrollHeight - clientHeight`). It is
 * what lets this machine tell a browser clamp apart from a gesture: the chrome
 * collapses by giving its own height back to the feed, which *grows* the
 * viewport and therefore *shrinks* `maxY`. At the bottom of the feed the browser
 * then pulls `scrollTop` down by exactly that much. Without the range, that
 * adjustment reads as an upward swipe, so the chrome reappears, the viewport
 * shrinks again, and the next downward pixel re-hides it — the bottom-of-feed
 * flicker. Callers that cannot measure the range omit the argument and keep the
 * pure offset behaviour.
 */
export function nextScrollChrome(
  state: ScrollChromeState,
  scrollTop: number,
  pinned = false,
  maxY?: number,
): ScrollChromeState {
  const y = Number.isFinite(scrollTop) ? Math.max(0, scrollTop) : state.lastY;
  const limit = typeof maxY === "number" && Number.isFinite(maxY) ? Math.max(0, maxY) : null;
  const tracked = limit === null ? state.lastMaxY : limit;
  const keep = (next: Omit<ScrollChromeState, "lastMaxY">): ScrollChromeState => ({ ...next, lastMaxY: tracked });

  if (pinned) return keep({ hidden: false, compact: false, lastY: y, travel: 0 });

  const delta = y - state.lastY;

  // Layout adjustment, not intent — and this MUST be decided before the top
  // zone. Both facts must agree: the offset fell *and* the scrollable range
  // shrank by the same distance, which is precisely what collapsing the chrome
  // does at the bottom. A short feed can shrink all the way to zero, which pulls
  // the offset to the top; reading that as a swipe up would re-grow the range
  // and make the header reappear and disappear. A real upward swipe moves the
  // offset while the range stays put, so it is never mistaken for this and the
  // top-zone reveal below still fires.
  if (limit !== null && state.lastMaxY >= 0 && delta < 0) {
    const shrink = limit - state.lastMaxY;
    if (shrink < 0 && Math.abs(delta - shrink) <= CHROME_LAYOUT_TOLERANCE) {
      return keep({ hidden: state.hidden, compact: state.compact, lastY: y, travel: 0 });
    }
  }

  if (y <= CHROME_TOP_ZONE) return keep({ hidden: false, compact: false, lastY: y, travel: 0 });

  if (Math.abs(delta) >= CHROME_JUMP) return keep({ ...state, lastY: y, travel: 0 });
  if (Math.abs(delta) < CHROME_JITTER) return keep({ ...state, lastY: y });

  // Same direction as the travel already accumulated, or a fresh direction.
  const travel = state.travel * delta > 0 ? state.travel + delta : delta;

  // First stage: the wordmark. It collapses on less travel than the bar takes
  // to leave, and it comes back on more travel than the bar takes to return, so
  // the reveal reads as "the bar, then the name".
  let compact = state.compact;
  if (travel >= WORD_COLLAPSE_TRAVEL) compact = true;
  else if (-travel >= WORD_RESTORE_TRAVEL) compact = false;

  if (travel >= CHROME_HIDE_TRAVEL && y > CHROME_HIDE_AFTER) {
    // A *transition* re-bases the accumulator; an event that changes nothing
    // keeps accumulating. Without this discipline any threshold placed above
    // this one would be unreachable by construction.
    return keep({ hidden: true, compact: true, lastY: y, travel: state.hidden ? travel : 0 });
  }
  if (-travel >= CHROME_SHOW_TRAVEL) {
    // Same discipline on the way back, and this is where it mattered. Zeroing
    // the accumulator on the show *event* rather than on the transition made
    // WORD_RESTORE_TRAVEL (28) unreachable: with 8px upward steps the cycle ran
    // [-8, 0, -8, 0 …] and a reader who pulled back 200px got the bar with no
    // name (independent review BLOCKER-1, reproduced on the real module).
    return keep({ hidden: false, compact, lastY: y, travel: state.hidden ? 0 : travel });
  }
  return keep({ hidden: state.hidden, compact, lastY: y, travel });
}

export interface ScrollChrome {
  /** Whether the chrome should be collapsed. */
  hidden: boolean;
  /** Whether the brand row should show the mark alone. */
  compact: boolean;
  /** Feed this every scroll event of the feed scroller. `maxY` is its
   * `scrollHeight - clientHeight`; supplying it lets a browser clamp caused by
   * the chrome's own collapse be ignored instead of read as an upward swipe. */
  onScroll: (scrollTop: number, maxY?: number) => void;
}

/**
 * Tracks the chrome state across scroll events. `pinned` is the caller's
 * "a control is active, never hide" signal; when it turns true the chrome is
 * revealed immediately (a reader who opens search expects to see it) and it is
 * restored the next time the caller reads `hidden`.
 *
 * Only the two booleans are React state, so a scroll cannot rerender the feed
 * per pixel.
 */
export function useScrollChrome(pinned: boolean): ScrollChrome {
  const stateRef = useRef<ScrollChromeState>(initialScrollChrome());
  const pinnedRef = useRef(pinned);
  const [hidden, setHidden] = useState(false);
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    pinnedRef.current = pinned;
    if (!pinned) return;
    stateRef.current = {
      hidden: false, compact: false, lastY: stateRef.current.lastY, travel: 0,
      lastMaxY: stateRef.current.lastMaxY,
    };
    setHidden(false);
    setCompact(false);
  }, [pinned]);

  const onScroll = useCallback((scrollTop: number, maxY?: number) => {
    const next = nextScrollChrome(stateRef.current, scrollTop, pinnedRef.current, maxY);
    stateRef.current = next;
    setHidden((prev) => (prev === next.hidden ? prev : next.hidden));
    setCompact((prev) => (prev === next.compact ? prev : next.compact));
  }, []);

  return { hidden, compact, onScroll };
}
