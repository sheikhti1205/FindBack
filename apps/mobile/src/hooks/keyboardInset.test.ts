// @vitest-environment jsdom
/**
 * §8: the keyboard measurement the report composer's composition mode is built
 * on. Both WebView soft-input modes have to come out right — a resizing one
 * (inset ~0, the browser already made room) and an overlaying IME (the inset is
 * the real covered height) — and the hook has to stay quiet while an IME
 * animates, because the composer must not fight the keyboard's own transition.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  KEYBOARD_OPEN_THRESHOLD_PX,
  readKeyboardInset,
  useKeyboardInset,
} from "./keyboardInset";

const originalInnerHeight = window.innerHeight;
const originalVisualViewport = Object.getOwnPropertyDescriptor(window, "visualViewport");

function setInnerHeight(px: number) {
  Object.defineProperty(window, "innerHeight", { configurable: true, value: px });
}

/** A stand-in for `window.visualViewport` that can be resized and notified. */
function installVisualViewport(initial: { height: number; offsetTop: number }) {
  const geometry = { ...initial };
  const listeners = new Map<string, Set<() => void>>();
  const viewport = {
    get height() {
      return geometry.height;
    },
    get offsetTop() {
      return geometry.offsetTop;
    },
    addEventListener(type: string, listener: () => void) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type: string, listener: () => void) {
      listeners.get(type)?.delete(listener);
    },
  };
  Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  return {
    resize(next: { height: number; offsetTop?: number }) {
      geometry.height = next.height;
      geometry.offsetTop = next.offsetTop ?? geometry.offsetTop;
      listeners.get("resize")?.forEach((listener) => listener());
    },
    scroll() {
      listeners.get("scroll")?.forEach((listener) => listener());
    },
    listenerCount(type: string) {
      return listeners.get(type)?.size ?? 0;
    },
  };
}

afterEach(() => {
  setInnerHeight(originalInnerHeight);
  if (originalVisualViewport) {
    Object.defineProperty(window, "visualViewport", originalVisualViewport);
  } else {
    delete (window as { visualViewport?: unknown }).visualViewport;
  }
});

describe("readKeyboardInset", () => {
  it("reads no keyboard when the visible area is the whole window", () => {
    expect(readKeyboardInset({ innerHeight: 768, viewportHeight: 768, viewportOffsetTop: 0 })).toEqual({
      insetPx: 0,
      viewportHeightPx: 768,
      open: false,
    });
  });

  it("reports what an overlaying IME covers, and what is left above it", () => {
    expect(readKeyboardInset({ innerHeight: 768, viewportHeight: 420, viewportOffsetTop: 0 })).toEqual({
      insetPx: 348,
      viewportHeightPx: 420,
      open: true,
    });
  });

  it("counts a shifted visible area as visible, not as covered", () => {
    // Zoom / scroll with the keyboard up: the visible strip starts lower down, so
    // only the part of the window that is neither shifted into view nor visible
    // is covered.
    const shifted = readKeyboardInset({ innerHeight: 800, viewportHeight: 480, viewportOffsetTop: 120 });
    expect(shifted.insetPx).toBe(200);
    expect(shifted.viewportHeightPx).toBe(480);
    expect(shifted.open).toBe(true);
  });

  it("never reports a negative inset", () => {
    // A visual viewport that runs past the layout viewport (transition frames,
    // odd embeds) must clamp rather than hand the form a negative padding.
    const past = readKeyboardInset({ innerHeight: 800, viewportHeight: 200, viewportOffsetTop: 700 });
    expect(past.insetPx).toBe(0);
    expect(past.open).toBe(false);
  });

  it("opens exactly past the threshold the shell's nav uses", () => {
    const at = (innerHeight: number) =>
      readKeyboardInset({ innerHeight, viewportHeight: innerHeight - KEYBOARD_OPEN_THRESHOLD_PX, viewportOffsetTop: 0 });
    expect(at(768).open).toBe(false);
    expect(
      readKeyboardInset({
        innerHeight: 768,
        viewportHeight: 768 - KEYBOARD_OPEN_THRESHOLD_PX - 1,
        viewportOffsetTop: 0,
      }).open,
    ).toBe(true);
  });
});

describe("useKeyboardInset", () => {
  it("falls back to the layout viewport when there is no visual viewport", () => {
    setInnerHeight(768);
    const { result } = renderHook(() => useKeyboardInset());
    expect(result.current).toEqual({ insetPx: 0, viewportHeightPx: 768, open: false });
  });

  it("follows the keyboard and releases the measurement when it closes", () => {
    setInnerHeight(768);
    const viewport = installVisualViewport({ height: 768, offsetTop: 0 });
    const { result } = renderHook(() => useKeyboardInset());
    expect(result.current.open).toBe(false);

    act(() => viewport.resize({ height: 420 }));
    expect(result.current).toEqual({ insetPx: 348, viewportHeightPx: 420, open: true });

    act(() => viewport.resize({ height: 768 }));
    expect(result.current).toEqual({ insetPx: 0, viewportHeightPx: 768, open: false });
  });

  it("keeps the same reading while the IME re-emits identical geometry", () => {
    // The no-churn promise: the keyboard animates in over many resize events, and
    // a form that re-renders on each of them fights the animation it is following.
    setInnerHeight(768);
    const viewport = installVisualViewport({ height: 420, offsetTop: 0 });
    const { result } = renderHook(() => useKeyboardInset());
    const first = result.current;
    act(() => {
      viewport.resize({ height: 420 });
      viewport.scroll();
      viewport.resize({ height: 420 });
    });
    expect(result.current).toBe(first);
  });

  it("subscribes to both visual-viewport events and window resize, and unsubscribes", () => {
    setInnerHeight(768);
    const viewport = installVisualViewport({ height: 768, offsetTop: 0 });
    const { unmount } = renderHook(() => useKeyboardInset());
    expect(viewport.listenerCount("resize")).toBe(1);
    expect(viewport.listenerCount("scroll")).toBe(1);
    unmount();
    expect(viewport.listenerCount("resize")).toBe(0);
    expect(viewport.listenerCount("scroll")).toBe(0);
  });
});
