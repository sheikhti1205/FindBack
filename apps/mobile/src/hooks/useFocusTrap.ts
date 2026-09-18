import { useEffect, useRef } from "react";
import type { RefObject } from "react";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

/**
 * Keeps keyboard focus inside a modal container while it is mounted.
 *
 * - Moves focus into the container on mount (first focusable, else the container).
 * - Wraps Tab / Shift+Tab at the edges.
 * - Calls onClose on Escape.
 * - Restores focus to the element that was focused before mount on unmount.
 */
export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  onClose: () => void,
): void {
  const previouslyFocused = useRef<HTMLElement | null>(null);
  // Keep the latest callback without re-running the effect, so inline arrow
  // handlers from the caller cannot cause focus to be stolen on every render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    previouslyFocused.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const getFocusable = (): HTMLElement[] =>
      Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));

    const focusFirst = (): void => {
      const focusable = getFocusable();
      if (focusable.length > 0) focusable[0]!.focus();
      else container.focus();
    };

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = getFocusable();
      if (focusable.length === 0) return;

      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;

      if (!container.contains(active) || active === container) {
        event.preventDefault();
        if (event.shiftKey) last.focus();
        else first.focus();
        return;
      }
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    focusFirst();

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      const previous = previouslyFocused.current;
      if (previous && document.contains(previous)) previous.focus();
    };
  }, [containerRef]);
}
