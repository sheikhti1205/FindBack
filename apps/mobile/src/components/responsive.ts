/**
 * CF-010 responsive vocabulary (packet `09` §1, §2, §6, §7, §21, §22).
 *
 * The app used to be one phone column: `Shell` clamped the whole canvas to
 * `max-w-md`, so every screen was 448px wide no matter the device. The shell now
 * hands out a responsive canvas and each screen picks its own content width.
 *
 * The bands follow the platform window-size idea (compact < 600, medium
 * 600-839, expanded >= 840) because that is also what Android itself calls
 * these widths, so a screen's decision and the platform's own layout decisions
 * agree. Nothing here reads colour, theme or motion.
 *
 * Pure module: no DOM at import time, no listeners. `useViewportWidth` is the
 * only hook and it is opt-in.
 */
import { useEffect, useState } from "react";

/** Below this width the canvas is a phone: one column, compact gutters. */
export const COMPACT_MAX_PX = 600;
/** Up to this width it is a large phone / small tablet / landscape phone. */
export const MEDIUM_MAX_PX = 840;

export type WidthBand = "compact" | "medium" | "expanded";

/** Width band for a CSS pixel viewport width. */
export function widthBand(widthPx: number): WidthBand {
  if (widthPx < COMPACT_MAX_PX) return "compact";
  if (widthPx < MEDIUM_MAX_PX) return "medium";
  return "expanded";
}

/**
 * Default readable column for a screen that has no layout opinion of its own.
 *
 * 44rem matches the existing per-screen column the settings pages already use
 * (`.fb-settings-page`), so a wide viewport stops stretching text to absurd
 * line lengths without any screen having to opt in. Phone widths are below this
 * cap, so compact layouts are unaffected by construction.
 */
export const READABLE_COLUMN_CLASS = "mx-auto w-full max-w-[44rem]";

/**
 * Canvas for a surface that was designed for wide viewports (the Home feed and
 * Search use the available width and grow more masonry columns).
 */
export const WIDE_CANVAS_CLASS = "w-full";

/** Smallest comfortable masonry card, in CSS pixels. */
export const MASONRY_MIN_CARD_PX = 260;
/** Horizontal gap between masonry columns, in CSS pixels. */
export const MASONRY_GUTTER_PX = 12;
/** Never more than this many columns, however wide the viewport gets. */
export const MASONRY_MAX_COLUMNS = 4;

/**
 * Horizontal inset the feed adds inside the width it is measured by: `px-4` on
 * the masonry list (`PostList`'s `listClass`), i.e. 1rem each side.
 *
 * This is part of the maths because the feed is measured by *viewport* width
 * while the cards land in the container inside it. Measured in the fixture and
 * in the running app: at an 828px frame the grid was 794px wide (828 - 32
 * padding - 2 frame border), so the old 24px budget promised 260px cards and
 * delivered 256.7px.
 *
 * The gutter is in `rem`, so it grows with the reader's text size: 32px at the
 * standard scale and 40px (2 x 1rem x 1.25) at the largest the app offers. The
 * budget covers the largest, so the minimum-card guarantee holds at every text
 * scale rather than only at the default one. At the standard scale that leaves
 * 8px of slack, which also absorbs a classic (non-overlay) scrollbar of up to
 * 8px — the target platform (Android WebView) uses overlay scrollbars.
 */
export const MASONRY_CONTAINER_INSET_PX = 40;

/**
 * How many masonry columns fit a viewport.
 *
 * Cards never go below `MASONRY_MIN_CARD_PX`, so a wide-but-not-huge viewport
 * lands on 2 (small tablet) or 3 (tablet/landscape) columns rather than
 * squeezing 4 narrow ones. Always at least 1.
 *
 * The guarantee, over the container the feed actually gets:
 *
 *   columns * MASONRY_MIN_CARD_PX + (columns - 1) * MASONRY_GUTTER_PX
 *     <= widthPx - MASONRY_CONTAINER_INSET_PX
 *
 * which the shape below satisfies exactly (`floor(usable / step)` with
 * `usable = contacted - inset + gutter` leaves one gutter of slack, which is the
 * 12px that makes the last column's right edge land inside the container).
 */
export function masonryColumns(widthPx: number): number {
  const step = MASONRY_MIN_CARD_PX + MASONRY_GUTTER_PX;
  const usable = Math.max(0, widthPx - MASONRY_CONTAINER_INSET_PX) + MASONRY_GUTTER_PX;
  return Math.max(1, Math.min(MASONRY_MAX_COLUMNS, Math.floor(usable / step)));
}

/** Feed layout choices. `auto` is the stored default; the rest are explicit. */
export type FeedLayout = "auto" | "feed" | "compact" | "masonry";

/** What a stored preference actually resolves to on this viewport. */
export type ResolvedFeedLayout = "feed" | "compact" | "masonry";

/**
 * Resolve a stored preference against the current width.
 *
 * `auto` picks: phone → feed, medium → feed (a 600-840 viewport still reads
 * best as a single comfortable column), expanded → masonry. The rule depends on
 * the band rather than the exact pixel width, so the layout cannot change
 * because the viewport moved a few pixels (packet `09` §6: no unexpected layout
 * change while the user is scrolling).
 */
export function resolveFeedLayout(
  preference: FeedLayout,
  widthPx: number,
): ResolvedFeedLayout {
  if (preference !== "auto") return preference;
  return widthBand(widthPx) === "expanded" ? "masonry" : "feed";
}

/**
 * `PostList` density for a resolved layout.
 *
 * The reader-facing name of the single-column photo layout is "Feed"; the card
 * component has always called that rendering `home-feed`. Translating in one
 * place keeps the two vocabularies from leaking into each other.
 */
export function feedDensity(layout: ResolvedFeedLayout): "home-feed" | "compact" | "masonry" {
  return layout === "feed" ? "home-feed" : layout;
}

/**
 * Live viewport width in CSS pixels.
 *
 * Starts from `window.innerWidth` so the first paint already has the right
 * layout (a later correction would be a visible layout shift), then follows
 * resizes. Returns the compact width when there is no window at all.
 */
export function useViewportWidth(): number {
  const [width, setWidth] = useState<number>(() =>
    typeof window === "undefined" ? COMPACT_MAX_PX - 1 : window.innerWidth,
  );
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    // Re-read once: the width can change between the initial render and effect
    // attachment (rotation, desktop window resize, keyboard-induced resize).
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return width;
}
