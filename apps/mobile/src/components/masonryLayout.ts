/**
 * Masonry placement model (CF-010, packet `09` §7, §8, §9, §10).
 *
 * Pure arithmetic, no DOM: the DOM half lives in `FeedMasonry.tsx`. Keeping the
 * model separate is what makes "true masonry" testable without a browser, and
 * it is why the placement rule can be stated once instead of living inside a
 * layout effect.
 *
 * Why not CSS columns: a column container flows top-to-bottom then sideways, so
 * the visual order stops matching the DOM order — a keyboard or screen-reader
 * reader would meet the cards in a different sequence than the one on screen.
 * Why not CSS masonry: Chromium (which is what the Android WebView and the
 * desktop shell both are) does not ship `grid-template-rows: masonry`, so it
 * would silently fall back to a normal grid — the fixed-grid fake masonry the
 * packet explicitly rules out. So: source order in the DOM, absolute placement
 * computed here.
 *
 * Placement rule: walk the items in source order and put each one in the
 * currently shortest column (ties go to the leftmost). That is what makes
 * ragged card heights pack instead of leaving holes. Appends keep their
 * existing column (`previous`), so pagination never re-shuffles what the reader
 * is already looking at.
 */

export interface MasonryEntry {
  id: string;
  /** Known or estimated height in CSS pixels. */
  height: number;
}

export interface MasonrySlot {
  id: string;
  /** Zero-based column index. */
  column: number;
  /** Distance from the container's top edge, in CSS pixels. */
  top: number;
  height: number;
}

export interface MasonryLayout {
  slots: MasonrySlot[];
  /** Container height: the tallest column, without a trailing gap. */
  height: number;
  columns: number;
}

export interface PlaceMasonryOptions {
  columns: number;
  /** Vertical gap between two cards in the same column. */
  gap: number;
  /**
   * Column assignments from an earlier pass with the SAME column count.
   * Honoured so appending a page or refining a measured height never moves a
   * card the reader can see. Ignore it when the column count changes — the
   * whole grid is re-flowing anyway, and stale columns would be invalid.
   */
  previous?: ReadonlyMap<string, number> | null;
}

/** Ratio used when a photo's intrinsic size is unknown (packet `09` §9). */
export const MASONRY_FALLBACK_RATIO = 4 / 3;

/** Ratio from a known size pair, clamped to something a screen can show. */
export function masonryAspectRatio(
  size: { readonly width: number; readonly height: number } | null,
): number {
  if (!size) return MASONRY_FALLBACK_RATIO;
  const ratio = size.width / size.height;
  return Number.isFinite(ratio) && ratio > 0 ? ratio : MASONRY_FALLBACK_RATIO;
}

/**
 * Vertical space a masonry card's text block takes: inset padding, the title
 * (at most two lines), the location/meta line, and the counts row.
 *
 * Only used until the card is measured, and in environments that cannot
 * measure. It is deliberately a documented constant rather than a guess
 * scattered through the component.
 */
export const MASONRY_TEXT_BLOCK_PX = 112;

/** First-paint height estimate: the media box, plus the text block. */
export function estimateMasonryCardHeight(
  input: { readonly hasMedia: boolean; readonly mediaRatio: number },
  columnWidth: number,
): number {
  const media = input.hasMedia ? columnWidth / input.mediaRatio : 0;
  return Math.max(1, Math.round(media + MASONRY_TEXT_BLOCK_PX));
}

/** Shortest column index, ties to the leftmost. */
function shortestColumn(heights: readonly number[]): number {
  let best = 0;
  for (let i = 1; i < heights.length; i += 1) {
    if (heights[i]! < heights[best]!) best = i;
  }
  return best;
}

/**
 * Place entries into `columns` columns.
 *
 * Deterministic: identical inputs always produce identical slots, and an entry
 * with no usable height is treated as zero rather than dropped (a card must
 * never disappear because it could not be measured yet).
 */
export function placeMasonry(
  entries: readonly MasonryEntry[],
  options: PlaceMasonryOptions,
): MasonryLayout {
  const columns = Math.max(1, Math.floor(options.columns));
  const gap = Math.max(0, options.gap);
  const columnHeights = new Array<number>(columns).fill(0);
  const slots: MasonrySlot[] = [];

  for (const entry of entries) {
    const height = Number.isFinite(entry.height) && entry.height > 0 ? entry.height : 0;
    const carried = options.previous?.get(entry.id);
    const column =
      typeof carried === "number" && carried >= 0 && carried < columns
        ? carried
        : shortestColumn(columnHeights);
    const top = columnHeights[column]!;
    slots.push({ id: entry.id, column, top, height });
    columnHeights[column] = top + height + gap;
  }

  const tallest = columnHeights.reduce((max, value) => Math.max(max, value), 0);
  return {
    slots,
    columns,
    height: tallest === 0 ? 0 : Math.max(0, tallest - gap),
  };
}

/** Column assignments from a layout, for the next `placeMasonry` pass. */
export function columnAssignments(layout: MasonryLayout): Map<string, number> {
  return new Map(layout.slots.map((slot) => [slot.id, slot.column]));
}

/** Left offset of a column inside a container of `containerWidth` pixels. */
export function columnLeft(
  column: number,
  columns: number,
  containerWidth: number,
  gap: number,
): number {
  const width = columnWidth(columns, containerWidth, gap);
  return Math.round(column * (width + gap));
}

/** Width of one column; never negative, so a tiny container still renders. */
export function columnWidth(columns: number, containerWidth: number, gap: number): number {
  const count = Math.max(1, Math.floor(columns));
  return Math.max(0, (containerWidth - gap * (count - 1)) / count);
}
