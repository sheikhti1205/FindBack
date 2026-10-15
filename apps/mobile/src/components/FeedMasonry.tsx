/**
 * FeedMasonry (CF-010, packet `09` §6–§9, §24): true ragged masonry.
 *
 * The DOM half of `masonryLayout.ts`. Cards keep their **source order in the
 * DOM** and are placed with absolute transforms, so:
 *
 * - a keyboard or screen-reader reader meets the reports in feed order, not in
 *   whatever order the columns happen to be drawn in;
 * - appending a page never re-creates the list — every already-placed card
 *   keeps its column (`previous`) and the scroller keeps its position;
 * - the container's height is known, so infinite pagination has somewhere to
 *   put its sentinel and the page does not grow a second scrollbar.
 *
 * Heights come from measurement when the environment can measure (a
 * `ResizeObserver` on each card, plus the container width) and from
 * `estimateHeight` until then, so the first paint already reserves the right
 * space instead of collapsing every card into a zero-height strip. If the
 * container cannot be measured at all (no `ResizeObserver`, no layout engine —
 * e.g. jsdom), the component degrades to a plain stacked list rather than
 * emitting nonsense geometry.
 *
 * Pure module boundary: no colour, no theme, no motion policy. Placement is
 * instant on purpose — re-flowing a measured grid with an animation is
 * continuous main-thread work the packet explicitly warns against.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  columnAssignments,
  columnLeft,
  columnWidth,
  placeMasonry,
  type MasonryLayout,
  type MasonrySlot,
} from "./masonryLayout";

export interface FeedMasonryProps<T> {
  items: readonly T[];
  /** Stable card identity: the key used for placement, measurement and React. */
  getKey: (item: T) => string;
  /** Column count, from `masonryColumns(viewportWidth)`. */
  columns: number;
  /** Vertical gap between two cards in one column. */
  gap?: number;
  /** First-paint height, used until the card is measured. */
  estimateHeight: (item: T, columnWidth: number) => number;
  renderItem: (item: T, columnWidth: number) => ReactNode;
  className?: string;
}

export function FeedMasonry<T>({
  items,
  getKey,
  columns,
  gap = 12,
  estimateHeight,
  renderItem,
  className = "",
}: FeedMasonryProps<T>) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [measureVersion, setMeasureVersion] = useState(0);
  const heightsRef = useRef(new Map<string, number>());
  const itemRefs = useRef(new Map<string, HTMLElement>());
  /** Column assignment from the last pass, reused only at the same count. */
  const previousRef = useRef<{ columns: number; map: Map<string, number> } | null>(null);

  const keys = useMemo(() => items.map(getKey), [items, getKey]);
  const keySignature = keys.join("|");

  const measureWidth = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const next = Math.round(el.clientWidth);
    setWidth((current) => (current === next ? current : next));
  }, []);

  const measureHeights = useCallback(() => {
    let changed = false;
    for (const [key, el] of itemRefs.current) {
      const height = Math.round(el.getBoundingClientRect().height || el.offsetHeight || 0);
      if (height > 0 && heightsRef.current.get(key) !== height) {
        heightsRef.current.set(key, height);
        changed = true;
      }
    }
    if (changed) setMeasureVersion((v) => v + 1);
  }, []);

  // Container width: observed live (rotation, desktop resize, keyboard-induced
  // resize) and read once on mount, so the first pass is not measured at 0.
  useLayoutEffect(() => {
    measureWidth();
    const el = containerRef.current;
    const Observer = typeof ResizeObserver === "function" ? ResizeObserver : null;
    const observer = Observer && el ? new Observer(measureWidth) : null;
    if (observer && el) observer.observe(el);
    window.addEventListener("resize", measureWidth);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measureWidth);
    };
  }, [measureWidth]);

  // Card heights: one observer for the whole grid, re-created only when the set
  // of cards changes. A new photo load or a font-scale change lands here, which
  // is what keeps the packing honest for rows published without dimensions.
  useEffect(() => {
    const Observer = typeof ResizeObserver === "function" ? ResizeObserver : null;
    if (!Observer) {
      measureHeights();
      return;
    }
    const observer = new Observer(measureHeights);
    for (const el of itemRefs.current.values()) observer.observe(el);
    measureHeights();
    return () => observer.disconnect();
  }, [keySignature, measureHeights, columns]);

  const columnCount = Math.max(1, Math.floor(columns));
  const colWidth = columnWidth(columnCount, width, gap);

  const layout: MasonryLayout = useMemo(() => {
    const previous =
      previousRef.current && previousRef.current.columns === columnCount
        ? previousRef.current.map
        : null;
    return placeMasonry(
      items.map((item) => ({
        id: getKey(item),
        height: heightsRef.current.get(getKey(item)) ?? estimateHeight(item, colWidth),
      })),
      { columns: columnCount, gap, previous },
    );
    // `measureVersion` and `width` are inputs through refs/derived values; both
    // are listed so a measurement or resize re-packs.
  }, [items, keySignature, columnCount, gap, colWidth, width, measureVersion, estimateHeight]);

  useEffect(() => {
    previousRef.current = { columns: columnCount, map: columnAssignments(layout) };
  }, [layout, columnCount]);

  const registerItem = useCallback((key: string, el: HTMLElement | null) => {
    if (el) itemRefs.current.set(key, el);
    else itemRefs.current.delete(key);
  }, []);

  // Unmeasured container: a plain list is always correct, and never absolutely
  // positioned onto nonsense coordinates. The fallback keeps the same ref (and
  // therefore the same width) as the grid, so the first layout effect can still
  // read a real width and promote the list to the grid; without that the
  // component would sit in the fallback forever in a browser.
  if (width <= 0) {
    return (
      <div ref={containerRef} data-testid="feed-masonry" data-measured="false" className={className}>
        {items.map((item) => (
          <div key={getKey(item)} data-testid="feed-masonry-item" ref={(el) => registerItem(getKey(item), el)}>
            {renderItem(item, 0)}
          </div>
        ))}
      </div>
    );
  }

  const slots = new Map<string, MasonrySlot>(layout.slots.map((slot) => [slot.id, slot]));

  return (
    <div
      ref={containerRef}
      data-testid="feed-masonry"
      data-measured="true"
      data-columns={columnCount}
      className={`relative ${className}`}
      style={{ height: layout.height > 0 ? `${layout.height}px` : undefined }}
    >
      {items.map((item) => {
        const key = getKey(item);
        const slot = slots.get(key);
        const left = columnLeft(slot?.column ?? 0, columnCount, width, gap);
        return (
          <div
            key={key}
            data-testid="feed-masonry-item"
            data-column={slot?.column ?? 0}
            ref={(el) => registerItem(key, el)}
            className="absolute left-0 top-0"
            style={{
              width: `${colWidth}px`,
              transform: `translate3d(${left}px, ${slot?.top ?? 0}px, 0)`,
            }}
          >
            {renderItem(item, colWidth)}
          </div>
        );
      })}
    </div>
  );
}
