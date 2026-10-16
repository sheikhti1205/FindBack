import { useEffect, useState } from "react";

/**
 * How much of the window an on-screen keyboard is covering, read from the
 * visual viewport (packet 05 §8 — the report composer's keyboard mode).
 *
 * A WebView can be configured either way, and the difference decides what the
 * composer has to do:
 *
 * - with a resizing soft-input mode the layout viewport shrinks with the
 *   keyboard, `visualViewport` follows it, and the measured inset is ~0 — the
 *   browser already keeps the focused editor in view, so the composer only has
 *   to keep the formatting rail inside that view;
 * - with an overlaying IME the layout viewport is untouched and only
 *   `visualViewport` shrinks, so the inset is the real amount of the form hiding
 *   behind the keyboard, and the form needs that much scroll tail.
 *
 * Reading the geometry covers both. Inferring "keyboard open" from scroll
 * position instead is wrong the moment a keyboard opens without any scroll.
 *
 * `offsetTop` counts because the visible area can also be shifted (zoom, or
 * scrolling with the keyboard up): only the part of the window that is neither
 * shifted into view nor visible is genuinely covered.
 */
export interface VisualViewportGeometry {
  /** Layout-viewport height (`window.innerHeight`). */
  readonly innerHeight: number;
  /** Visible height (`visualViewport.height`). */
  readonly viewportHeight: number;
  /** How far the visible area is shifted down from the layout viewport's top. */
  readonly viewportOffsetTop: number;
}

export interface KeyboardInset {
  /** Pixels of the window the keyboard covers at the bottom (0 when none). */
  readonly insetPx: number;
  /** Height of the visible area — what is left above the keyboard. */
  readonly viewportHeightPx: number;
  /** True once the inset exceeds {@link KEYBOARD_OPEN_THRESHOLD_PX}. */
  readonly open: boolean;
}

/**
 * The threshold the shell's bottom nav already uses to step out of the
 * keyboard's way. Browser-chrome resizes are tens of pixels; a keyboard is
 * hundreds, so this cannot fire on ordinary mobile chrome movement.
 */
export const KEYBOARD_OPEN_THRESHOLD_PX = 120;

/** Pure geometry, so the measurement's own arithmetic is testable. */
export function readKeyboardInset(geometry: VisualViewportGeometry): KeyboardInset {
  const covered = geometry.innerHeight - (geometry.viewportOffsetTop + geometry.viewportHeight);
  const insetPx = Math.max(0, Math.round(covered));
  const viewportHeightPx = Math.max(0, Math.round(geometry.viewportHeight));
  return { insetPx, viewportHeightPx, open: insetPx > KEYBOARD_OPEN_THRESHOLD_PX };
}

/** The "no keyboard, nothing measured" reading. */
export const NO_KEYBOARD_INSET: KeyboardInset = { insetPx: 0, viewportHeightPx: 0, open: false };

function measure(): KeyboardInset {
  const innerHeight = Math.round(window.innerHeight || 0);
  const viewport = window.visualViewport;
  // No visual viewport (or a stub without one): the layout viewport is all there
  // is, which is the honest answer rather than a guess at keyboard state.
  if (!viewport) {
    return readKeyboardInset({ innerHeight, viewportHeight: innerHeight, viewportOffsetTop: 0 });
  }
  return readKeyboardInset({
    innerHeight,
    viewportHeight: viewport.height,
    viewportOffsetTop: viewport.offsetTop,
  });
}

/**
 * Keyboard geometry for the current window, re-read on every `visualViewport`
 * resize/scroll and on window resize.
 *
 * Commits are equality-guarded: an IME emits a burst of resize events while it
 * animates, and re-rendering the form with an identical value would make the
 * composer fight the keyboard's own transition. Nothing here scrolls anything —
 * the consumer only reserves space, and the browser's scroll-into-view stays the
 * only mover.
 */
export function useKeyboardInset(): KeyboardInset {
  const [inset, setInset] = useState<KeyboardInset>(() =>
    typeof window === "undefined" ? NO_KEYBOARD_INSET : measure(),
  );

  useEffect(() => {
    const update = () => {
      const next = measure();
      setInset((prev) =>
        prev.insetPx === next.insetPx &&
        prev.viewportHeightPx === next.viewportHeightPx &&
        prev.open === next.open
          ? prev
          : next,
      );
    };
    // The mount effect re-reads before subscribing: the form can mount while the
    // keyboard is already open (a route restored mid-typing).
    update();
    const viewport = window.visualViewport;
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  return inset;
}
