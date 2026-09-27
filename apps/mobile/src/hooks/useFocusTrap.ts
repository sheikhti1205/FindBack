import { useEffect, useRef, useState } from "react";
import type { RefObject, RefCallback } from "react";
import { isTopModalLayer, popModalLayer, pushModalLayer } from "./modalLayers";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

/**
 * Keeps keyboard focus inside a modal container while it is mounted.
 *
 * - Moves focus into the container on mount (first focusable, else the container).
 * - Wraps Tab / Shift+Tab at the edges.
 * - Calls onClose on Escape.
 * - Restores focus to the element that was focused before mount on unmount.
 *   The caller can set `previouslyFocusedRef.current` to the trigger element
 *   before enabling the trap. If not set, the hook captures the current focus
 *   when the trap becomes enabled.
 *
 * Usage:
 *   const ref = useRef<HTMLDivElement>(null);
 *   const setRef = useFocusTrap(ref, onClose, isOpen);
 *   return <div ref={setRef} ...>...</div>;
 *
 * Or for backward compatibility (non-portal usage):
 *   const ref = useRef<HTMLDivElement>(null);
 *   useFocusTrap(ref, onClose, isOpen);
 *   return <div ref={ref} ...>...</div>;
 */
export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  enabled = true,
  previouslyFocusedRef?: RefObject<HTMLElement | null>,
): RefCallback<HTMLElement | null> {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Stable layer identity for the modal Escape stack (one Escape closes only
  // the topmost layer even when several traps listen on the document).
  const layerIdRef = useRef<string | null>(null);
  if (layerIdRef.current === null) {
    layerIdRef.current = `focus-trap-${Math.random().toString(36).slice(2)}`;
  }
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const enabledRef = useRef(false);
  enabledRef.current = enabled;
  // Internal ref to store previously focused element when caller doesn't provide one
  const internalPreviouslyFocusedRef = useRef<HTMLElement | null>(null);

  // Track the container element via a callback ref so we can re-run the effect
  // when the element becomes available (e.g. when a portal mounts).
  const setContainerRef: RefCallback<HTMLElement | null> = (el) => {
    containerRef.current = el;
    setContainer(el);
  };

  // Also sync container from containerRef.current for backward compatibility
  // when the caller uses the plain ref directly on the element.
  useEffect(() => {
    if (containerRef.current && containerRef.current !== container) {
      setContainer(containerRef.current);
    }
  }, [containerRef, container]);

  // Capture the previously focused element when the trap becomes enabled.
  // Use caller's ref if provided, otherwise use internal ref.
  useEffect(() => {
    if (enabled && !enabledRef.current) {
      // Trap just became enabled - capture current focus
      const previouslyFocused =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      if (previouslyFocusedRef) {
        if (previouslyFocusedRef.current === null) {
          previouslyFocusedRef.current = previouslyFocused;
        }
      } else {
        internalPreviouslyFocusedRef.current = previouslyFocused;
      }
    }
    enabledRef.current = enabled;
  }, [enabled, previouslyFocusedRef]);

  useEffect(() => {
    if (!enabled || !container) return;

    // Capture previously focused element if not already captured
    const previousRef = previouslyFocusedRef ?? internalPreviouslyFocusedRef;
    if (previousRef.current === null) {
      const previouslyFocused =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      previousRef.current = previouslyFocused;
    }

    const getFocusable = (): HTMLElement[] =>
      Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));

    const focusFirst = (): void => {
      const focusable = getFocusable();
      if (focusable.length > 0) focusable[0]!.focus();
      else container.focus();
    };

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        // Only the topmost layer answers: a nested menu/dialog owns this
        // Escape, and the layers below must stay open.
        if (!isTopModalLayer(layerIdRef.current!)) return;
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      // Same contract as Escape: a covered layer must not fight the topmost
      // dialog for focus. Only the topmost layer traps Tab; the layers below
      // ignore it entirely (their handler would otherwise pull focus back
      // into the underlying editor while the dialog is active).
      if (!isTopModalLayer(layerIdRef.current!)) return;

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

    pushModalLayer(layerIdRef.current!);
    document.addEventListener("keydown", handleKeyDown);
    focusFirst();

    return () => {
      popModalLayer(layerIdRef.current!);
      document.removeEventListener("keydown", handleKeyDown);
      // Use caller's ref if provided, otherwise use internal ref
      const previous = previouslyFocusedRef?.current ?? internalPreviouslyFocusedRef.current;
      if (previous && document.contains(previous)) previous.focus();
    };
  }, [container, enabled, previouslyFocusedRef]);

  // Return the callback ref so the caller can use it instead of the plain ref
  return setContainerRef;
}
