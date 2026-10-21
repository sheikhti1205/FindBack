import { useEffect, useRef, useState, type ReactNode } from "react";

interface BlockedByViewerShieldProps {
  /** Stable row identity. A replacement id starts concealed, never inherited. */
  rowId: string;
  /** O5 bit from the reader (`blockedAuthor`). Absent/false renders no shield. */
  blocked?: boolean;
  children: ReactNode;
  /**
   * Layout mode.
   *
   * `overlay` (default) blurs the child and floats the warning over it — for
   * tall mounts (feed card, detail report region) where the warning fits inside
   * the blurred box.
   *
   * `row` is for short, fixed-rhythm rows (the profile reports list, a comment's
   * content region). There the warning participates in the box instead of
   * floating over it: content and warning share one CSS-grid cell, so the box
   * is `max(content, warning)` and can never paint over a neighbour. The
   * warning stays mounted (invisibly) after reveal so the box height is
   * identical in both states — reveal moves nothing, including the rows below.
   */
  mode?: "overlay" | "row";
  /** Extra classes for the outer positioning wrapper. */
  className?: string;
  /**
   * Classes for the obscured subtree. Mounts that are part of a flex/grid
   * rhythm pass their own layout (e.g. `flex flex-col gap-4`) so revealing
   * never changes the surrounding spacing.
   */
  contentClassName?: string;
}

/**
 * One shield for every surfaced O5 block bit (CF-060 R10).
 *
 * Locked state obscures the row's own content, states a neutral warning
 * (never who blocked whom — the bit is direction-free) and offers one real
 * `Show content` button. The button is a SIBLING of the obscured subtree, never
 * inside an anchor and never a nested interactive control, so it stays
 * reachable by Tab, Enter and Space.
 *
 * The obscured subtree is `inert` and `aria-hidden` while locked: a screen
 * reader must not receive content a sighted user sees only as blur, and every
 * user passes through the same reveal act. `inert` (not `aria-hidden` alone)
 * is what removes the subtree's links and buttons from keyboard navigation.
 *
 * Reveal is per-row local state. It is never persisted, never written to the
 * feed cache, and is dropped as soon as `rowId` changes, so a recycled mount or
 * a second row can never inherit it. Focus moves to the revealed content so
 * removing the button cannot drop focus into the document body.
 *
 * No transition is used: reveal is an instant state change, so reduced motion
 * needs no exception and there is nothing to disable.
 */
export function BlockedByViewerShield({
  rowId,
  blocked,
  children,
  mode = "overlay",
  className,
  contentClassName,
}: BlockedByViewerShieldProps) {
  // Keying the state by row identity (not an effect) means a row-id change is
  // handled in the same render, so a newly mounted/replaced row is never
  // painted revealed for one frame.
  const [state, setState] = useState<{ rowId: string; revealed: boolean }>({ rowId, revealed: false });
  if (state.rowId !== rowId) setState({ rowId, revealed: false });

  const locked = blocked === true && !(state.rowId === rowId && state.revealed);
  const contentRef = useRef<HTMLDivElement>(null);
  const focusAfterReveal = useRef(false);

  useEffect(() => {
    if (!locked && focusAfterReveal.current) {
      focusAfterReveal.current = false;
      contentRef.current?.focus({ preventScroll: true });
    }
  }, [locked]);

  const reveal = () => {
    focusAfterReveal.current = true;
    setState({ rowId, revealed: true });
  };

  // Absent/false is the pre-R10 rendering: no wrapper, no layout change, no
  // extra node for every ordinary row in the feed.
  if (blocked !== true) return <>{children}</>;

  return (
    <div
      data-testid="blocked-shield"
      data-mode={mode}
      data-locked={locked ? "true" : "false"}
      className={
        mode === "row" ? `grid ${className ?? ""}` : `relative ${className ?? ""}`.trim()
      }
    >
      <div
        ref={contentRef}
        data-testid="blocked-shield-content"
        tabIndex={-1}
        inert={locked || undefined}
        aria-hidden={locked || undefined}
        className={`${mode === "row" ? "col-start-1 row-start-1" : ""}${
          locked
            ? mode === "row"
              ? " invisible pointer-events-none select-none"
              : " pointer-events-none select-none blur-[6px]"
            : ""
        }${contentClassName ? ` ${contentClassName}` : ""}`}
      >
        {children}
      </div>
      {mode === "row" ? (
        // Kept mounted after reveal (invisible, inert) so the grid cell keeps
        // `max(content, warning)` in both states: no reveal jump, and the
        // warning can never paint outside its own row.
        <div
          data-testid="blocked-shield-warning"
          inert={!locked || undefined}
          aria-hidden={!locked || undefined}
          className={`col-start-1 row-start-1 flex min-w-0 flex-wrap items-center gap-2 px-1 py-2 ${
            locked ? "" : "invisible"
          }`}
        >
          <div className="flex min-w-0 flex-[1_1_6rem] flex-col text-start">
            <p className="text-sm font-medium">Hidden by a block</p>
            <p className="sr-only">A block is active between you and this person.</p>
          </div>
          <button
            type="button"
            onClick={reveal}
            className="ms-auto inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-end px-1 text-sm font-semibold text-primary underline decoration-1 underline-offset-4"
          >
            Show content
          </button>
        </div>
      ) : (
        locked && (
          <div
            data-testid="blocked-shield-warning"
            className="pointer-events-none absolute inset-0 flex items-start justify-center p-3"
          >
            <div className="pointer-events-auto flex max-w-full flex-col items-center gap-2 rounded-m3-md border border-outline-variant bg-surface-container-low px-3 py-2 text-center shadow-sm">
              <p className="text-sm font-medium">Content hidden</p>
              <p className="text-xs text-on-surface-variant">
                A block is active between you and this person.
              </p>
              <button
                type="button"
                onClick={reveal}
                className="min-h-[44px] rounded-full border border-outline-variant px-4 text-sm font-semibold text-on-surface"
              >
                Show content
              </button>
            </div>
          </div>
        )
      )}
    </div>
  );
}
