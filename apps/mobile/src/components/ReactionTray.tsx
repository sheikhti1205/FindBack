import { useEffect, useRef, useState } from "react";
import type {
  CanonicalReactionKind,
  ReactionCounts,
  ReactionKind,
} from "@findback/shared";
import { CANONICAL_REACTION_KINDS } from "@findback/shared";
import { REACTION_KINDS, normalizeReactionKind } from "../services/reactions";
import { REACTION_KIND_FUNCTIONAL } from "../design/functionalColors";
import { ReactionArt } from "./ReactionArt";
import {
  useFloating,
  autoUpdate,
  offset,
  flip,
  shift,
  size,
  FloatingPortal,
} from "@floating-ui/react";

/**
 * C2 floating reaction pill: the shared picker for posts and comments.
 *
 * - Floating pill anchored above the trigger via a Floating UI portal
 *   (`FloatingPortal` + `useFloating`), so it escapes the caller's clipping
 *   ancestors (`overflow-y-auto` scrollers, `overflow-hidden` image frames)
 *   and flips/shifts to stay fully inside the viewport; icon-only, no labels
 *   or counts inside.
 * - Large expressive filled SVG artwork (see `ReactionArt` — never an
 *   emoji-font glyph), one 44px hit target per kind, 30px visual art.
 * - Hold (~400 ms, owned by the caller's `useLongPress`) opens; haptic
 *   (`navigator.vibrate`) fires once on open. While held, the finger may
 *   slide across choices (`hovered` lifts/scales); release selects; a
 *   predominantly-vertical move cancels (handled by the caller's
 *   `useSlideSelect` + scroll listener here).
 * - Normal tap on the trigger (not the tray) toggles the default/current
 *   reaction — owned by the caller. Direct taps on a tray option select it.
 * - Keyboard/screen-reader: `menu`/`menuitemradio`, arrows + Home/End move,
 *   Enter/Space selects, Escape closes and returns focus to `triggerId`.
 *   An explicit "Choose reaction" button (owned by the caller) opens the
 *   same tray with no long-press needed.
 */

export function reactionKindLabel(kind: CanonicalReactionKind): string {
  return REACTION_KINDS.find((m) => m.kind === kind)?.label ?? kind;
}

/** Highest-count kind; ties resolve in canonical tray order; empty → null. */
export function topReactionKind(counts: ReactionCounts): CanonicalReactionKind | null {
  let best: CanonicalReactionKind | null = null;
  let bestCount = 0;
  for (const kind of CANONICAL_REACTION_KINDS) {
    const n = counts[kind] ?? 0;
    if (n > bestCount) {
      best = kind;
      bestCount = n;
    }
  }
  return best;
}

export interface ReactionTrayProps {
  open: boolean;
  /** Caller's current reaction (raw wire kind accepted; LIKE reads as LOVE). */
  myReaction: ReactionKind | null;
  counts: ReactionCounts;
  total: number;
  pending?: boolean;
  onSelect: (kind: CanonicalReactionKind) => void;
  onClose: () => void;
  /** Element id to restore focus to on Escape (the tray trigger). */
  triggerId: string;
  /**
   * Controlled slide hover (set by the caller's `useSlideSelect` while the
   * opening finger is still held). When omitted the tray tracks hover from
   * its own pointer events.
   */
  hoveredKind?: CanonicalReactionKind | null;
  onHoverChange?: (kind: CanonicalReactionKind | null) => void;
}

export function ReactionTray({
  open,
  myReaction,
  counts: _counts,
  total: _total,
  pending = false,
  onSelect,
  onClose,
  triggerId,
  hoveredKind,
  onHoverChange,
}: ReactionTrayProps) {
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;
  const [innerHover, setInnerHover] = useState<CanonicalReactionKind | null>(null);
  const hovered = hoveredKind !== undefined ? hoveredKind : innerHover;
  const setHover = onHoverChange ?? setInnerHover;
  // Pointer-down inside the tray (direct tap) vs a drag that started on the
  // trigger and slid over the tray: only the drag path selects on pointerup —
  // a direct tap selects through click. `dragSelected` swallows the stray
  // click some browsers emit after a drag-release select.
  const downInsideRef = useRef(false);
  const dragSelectedRef = useRef(false);
  const activeKind =
    myReaction === null ? null : (normalizeReactionKind(myReaction) as CanonicalReactionKind);

  // Focus the active kind (else the first) so arrows/Enter work immediately.
  useEffect(() => {
    if (!open) return;
    const index = activeKind ? CANONICAL_REACTION_KINDS.indexOf(activeKind) : 0;
    itemRefs.current[index]?.focus();
  }, [open, activeKind]);

  // Haptic on open only: guarded, try/catch, no-op where unsupported.
  useEffect(() => {
    if (!open) return;
    try {
      navigator.vibrate?.(10);
    } catch {
      // Vibration is a nicety; never break the tray.
    }
  }, [open]);

  // A scroll while open cancels (the gesture became a scroll, not a pick).
  // Shell scrolls an inner container, so a window bubble-phase listener misses
  // flings: capture-phase catches container scrolls, and visualViewport covers
  // keyboard/zoom-driven moves that never emit a document scroll.
  useEffect(() => {
    if (!open) return;
    const onScroll = () => closeRef.current();
    window.addEventListener("scroll", onScroll, { passive: true, capture: true });
    const viewport = window.visualViewport ?? null;
    viewport?.addEventListener("scroll", onScroll, { passive: true });
    viewport?.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll, { capture: true });
      viewport?.removeEventListener("scroll", onScroll);
      viewport?.removeEventListener("resize", onScroll);
    };
  }, [open]);

  // Portal + Floating UI: the tray escapes the caller's clipping ancestors
  // (the feed's `overflow-y-auto` scroller and the image frame's
  // `overflow-hidden`) and is anchored to the trigger element, flipping and
  // shifting to stay fully inside the viewport at 320dp and in landscape.
  const { refs, floatingStyles } = useFloating({
    open,
    onOpenChange: (next) => {
      if (!next) closeRef.current();
    },
    placement: "top",
    strategy: "fixed",
    middleware: [
      offset(6),
      flip({ padding: 8, fallbackAxisSideDirection: "start" }),
      shift({ padding: 8, crossAxis: true }),
      size({
        apply({ availableWidth, elements }: { availableWidth: number; elements: { floating: HTMLElement } }) {
          elements.floating.style.maxWidth = `${Math.max(0, availableWidth - 8)}px`;
        },
      }),
    ],
    whileElementsMounted: autoUpdate,
  });

  // Anchor to the trigger by id: callers pass the id of whichever control
  // opened the tray (the main button or the "Choose reaction" chevron).
  useEffect(() => {
    if (open) refs.setReference(document.getElementById(triggerId));
  }, [open, refs, triggerId]);

  // FloatingPortal mounts its children after the parent's passive effects, so
  // the focus effect above can run before the option refs attach. Focus the
  // active/first option synchronously from the floating ref callback instead
  // (child refs attach before the parent's on mount).
  const setFloatingRef = (el: HTMLDivElement | null) => {
    refs.setFloating(el);
    if (el && open) {
      const index = activeKind ? CANONICAL_REACTION_KINDS.indexOf(activeKind) : 0;
      itemRefs.current[index]?.focus();
    }
  };

  if (!open) return null;

  function focusAt(index: number) {
    const clamped = (index + CANONICAL_REACTION_KINDS.length) % CANONICAL_REACTION_KINDS.length;
    itemRefs.current[clamped]?.focus();
  }

  function focusedIndex(): number {
    const active = document.activeElement;
    const found = itemRefs.current.findIndex((el) => el === active);
    return found >= 0 ? found : 0;
  }

  function onMenuKeyDown(e: React.KeyboardEvent) {
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        e.preventDefault();
        focusAt(focusedIndex() + 1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        e.preventDefault();
        focusAt(focusedIndex() - 1);
        break;
      case "Home":
        e.preventDefault();
        focusAt(0);
        break;
      case "End":
        e.preventDefault();
        focusAt(CANONICAL_REACTION_KINDS.length - 1);
        break;
      case "Enter":
      case " ": {
        const el = document.activeElement as HTMLButtonElement | null;
        const kind = el?.dataset.kind as CanonicalReactionKind | undefined;
        if (kind && CANONICAL_REACTION_KINDS.includes(kind)) {
          e.preventDefault();
          selectRef.current(kind);
        }
        break;
      }
      case "Escape":
        e.preventDefault();
        closeRef.current();
        document.getElementById(triggerId)?.focus();
        break;
    }
  }

  function handleTrayPointerUp() {
    // Drag-release from the trigger: the pointer went down outside the tray,
    // slid over a choice, and lifted — select the hovered kind.
    if (!downInsideRef.current && hovered !== null) {
      dragSelectedRef.current = true;
      window.setTimeout(() => {
        dragSelectedRef.current = false;
      }, 350);
      selectRef.current(hovered);
    }
    downInsideRef.current = false;
  }

  return (
    <FloatingPortal>
      <div
        ref={setFloatingRef}
        style={floatingStyles}
        role="menu"
        data-testid="reaction-tray"
        aria-label="Choose a reaction"
        onKeyDown={onMenuKeyDown}
        onPointerUp={handleTrayPointerUp}
        onPointerLeave={() => setHover(null)}
        className="flex items-center gap-0.5 rounded-full border border-outline-variant bg-surface-container px-1.5 py-1 shadow-lg"
      >
        {CANONICAL_REACTION_KINDS.map((kind, index) => {
          const checked = activeKind === kind;
          const lifted = hovered === kind;
          return (
            <button
              key={kind}
              ref={(el) => {
                itemRefs.current[index] = el;
              }}
              type="button"
              role="menuitemradio"
              aria-checked={checked}
              aria-label={checked ? `${reactionKindLabel(kind)}, active` : reactionKindLabel(kind)}
              data-testid={`reaction-option-${kind}`}
              data-kind={kind}
              data-hovered={lifted ? "true" : "false"}
              data-functional-color={REACTION_KIND_FUNCTIONAL[kind]}
              disabled={pending}
              onPointerEnter={() => setHover(kind)}
              onPointerMove={() => {
                if (hovered !== kind) setHover(kind);
              }}
              onPointerDown={() => {
                downInsideRef.current = true;
              }}
              onClick={() => {
                // Swallow the stray click after a drag-release select so one
                // gesture never writes twice.
                if (dragSelectedRef.current) return;
                selectRef.current(kind);
              }}
              className="relative flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full p-1 transition-transform duration-150 motion-reduce:transition-none"
              style={{
                transform: lifted ? "scale(1.3) translateY(-4px)" : checked ? "scale(1.12)" : "scale(1)",
                backgroundColor: checked ? "var(--fb-surface-container-high)" : "transparent",
                zIndex: lifted ? 1 : 0,
              }}
            >
              <ReactionArt kind={kind} size={30} />
              {checked && (
                <span
                  aria-hidden="true"
                  data-testid={`reaction-active-${kind}`}
                  className="absolute bottom-1 h-1 w-1 rounded-full"
                  style={{ backgroundColor: `var(--fb-reaction-${kind.toLowerCase()})` }}
                />
              )}
            </button>
          );
        })}
      </div>
    </FloatingPortal>
  );
}
