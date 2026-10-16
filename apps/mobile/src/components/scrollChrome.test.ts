// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  CHROME_HIDE_AFTER,
  CHROME_HIDE_TRAVEL,
  CHROME_JUMP,
  CHROME_SHOW_TRAVEL,
  CHROME_TOP_ZONE,
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
