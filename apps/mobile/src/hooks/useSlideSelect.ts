import { useCallback, useEffect, useRef, useState } from "react";
import type { CanonicalReactionKind } from "@findback/shared";
import { CANONICAL_REACTION_KINDS } from "@findback/shared";

/**
 * C2 slide-to-select tracker for an open reaction tray.
 *
 * While the tray is open AND the opening pointer is still held, window
 * pointermove resolves the kind under the finger via
 * `document.elementFromPoint` and lifts it (`hovered`); window pointerup
 * reports the release so the caller can select `hovered` or cancel.
 * A predominantly-vertical move beyond `cancelDyPx` cancels (the gesture
 * became a scroll) — the caller closes without selecting.
 *
 * jsdom has no layout: tests stub `document.elementFromPoint` to return an
 * option element (or null) and fire window pointer events with clientX/Y.
 */

export const SLIDE_CANCEL_DY_PX = 24;

export interface SlideSelect {
  hovered: CanonicalReactionKind | null;
  setHovered: (kind: CanonicalReactionKind | null) => void;
  /** Clear the hover (after select/close). */
  reset: () => void;
}

function kindOfElement(el: Element | null): CanonicalReactionKind | null {
  const holder = el?.closest?.("[data-kind]") as HTMLElement | null;
  const kind = holder?.dataset.kind as CanonicalReactionKind | undefined;
  return kind && (CANONICAL_REACTION_KINDS as readonly string[]).includes(kind) ? kind : null;
}

export function useSlideSelect(
  open: boolean,
  holding: boolean,
  onCancel: () => void,
): SlideSelect {
  const [hovered, setHovered] = useState<CanonicalReactionKind | null>(null);
  const openPos = useRef<{ x: number; y: number } | null>(null);
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;

  const reset = useCallback(() => {
    setHovered(null);
    openPos.current = null;
  }, []);

  useEffect(() => {
    if (!open) {
      setHovered(null);
      openPos.current = null;
      return;
    }
    if (!holding) return;

    function onMove(e: PointerEvent) {
      if (openPos.current === null) {
        openPos.current = { x: e.clientX, y: e.clientY };
      }
      const dx = e.clientX - openPos.current.x;
      const dy = e.clientY - openPos.current.y;
      // Vertical scroll cancels: predominantly vertical travel past the band.
      if (Math.abs(dy) > SLIDE_CANCEL_DY_PX && Math.abs(dy) > Math.abs(dx) * 2) {
        cancelRef.current();
        return;
      }
      const el =
        typeof document.elementFromPoint === "function"
          ? document.elementFromPoint(e.clientX, e.clientY)
          : null;
      setHovered(kindOfElement(el));
    }

    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, [open, holding]);

  return { hovered, setHovered: setHovered, reset };
}

/** Testable pure lookup: kind under a point-like element (no DOM needed). */
export function slideKindForTarget(target: { closest?: (sel: string) => { dataset?: { kind?: string } } | null } | null): CanonicalReactionKind | null {
  if (!target || typeof target.closest !== "function") return null;
  const holder = target.closest("[data-kind]") as { dataset?: { kind?: string } } | null;
  const kind = holder?.dataset?.kind as CanonicalReactionKind | undefined;
  return kind && (CANONICAL_REACTION_KINDS as readonly string[]).includes(kind) ? kind : null;
}
