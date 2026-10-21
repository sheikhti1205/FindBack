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
import { useEffect, useState, type RefObject } from "react";

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
 * Widest the masonry canvas ever gets, in CSS pixels (the cap Home's grid
 * container carries through `MASONRY_CANVAS_CLASS`).
 *
 * This is a PIXEL cap on purpose, not a `rem` one. The gutter inside it is
 * `rem` (`px-4`), so a `rem` cap shrinks the container *below the viewport* for
 * a reader on the Small text scale: at `max-w-[72rem]` a 14px root gave a 1008px
 * canvas, and the 4 columns chosen for a 1116px viewport landed in 980px of grid
 * — 236px cards against a 260px floor. A pixel cap keeps the guarantee
 * expressible from the viewport width alone: for every width where
 * `masonryColumns` picks `n` columns, `min(viewport, this)` is still wide
 * enough for `n` minimum cards at the largest text scale the app offers.
 * 1152px is comfortably above the 4-column boundary (1116px).
 */
export const MASONRY_CANVAS_MAX_PX = 1152;

/** Centred wide canvas for the masonry feed, capped at `MASONRY_CANVAS_MAX_PX`. */
export const MASONRY_CANVAS_CLASS = "mx-auto w-full max-w-[1152px]";

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
 * The gutter is in `rem`, so it grows with the reader's text size: 28px at the
 * Small scale (87.5%), 32px at the default, 40px (2 x 1rem x 1.25) at the
 * largest the app offers. The budget covers the largest, so the minimum-card
 * guarantee holds at every text scale rather than only at the default one.
 *
 * The inset is a fixed 40px while the padding scales, so the slack at a column
 * boundary falls as the text grows: 12px at Small (87.5%), 8px at the default,
 * 4px at Large (112.5%) and 0px at Extra large (125%) — the largest scale is what
 * sets the 40px. At the default scale that 8px also absorbs a classic
 * (non-overlay) scrollbar of up to 8px — the target platform (Android WebView)
 * uses overlay scrollbars.
 */
export const MASONRY_CONTAINER_INSET_PX = 40;

/**
 * How many masonry columns fit a canvas `widthPx` CSS pixels wide.
 *
 * `widthPx` is the width the feed *receives*, not the viewport: when the reader
 * chose the side rail, the rail is an in-flow sibling and the feed gets less.
 * `Home` measures its own canvas with `useContentWidth` and passes that number;
 * passing `window.innerWidth` there is what let 600–667 px render 226–259 px
 * cards under the rail. Without a measured canvas the width is the viewport.
 *
 * Cards never go below `MASONRY_MIN_CARD_PX`, so a wide-but-not-huge viewport
 * lands on 2 (small tablet) or 3 (tablet/landscape) columns rather than
 * squeezing 4 narrow ones. Always at least 1.
 *
 * The guarantee, over the container the feed actually gets — the canvas, capped
 * by `MASONRY_CANVAS_MAX_PX`, minus the list's own gutter:
 *
 *   columns * MASONRY_MIN_CARD_PX + (columns - 1) * MASONRY_GUTTER_PX
 *     <= min(widthPx, MASONRY_CANVAS_MAX_PX) - 2 * rootFontSizePx
 *
 * which the shape below satisfies exactly (`floor(usable / step)` with
 * `usable = viewport - inset + gutter` leaves one gutter of slack, which is the
 * 12px that makes the last column's right edge land inside the container). The
 * cap being >= the 4-column boundary is what keeps that true for viewports
 * wider than the cap.
 *
 * The width BAND and this column count are separate decisions, and for four
 * pixels they disagree: `widthBand(840)` is already "expanded" while three
 * 260px cards still need 844 of container, so 840-843 renders an expanded canvas
 * with two columns. Deliberate (the band decides the canvas, the floor decides
 * the count) and pinned by a test rather than papered over.
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
 * The one width gate for the optional side rail: at `COMPACT_MAX_PX` and up a
 * stored `rail` applies; below it the bottom bar always wins. Derived from the
 * band constant above so the breakpoint cannot drift from `widthBand`.
 */
export const NAV_RAIL_MEDIA_QUERY = `(min-width: ${COMPACT_MAX_PX}px)`;

/** `matchMedia` when the environment has it; jsdom has no media support. */
function wideViewportQuery(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  return window.matchMedia(NAV_RAIL_MEDIA_QUERY);
}

function readWideViewport(): boolean {
  if (typeof window === "undefined") return false;
  const query = wideViewportQuery();
  return query ? query.matches : window.innerWidth >= COMPACT_MAX_PX;
}

/**
 * Whether the viewport is at or above the rail breakpoint.
 *
 * The query is the owner, with a `resize` listener as the fallback the test
 * environment (jsdom has no `matchMedia`) and older WebViews need. Both funnel
 * into one state update, so a width change re-renders without a reload and the
 * two sources can never disagree about the stored preference.
 */
export function useWideViewport(): boolean {
  const [wide, setWide] = useState(readWideViewport);

  useEffect(() => {
    const query = wideViewportQuery();
    const sync = () => setWide(query ? query.matches : readWideViewport());
    // Re-read once: the width can change between the initial render and effect
    // attachment (rotation, desktop window resize).
    sync();
    if (query) {
      if (typeof query.addEventListener === "function") {
        query.addEventListener("change", sync);
      } else {
        query.addListener(sync);
      }
    }
    window.addEventListener("resize", sync);
    return () => {
      if (query) {
        if (typeof query.removeEventListener === "function") {
          query.removeEventListener("change", sync);
        } else {
          query.removeListener(sync);
        }
      }
      window.removeEventListener("resize", sync);
    };
  }, []);

  return wide;
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

/**
 * Live width of the box an element actually got, in CSS pixels.
 *
 * Column maths must come from the width the feed receives, not from
 * `window.innerWidth`: the optional side rail is an in-flow sibling and takes
 * `6.5rem` out of the same row, so a viewport-width column count put 226–259 px
 * cards beside it at 600–667 px. Measuring is also the only answer that stays
 * right at every text scale — the rail is sized in `rem` and grows with the
 * reader's scale — and it keeps `masonryColumns`' guarantee honest where the
 * canvas is capped by `MASONRY_CANVAS_MAX_PX`.
 *
 * `fallback` covers the first render and environments with no layout engine
 * (jsdom, where every `clientWidth` is 0). In a browser the observer fires
 * after layout and before paint, so the fallback's column count is never
 * painted.
 */
export function useContentWidth(
  ref: RefObject<HTMLElement | null>,
  fallback: number,
): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const read = () => {
      const next = Math.round(ref.current?.clientWidth ?? 0);
      if (next > 0) setWidth((current) => (current === next ? current : next));
    };
    read();
    const el = ref.current;
    const Observer = typeof ResizeObserver === "function" ? ResizeObserver : null;
    const observer = Observer && el ? new Observer(read) : null;
    if (observer && el) observer.observe(el);
    window.addEventListener("resize", read);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", read);
    };
  }, [ref]);
  return width > 0 ? width : fallback;
}
