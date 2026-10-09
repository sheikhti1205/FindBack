import { useCallback, useEffect, useRef } from "react";

/**
 * Press-and-hold (~400 ms) detector for the W3.3 reaction tray (pointer
 * events, no native code).
 *
 * - pointerdown (primary button only) starts the timer;
 * - pointermove beyond `moveThresholdPx` cancels (the gesture became scroll);
 * - pointerup before the threshold cancels (a plain tap — the caller's
 *   onClick still runs and must consult `claimTap()`);
 * - pointercancel cancels.
 *
 * Because the tray opens on the timer but the browser still fires `click` on
 * the subsequent pointerup, `claimTap()` reports whether the last gesture
 * opened the tray so the click handler can ignore exactly that tap. The flag
 * resets on the next pointerdown, so a hold without a following click never
 * suppresses a later real tap.
 */

export const LONG_PRESS_DEFAULT_DELAY_MS = 400;
/** Small jitter tolerance: a scroll moves far beyond this. */
export const LONG_PRESS_DEFAULT_MOVE_PX = 10;

interface PointerPoint {
  clientX: number;
  clientY: number;
  button?: number;
}

export interface UseLongPressOptions {
  delayMs?: number;
  moveThresholdPx?: number;
  disabled?: boolean;
}

export interface LongPress {
  onPointerDown: (e: PointerPoint) => void;
  onPointerMove: (e: PointerPoint) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
  /** True when the last gesture opened the tray; consumes the flag. */
  claimTap: () => boolean;
}

export function useLongPress(onOpen: () => void, options: UseLongPressOptions = {}): LongPress {
  const { delayMs = LONG_PRESS_DEFAULT_DELAY_MS, moveThresholdPx = LONG_PRESS_DEFAULT_MOVE_PX, disabled = false } = options;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const suppressedRef = useRef(false);
  const openRef = useRef(onOpen);
  openRef.current = onOpen;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

  const cancel = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    startRef.current = null;
  }, []);

  useEffect(() => cancel, [cancel]);

  const onPointerDown = useCallback(
    (e: PointerPoint) => {
      // A new gesture always clears a stale suppression (hold with pointerup
      // outside the element fires no click to consume it).
      suppressedRef.current = false;
      cancel();
      if (disabledRef.current) return;
      if (e.button !== undefined && e.button !== 0) return;
      startRef.current = { x: e.clientX, y: e.clientY };
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        startRef.current = null;
        suppressedRef.current = true;
        openRef.current();
      }, delayMs);
    },
    [cancel, delayMs],
  );

  const onPointerMove = useCallback(
    (e: PointerPoint) => {
      const start = startRef.current;
      if (!start || timerRef.current === null) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (Math.hypot(dx, dy) > moveThresholdPx) cancel();
    },
    [cancel, moveThresholdPx],
  );

  const onPointerUp = useCallback(() => {
    cancel();
  }, [cancel]);

  const onPointerCancel = useCallback(() => {
    cancel();
  }, [cancel]);

  const claimTap = useCallback(() => {
    const claimed = suppressedRef.current;
    suppressedRef.current = false;
    return claimed;
  }, []);

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, claimTap };
}
