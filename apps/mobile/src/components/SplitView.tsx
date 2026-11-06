import {
  useCallback, useLayoutEffect, useRef, useState,
  type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode,
} from "react";
import { MEDIUM_MAX_PX, useContentWidth, useViewportWidth, useRootFontPx } from "./responsive";
import {
  clampPaneWidth, paneStep, readPanePreference, writePanePreference,
  type PaneBounds, type PanePreference,
} from "./panePreference";
import "./adaptiveFoundation.css";

/**
 * How the list pane may be adjusted on a wide window. A screen opts in; without
 * it the split stays the fixed two-column layout Settings uses.
 */
export type SplitPaneConfig = PaneBounds & { label: string };

export type SplitPaneState = { wide: boolean; collapsed: boolean; toggle: () => void };

/** Width of the draggable divider between the panes, in pixels. */
const DIVIDER_WIDTH = 7;
/** Narrowest detail pane that can still hold a real form at a readable width. */
export const DETAIL_PANE_MIN_PX = 320;
/** The fixed two-column layout's list ceiling, in rem (the CSS column). */
const FIXED_LIST_MAX_REM = 22;

/** Retains pane state/drafts while compact layouts expose only one pane.
 * Data, routing and selection remain with the feature owner.
 *
 * With `pane`, the list becomes a window-splitter: resizable by pointer or
 * keyboard, collapsible to a narrow rail, remembered on this device. The
 * detail pane is never affected by the compact/expanded decision inside it. */
export function SplitView({ selected, list, detail, pane }: {
  selected: boolean;
  list: ReactNode | ((state: SplitPaneState) => ReactNode);
  detail: ReactNode;
  pane?: SplitPaneConfig;
}) {
  const container = useRef<HTMLDivElement>(null);
  const listPane = useRef<HTMLDivElement>(null);
  const detailPane = useRef<HTMLDivElement>(null);
  const width = useContentWidth(container, useViewportWidth());
  // Viable widths for BOTH panes, not just a wide viewport: the list column is
  // sized in rem, so it grows with the reader's text scale, and a constrained
  // parent can leave no usable detail pane even on a wide window. In either case
  // the split falls back to one routed pane, which keeps selection, drafts and
  // the back stack because data ownership never moves.
  //
  // Reserve the WIDEST the list may become, not its minimum: the fixed split's
  // CSS column may grow to 22rem, and a resizable pane can be dragged to its
  // maximum or collapsed to a rail. Reserving the minimum promised a detail pane
  // that the browser could then size below the floor (at 150% text an 840px
  // window reserved 384px and rendered a 528px list, leaving 312px).
  // The list column scales with the reader's text: a user who enlarges text
  // while this screen is open must move this decision too, so re-probe the
  // root font on mutation instead of freezing the mount-time value.
  const rootFont = useRootFontPx();
  const listReserved = pane
    ? Math.max(pane.maxWidth, pane.collapsedWidth)
    : FIXED_LIST_MAX_REM * rootFont;
  const detailWidth = width - listReserved - (pane ? DIVIDER_WIDTH : 0);
  const wide = width >= MEDIUM_MAX_PX && detailWidth >= DETAIL_PANE_MIN_PX;
  const listHidden = !wide && selected;
  const detailHidden = !wide && !selected;
  const [pref, setPref] = useState<PanePreference>(() => readPanePreference(pane));
  const prefRef = useRef(pref);
  prefRef.current = pref;

  const persist = useCallback((next: PanePreference) => {
    setPref(next);
    if (pane) writePanePreference(next, pane);
  }, [pane]);

  const toggle = useCallback(() => {
    persist({ ...prefRef.current, collapsed: !prefRef.current.collapsed });
  }, [persist]);

  // Dragging writes on every frame; the stored habit is written once on release
  // so a slow pointer does not turn a drag into dozens of storage writes.
  const dragging = useRef<{ x: number; width: number; moved: boolean; previous: PanePreference } | null>(null);
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pane || event.button !== 0) return;
    event.preventDefault();
    const previous = prefRef.current;
    const start = previous.collapsed ? pane.minWidth : previous.width;
    dragging.current = { x: event.clientX, width: start, moved: false, previous };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    if (previous.collapsed) setPref({ width: start, collapsed: false });
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = dragging.current;
    if (!pane || !start) return;
    const delta = event.clientX - start.x;
    if (delta !== 0) start.moved = true;
    setPref({ width: clampPaneWidth(start.width + delta, pane), collapsed: false });
  };
  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = dragging.current;
    if (!pane || !start) return;
    dragging.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    // A tap on the divider is not a resize: keep exactly what the user had.
    if (!start.moved) setPref(start.previous);
    else writePanePreference(prefRef.current, pane);
  };

  const onDividerKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!pane) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault(); toggle(); return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      persist({ width: clampPaneWidth(event.key === "Home" ? pane.minWidth : pane.maxWidth, pane), collapsed: false });
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    // Arrows follow reading direction, so "toward the list" is always the
    // shrinking direction in both LTR and RTL layouts.
    const rtl = typeof getComputedStyle === "function" && getComputedStyle(event.currentTarget).direction === "rtl";
    const visual = event.key === "ArrowRight" ? 1 : -1;
    const direction = (rtl ? -visual : visual) as -1 | 1;
    persist({
      width: clampPaneWidth((prefRef.current.collapsed ? pane.minWidth : prefRef.current.width)
        + paneStep(direction, event.shiftKey), pane),
      collapsed: false,
    });
  };

  useLayoutEffect(() => {
    const active = document.activeElement;
    const hidden = listHidden ? listPane.current : detailHidden ? detailPane.current : null;
    if (active && hidden?.contains(active)) {
      (listHidden ? detailPane.current : listPane.current)?.focus();
    }
  }, [listHidden, detailHidden]);

  const adjustable = Boolean(pane) && wide;
  const collapsed = adjustable && pref.collapsed;
  const listWidth = collapsed ? pane!.collapsedWidth : clampPaneWidth(pref.width, pane);
  const state: SplitPaneState = { wide, collapsed, toggle };
  const listContent = typeof list === "function" ? list(state) : list;
  const columns = !adjustable ? undefined : collapsed
    ? `${listWidth}px minmax(0, 1fr)`
    : `${listWidth}px ${DIVIDER_WIDTH}px minmax(0, 1fr)`;

  return <div
    ref={container}
    className={`fb-split-view ${wide ? "fb-split-wide" : ""} ${adjustable ? "fb-split-resizable" : ""}`}
    style={columns ? { gridTemplateColumns: columns } : undefined}>
    <div ref={listPane} hidden={listHidden} tabIndex={-1} className="fb-split-list">{listContent}</div>
    {adjustable && !collapsed && <div
      role="separator"
      aria-orientation="vertical"
      aria-label={pane!.label}
      aria-valuenow={listWidth}
      aria-valuemin={pane!.minWidth}
      aria-valuemax={pane!.maxWidth}
      aria-valuetext={`${listWidth} pixels`}
      tabIndex={0}
      className="fb-split-resize"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onDividerKey} />}
    <div ref={detailPane} hidden={detailHidden} tabIndex={-1} className="fb-split-detail">{detail}</div>
  </div>;
}
