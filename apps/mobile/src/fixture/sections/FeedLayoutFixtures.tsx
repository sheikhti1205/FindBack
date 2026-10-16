import type { ReactNode } from "react";
import type { PostItem } from "@findback/shared";
import { PostList } from "../../components/PostList";
import { PullToRefresh } from "../../components/PullToRefresh";
import {
  MASONRY_CONTAINER_INSET_PX,
  MASONRY_GUTTER_PX,
  MASONRY_MIN_CARD_PX,
  masonryColumns,
} from "../../components/responsive";
import {
  FixtureFrame,
  FixtureSection,
  LARGE_TEXT_PERCENT,
  STANDARD_TEXT_PERCENT,
  type FixtureVariant,
} from "../FixtureSection";
import { LONG_DESCRIPTION, LONG_TITLE, makePost, masonryRatioPosts } from "../posts";

/**
 * CF-010 feed-layout preflight (packet 09 §6-§12).
 *
 * The masonry grid places cards by real photo ratio, so the only honest way to
 * review it is to render the production `PostList` at the width each band
 * claims. Every frame therefore carries an explicit width, and its column count
 * is DERIVED by `masonryColumns(width)` — the same function the Home screen
 * calls with the viewport width — so a frame cannot show a layout production
 * would not produce there. Frames are unpadded so the grid's container equals
 * the frame width, which is the width the maths assumes.
 *
 * The data is deterministic (non-resolving `fixture://` media, fixed literals)
 * so a reviewer can screenshot the same thing twice. Failed media exercises the
 * real "Photo unavailable" affordance rather than a browser broken-image glyph.
 *
 * Two honest limits of these frames:
 * - the card widths they show depend on the text scale held on the root (the
 *   large-text frame switches it page-wide), because the list's `px-4` gutter is
 *   in `rem`: 260.00px at Extra large, 262.67px at 844px and 262.00px at 1116px
 *   at the standard scale — each caption derives its own number. (Blink lays the
 *   844px boundary out at 262.65625px, its 1/64px track quantization of 788/3;
 *   the caption carries the arithmetic value.)
 * - the frames are narrower than `MASONRY_CANVAS_MAX_PX`, so production's pixel
 *   canvas cap is not reached here — the cap is pinned by the unit test instead.
 */

/**
 * The card width a frame's grid yields at a given text scale, from the width the
 * frame declares — the same arithmetic as the floor test. Captions use it so a
 * band's number is DERIVED from that band's own width instead of one number
 * being pasted next to two different widths (262.67px at 844, 262.00px at 1116).
 *
 * The `1rem` list padding below is an assumption about `PostList`'s masonry lane,
 * so `fixture.test.tsx` derives the same number from the lane's own `px-*` class
 * and fails if the two disagree — a caption cannot stay green while the lane
 * renders a different gutter.
 */
export function cardWidthAt(width: number, rootFontSizePx: number): number {
  const columns = masonryColumns(width);
  const container = width - 2 * rootFontSizePx;
  return (container - (columns - 1) * MASONRY_GUTTER_PX) / columns;
}

/**
 * `rem` → px for one of the app's text scales (a 16px root at 100%).
 *
 * The captions and the checks that pin them read the two scales through
 * `LARGE_TEXT_PERCENT` / `STANDARD_TEXT_PERCENT` (themselves read from
 * `TEXT_SCALE_OPTIONS`) and convert here, so lowering the app's largest scale
 * moves the captions and fails the pins instead of leaving both untouched.
 */
export function rootPxFor(percent: number): number {
  return (16 * percent) / 100;
}

/**
 * The width each band frame is rendered at. The 3- and 4-column frames sit
 * exactly on the boundary `masonryColumns` switches at (the width where another
 * 260px card plus its gutter stops fitting the list's container).
 */
const BAND = {
  phone: 390,
  medium: 700,
  threeColumn:
    3 * MASONRY_MIN_CARD_PX + 2 * MASONRY_GUTTER_PX + MASONRY_CONTAINER_INSET_PX,
  fourColumn:
    4 * MASONRY_MIN_CARD_PX + 3 * MASONRY_GUTTER_PX + MASONRY_CONTAINER_INSET_PX,
  small: 320,
} as const;

function noopLoadMore(): Promise<void> {
  return Promise.resolve();
}

/**
 * A refresh that stays pending long enough for a reviewer to look at the
 * capsule, then settles on its own so the fixture route does not leave a
 * request hanging forever.
 */
function fixtureRefresh(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 8000);
  });
}

function masonry(
  columns: number,
  { items = masonryRatioPosts, loading = false, loadingMore = false, error = null }: {
    items?: PostItem[];
    loading?: boolean;
    loadingMore?: boolean;
    error?: string | null;
  } = {},
) {
  return (
    <PostList
      items={items}
      loading={loading}
      loadingMore={loadingMore}
      error={error}
      hasMore={loadingMore}
      onLoadMore={noopLoadMore}
      onRetry={noopLoadMore}
      density="masonry"
      masonryColumns={columns}
    />
  );
}

/**
 * A frame at one width, with the caption stating what that width means for the
 * layout. `columns` is never passed by hand: it is `masonryColumns(width)`.
 */
function BandFrame({
  width,
  variant = "normal",
  label,
  publishesCardWidths = false,
  children,
}: {
  width: number;
  variant?: FixtureVariant;
  label: string;
  /**
   * Print (and declare) the two card widths this width produces. The numbers
   * are computed here once and used for both the caption prose and the frame's
   * `data-frame-measurements`, so the prose cannot quote a figure the
   * declaration does not carry.
   */
  publishesCardWidths?: boolean;
  children: ReactNode;
}) {
  const columns = masonryColumns(width);
  const measurements = publishesCardWidths
    ? [
        cardWidthAt(width, rootPxFor(LARGE_TEXT_PERCENT)).toFixed(2),
        cardWidthAt(width, rootPxFor(STANDARD_TEXT_PERCENT)).toFixed(2),
      ]
    : null;
  return (
    <div className="w-full overflow-x-auto">
      <FixtureFrame
        section="feed-layouts"
        variant={variant}
        width={width}
        geometry
        {...(measurements ? { measurements } : {})}
      >
        <p className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-on-surface-variant">
          {columns} {columns === 1 ? "column" : "columns"} at {width}px — {label}
          {measurements
            ? ` (cards measure ${measurements[0]}px with Extra large text held below, ${measurements[1]}px at the standard scale)`
            : ""}
        </p>
        {children}
      </FixtureFrame>
    </div>
  );
}

/** Twelve reports of uneven height — the packing case that matters most. */
const longMasonryFeed: PostItem[] = Array.from({ length: 12 }, (_, i) => {
  const source = masonryRatioPosts[i % masonryRatioPosts.length]!;
  return makePost(`fx-masonry-long-${i + 1}`, {
    ...source,
    id: `fx-masonry-long-${i + 1}`,
    title: i % 3 === 0 ? LONG_TITLE : source.title,
    description: i % 4 === 0 ? LONG_DESCRIPTION : source.description,
  });
});

export function FeedLayoutFixtures() {
  return (
    <FixtureSection
      id="feed-layouts"
      title="Feed layouts (masonry + compact)"
      description="Production PostList in the masonry density, one frame per width band with the column count derived from that width by `masonryColumns` (1 / 2 / 3 / 4), plus the compact Morph pagination capsule (§10), the pull-to-refresh capsule (§12) and the real large-text / dark / AMOLED / 320dp variants."
    >
      <BandFrame width={BAND.phone} label="a phone; `auto` resolves to the Feed layout here">
        {masonry(masonryColumns(BAND.phone))}
      </BandFrame>
      <BandFrame width={BAND.medium} label="a small tablet or a landscape phone">
        {masonry(masonryColumns(BAND.medium))}
      </BandFrame>
      <BandFrame width={BAND.threeColumn} publishesCardWidths label="the exact 3-column boundary (`masonryColumns` returns 3 here, not 2)">
        {masonry(masonryColumns(BAND.threeColumn))}
      </BandFrame>
      <BandFrame width={BAND.fourColumn} publishesCardWidths label="the exact 4-column boundary, the maximum (`MASONRY_MAX_COLUMNS`)">
        {masonry(masonryColumns(BAND.fourColumn))}
      </BandFrame>
      <BandFrame width={BAND.threeColumn} variant="loading" label="masonry skeleton — never a centered spinner">
        {masonry(masonryColumns(BAND.threeColumn), { items: [], loading: true })}
      </BandFrame>
      <BandFrame
        width={BAND.medium}
        variant="loading"
        label="pagination slot: the compact Morph capsule (§10), rendered by PostList itself exactly as Home mounts it"
      >
        {masonry(masonryColumns(BAND.medium), { items: masonryRatioPosts.slice(0, 4), loadingMore: true })}
      </BandFrame>
      <BandFrame width={BAND.phone} variant="loading" label="pull to refresh: stretched Morph capsule (§12), drag the frame down">
        <PullToRefresh onRefresh={fixtureRefresh}>
          <div className="flex flex-col gap-2 px-4 py-3">
            {masonryRatioPosts.slice(0, 3).map((post) => (
              <p key={post.id} className="text-sm text-on-surface">
                {post.title}
              </p>
            ))}
          </div>
        </PullToRefresh>
      </BandFrame>
      <BandFrame width={BAND.medium} variant="empty" label="empty feed">
        {masonry(masonryColumns(BAND.medium), { items: [] })}
      </BandFrame>
      <BandFrame width={BAND.medium} variant="error" label="feed error">
        {masonry(masonryColumns(BAND.medium), {
          items: masonryRatioPosts.slice(0, 2),
          error: "Could not load (fixture preflight — no network is used).",
        })}
      </BandFrame>
      <BandFrame width={BAND.threeColumn} variant="long-content" label="long titles and descriptions">
        {masonry(masonryColumns(BAND.threeColumn), { items: longMasonryFeed })}
      </BandFrame>
      <BandFrame
        width={BAND.medium}
        variant="large-text"
        label="the app's largest text scale, applied as the root font size"
      >
        {masonry(masonryColumns(BAND.medium))}
      </BandFrame>
      <BandFrame width={BAND.medium} variant="dark" label="the real dark theme tokens">
        {masonry(masonryColumns(BAND.medium))}
      </BandFrame>
      <BandFrame width={BAND.medium} variant="amoled" label="the real AMOLED theme tokens">
        {masonry(masonryColumns(BAND.medium))}
      </BandFrame>
      <BandFrame width={BAND.small} variant="small-width" label="the narrowest phone we support">
        {masonry(masonryColumns(BAND.small))}
      </BandFrame>
    </FixtureSection>
  );
}
