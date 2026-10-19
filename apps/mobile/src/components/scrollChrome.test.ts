// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  CHROME_HIDE_AFTER,
  CHROME_HIDE_TRAVEL,
  CHROME_JUMP,
  CHROME_SHOW_TRAVEL,
  CHROME_TOP_ZONE,
  WORD_COLLAPSE_TRAVEL,
  WORD_RESTORE_TRAVEL,
  initialScrollChrome,
  nextScrollChrome,
  useScrollChrome,
  type ScrollChromeState,
} from "./scrollChrome";

/** Fold a sequence of offsets through the tracker, as a real scroll would. */
function run(offsets: number[], opts: { pinned?: boolean; from?: ScrollChromeState } = {}) {
  let state = opts.from ?? initialScrollChrome();
  for (const y of offsets) state = nextScrollChrome(state, y, opts.pinned ?? false);
  return state;
}

describe("scroll-reactive chrome state", () => {
  it("starts visible and stays visible at the top", () => {
    expect(initialScrollChrome().hidden).toBe(false);
    expect(run([CHROME_TOP_ZONE]).hidden).toBe(false);
    // Even a whole screen of downward travel below the zone leaves a return to
    // the top visible.
    expect(run([0, 200, 400, 900, 10]).hidden).toBe(false);
  });

  it("hides only after deliberate downward travel past the threshold", () => {
    // A short move: real intent, but not enough travel yet.
    expect(run([30]).hidden).toBe(false);
    expect(run([30, 70]).hidden).toBe(true);
  });

  it("keeps the chrome while the feed is still within the hide-after zone", () => {
    // Travel exceeds the threshold, but the offset is not far enough down.
    const atZone = run([0, CHROME_HIDE_AFTER]);
    expect(atZone.hidden).toBe(false);
    expect(atZone.travel).toBeGreaterThanOrEqual(CHROME_HIDE_TRAVEL);
    // Once past it, the next downward move completes the hide.
    expect(run([0, CHROME_HIDE_AFTER, CHROME_HIDE_AFTER + 20]).hidden).toBe(true);
  });

  it("reveals on a smaller upward swipe than it took to hide (hysteresis)", () => {
    const hidden = run([0, 300, 340, 400]);
    expect(hidden.hidden).toBe(true);

    // A short upward flick below the show travel is not enough.
    const nudge = nextScrollChrome(hidden, 400 - (CHROME_SHOW_TRAVEL - 1));
    expect(nudge.hidden).toBe(true);

    // One real upward move restores it, with less travel than hiding needed.
    const restored = nextScrollChrome(nudge, 400 - (CHROME_SHOW_TRAVEL - 1) - CHROME_SHOW_TRAVEL);
    expect(restored.hidden).toBe(false);
    expect(CHROME_SHOW_TRAVEL).toBeLessThan(CHROME_HIDE_TRAVEL);
  });

  it("ignores jitter without accumulating it", () => {
    // Settled a third of the way down, still visible, with real travel banked.
    let state = run([30, 45]);
    expect(state.hidden).toBe(false);
    const banked = state.travel;
    // Ten sub-jitter events: none may count toward the hide or reset the bank.
    for (let i = 0; i < 10; i += 1) {
      state = nextScrollChrome(state, 46);
      state = nextScrollChrome(state, 45);
    }
    expect(state.hidden).toBe(false);
    expect(state.travel).toBe(banked);
    expect(state.lastY).toBe(45);
  });

  it("reverses direction only on real movement", () => {
    // Down, then a single pixel up: the banked downward travel survives.
    const banked = run([30, 45, 44]);
    expect(banked.travel).toBeGreaterThan(0);
    expect(banked.hidden).toBe(false);

    // A real upward move restarts the travel with the opposite sign.
    const reversed = nextScrollChrome(banked, 40);
    expect(reversed.travel).toBe(-4);
    expect(reversed.hidden).toBe(false);
  });

  it("treats a single large delta as a jump, not a swipe", () => {
    // Visible + restored offset: stay visible.
    expect(run([0, 900]).hidden).toBe(false);
    // Hidden + a jump: stay hidden, re-based, no phantom travel.
    const hidden = run([0, 300, 400, 500]);
    expect(hidden.hidden).toBe(true);
    const jumped = nextScrollChrome(hidden, 500 + CHROME_JUMP);
    expect(jumped.hidden).toBe(true);
    expect(jumped.travel).toBe(0);
    expect(jumped.lastY).toBe(500 + CHROME_JUMP);
  });

  it("never hides while a control is pinned, and drops the travel", () => {
    const state = run([0, 100, 140, 180], { pinned: true });
    expect(state.hidden).toBe(false);
    expect(state.travel).toBe(0);
    // Unpinning does not hide by itself: the reader has to scroll again.
    expect(nextScrollChrome(state, 180).hidden).toBe(false);
  });

  it("ignores a non-finite offset instead of corrupting the state", () => {
    const state = run([0, 400]);
    expect(nextScrollChrome(state, Number.NaN)).toEqual(state);
    expect(nextScrollChrome(state, Number.POSITIVE_INFINITY).hidden).toBe(state.hidden);
  });
});

/**
 * Owner ruling 2026-10-19: the brand row's wordmark collapses to the mark alone
 * once the reader scrolls away, and the name comes back on the way up. It is a
 * first stage of the same collapse, not a second mechanism: the word goes before
 * the bar leaves, and on the way back the bar arrives with the mark alone before
 * the name returns.
 */
describe("wordmark stage (owner ruling 2026-10-19)", () => {
  it("collapses the wordmark before the bar itself leaves", () => {
    // Deliberate downward travel, not yet enough to take the whole bar.
    const wordOnly = run([30]);
    expect(wordOnly.compact).toBe(true);
    expect(wordOnly.hidden).toBe(false);
    expect(WORD_COLLAPSE_TRAVEL).toBeLessThan(CHROME_HIDE_TRAVEL);

    // Continue, and the bar follows the word.
    const gone = run([30, 70]);
    expect(gone.compact).toBe(true);
    expect(gone.hidden).toBe(true);
  });

  it("brings the bar back with the mark alone, then the name", () => {
    // The order, for the step size where both stages are observable: the bar
    // returns first and still wordless, then the name arrives.
    let s = run([0, 300, 340, 400]);
    expect(s.hidden).toBe(true);
    let y = 400;
    const seen: Array<[boolean, boolean]> = [];
    while (!(!s.hidden && !s.compact) && y > CHROME_TOP_ZONE) {
      y -= 8;
      s = nextScrollChrome(s, y);
      seen.push([s.hidden, s.compact]);
    }
    expect(seen).toContainEqual([false, true]); // bar back, name not
    expect([s.hidden, s.compact]).toEqual([false, false]); // then the name
    expect(y).toBeGreaterThan(CHROME_TOP_ZONE); // mid-feed, not the top zone

    // Independent review BLOCKER-1: the restore was reachable for one lucky step
    // size only, because the show branch zeroed the accumulator the second
    // stage measured. Every step a finger produces must get there, mid-feed.
    for (const step of [4, 6, 8, 10, 11, 12, 16, 20, 40, 120]) {
      let st = run([0, 300, 340, 400]);
      let yy = 400;
      let restoredMidFeed = false;
      for (let i = 0; i < 80; i++) {
        yy -= step;
        st = nextScrollChrome(st, yy);
        if (!st.hidden && !st.compact) {
          restoredMidFeed = yy > CHROME_TOP_ZONE;
          break;
        }
      }
      expect(restoredMidFeed, `a ${step}px pull-back must restore the name mid-feed`).toBe(true);
    }
  });

  it("only re-bases the accumulator on a transition, never on a no-op event", () => {
    // The mechanism behind the test above, asserted directly: once the bar is
    // back, upward travel keeps accumulating until the wordmark threshold.
    const gone = run([0, 300, 340, 400]);
    const barBack = nextScrollChrome(gone, 400 - CHROME_SHOW_TRAVEL);
    expect([barBack.hidden, barBack.compact]).toEqual([false, true]);
    expect(WORD_RESTORE_TRAVEL).toBeGreaterThan(CHROME_SHOW_TRAVEL);
    // ... so travel must survive the events that only re-assert "visible".
    const later = nextScrollChrome(barBack, 400 - 2 * CHROME_SHOW_TRAVEL);
    expect(Math.abs(later.travel)).toBeGreaterThanOrEqual(CHROME_SHOW_TRAVEL);
  });

  it("does not strobe below the bar's own hide travel", () => {
    // A symmetric finger oscillation at the feed's middle. The honest bound is
    // the bar's travel, not the wordmark's: below it at most one stage moves
    // once, above it both move together.
    function flips(amplitude: number, cycles: number) {
      let s = nextScrollChrome(initialScrollChrome(), 600); // a jump: no opinion
      let hiddenFlips = 0;
      let compactFlips = 0;
      let y = 600;
      for (let i = 0; i < cycles * 2; i++) {
        y += i % 2 === 0 ? amplitude : -amplitude;
        const next = nextScrollChrome(s, y);
        if (next.hidden !== s.hidden) hiddenFlips++;
        if (next.compact !== s.compact) compactFlips++;
        s = next;
      }
      return { hiddenFlips, compactFlips };
    }

    const calm = flips(CHROME_HIDE_TRAVEL - 1, 10);
    expect(calm.hiddenFlips).toBe(0); // the bar never moved
    expect(calm.compactFlips).toBeLessThanOrEqual(1); // the word settled, it did not flutter

    const rough = flips(CHROME_HIDE_TRAVEL + 6, 10);
    expect(rough.hiddenFlips).toBeGreaterThan(0); // the bar strobes at that size
    expect(rough.compactFlips).toBeGreaterThan(0); // and the word follows it
  });

  it("never leaves the wordmark expanded while the bar is collapsed", () => {
    // hidden ⇒ compact, along a walk that crosses every branch.
    let s = initialScrollChrome();
    for (const y of [0, 30, 60, 120, 400, 90, 40, 24, 0]) {
      s = nextScrollChrome(s, y);
      if (s.hidden) expect(s.compact).toBe(true);
    }
    expect([s.hidden, s.compact]).toEqual([false, false]);
  });

  it("restores the wordmark at the top and while a control is pinned", () => {
    const wordOnly = run([30]);
    expect(wordOnly.compact).toBe(true);
    expect(nextScrollChrome(wordOnly, CHROME_TOP_ZONE).compact).toBe(false);

    const pinned = run([30], { pinned: true });
    expect(pinned.compact).toBe(false);
  });

  it("still treats a jump and jitter as the bar does", () => {
    const wordOnly = run([30]);
    // A jump re-bases without an opinion: the wordmark stays as the reader left it.
    const jumped = nextScrollChrome(wordOnly, 30 + CHROME_JUMP);
    expect(jumped.compact).toBe(wordOnly.compact);
    expect(jumped.travel).toBe(0);
    // Jitter neither collapses nor restores it.
    const jittered = nextScrollChrome(wordOnly, 31);
    expect(jittered.compact).toBe(wordOnly.compact);
  });
});

describe("useScrollChrome", () => {
  it("collapses on a downward scroll and returns on an upward one", () => {
    const { result } = renderHook(() => useScrollChrome(false));
    expect(result.current.hidden).toBe(false);

    act(() => result.current.onScroll(30));
    expect(result.current.hidden).toBe(false);
    act(() => result.current.onScroll(70));
    expect(result.current.hidden).toBe(true);

    act(() => result.current.onScroll(70 - CHROME_SHOW_TRAVEL - 1));
    expect(result.current.hidden).toBe(false);
  });

  it("reveals immediately when a control becomes pinned, and stays revealed", () => {
    const { result, rerender } = renderHook(
      ({ pinned }: { pinned: boolean }) => useScrollChrome(pinned),
      { initialProps: { pinned: false } },
    );
    act(() => result.current.onScroll(300));
    act(() => result.current.onScroll(400));
    expect(result.current.hidden).toBe(true);

    rerender({ pinned: true });
    expect(result.current.hidden).toBe(false);
    // Scroll positions keep arriving while the sheet is open; none may re-hide.
    act(() => result.current.onScroll(900));
    expect(result.current.hidden).toBe(false);
  });
});
