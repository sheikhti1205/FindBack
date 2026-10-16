import type { PostItem } from "@findback/shared";
import { PostList } from "../../components/PostList";
import { PullToRefresh } from "../../components/PullToRefresh";
import { FixtureFrame, FixtureSection } from "../FixtureSection";
import { LONG_DESCRIPTION, LONG_TITLE, makePost, masonryRatioPosts } from "../posts";

/**
 * CF-010 feed-layout preflight (packet 09 §6-§11).
 *
 * The masonry grid places cards by real photo ratio, so the only honest way to
 * review it is to render the production `PostList` at each width band. These
 * frames are deterministic (non-resolving `fixture://` media, fixed literals)
 * so a reviewer can screenshot the same thing twice.
 *
 * The width bands are simulated with `masonryColumns`, which is exactly what
 * the Home screen passes in — `masonryColumns(viewportWidth)` — so nothing here
 * invents a layout path production does not have.
 */

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
      description="Production PostList in the masonry density at each column count `masonryColumns` can return (1 / 2 / 3 / 4), plus the compact Morph pagination capsule from §10 and the pull-to-refresh capsule from §12."
    >
      <FixtureFrame section="feed-layouts" variant="normal">
        <p className="mb-2 px-3 text-xs font-medium uppercase tracking-wide text-on-surface-variant">
          1 column — up to 555px (a phone: `auto` picks the Feed layout there, see the home section)
        </p>
        {masonry(1)}
      </FixtureFrame>
      <FixtureFrame section="feed-layouts" variant="normal">
        <p className="mb-2 px-3 text-xs font-medium uppercase tracking-wide text-on-surface-variant">
          2 columns — 556-827px (a small tablet or a landscape phone)
        </p>
        {masonry(2)}
      </FixtureFrame>
      <FixtureFrame section="feed-layouts" variant="normal">
        <p className="mb-2 px-3 text-xs font-medium uppercase tracking-wide text-on-surface-variant">
          3 columns — 828-1099px (a 1024px tablet)
        </p>
        {masonry(3)}
      </FixtureFrame>
      <FixtureFrame section="feed-layouts" variant="normal">
        <p className="mb-2 px-3 text-xs font-medium uppercase tracking-wide text-on-surface-variant">
          4 columns — 1100px and up, never more (`MASONRY_MAX_COLUMNS`)
        </p>
        {masonry(4)}
      </FixtureFrame>
      <FixtureFrame section="feed-layouts" variant="loading">
        <p className="mb-2 px-3 text-xs font-medium uppercase tracking-wide text-on-surface-variant">
          Masonry skeleton (3 columns) — never a centered spinner
        </p>
        {masonry(3, { items: [], loading: true })}
      </FixtureFrame>
      <FixtureFrame section="feed-layouts" variant="loading">
        <p className="mb-2 px-3 text-xs font-medium uppercase tracking-wide text-on-surface-variant">
          Pagination slot — compact Morph capsule (§10): the capsule comes from
          PostList itself, exactly as the Home feed mounts it
        </p>
        {masonry(2, { items: masonryRatioPosts.slice(0, 4), loadingMore: true })}
      </FixtureFrame>
      <FixtureFrame section="feed-layouts" variant="loading">
        <p className="mb-2 px-3 text-xs font-medium uppercase tracking-wide text-on-surface-variant">
          Pull to refresh — stretched Morph capsule (§12, drag the frame down)
        </p>
        <PullToRefresh onRefresh={fixtureRefresh}>
          <div className="flex flex-col gap-2 px-4 py-3">
            {masonryRatioPosts.slice(0, 3).map((post) => (
              <p key={post.id} className="text-sm text-on-surface">
                {post.title}
              </p>
            ))}
          </div>
        </PullToRefresh>
      </FixtureFrame>
      <FixtureFrame section="feed-layouts" variant="empty">
        {masonry(2, { items: [] })}
      </FixtureFrame>
      <FixtureFrame section="feed-layouts" variant="error">
        {masonry(2, {
          items: masonryRatioPosts.slice(0, 2),
          error: "Could not load (fixture preflight — no network is used).",
        })}
      </FixtureFrame>
      <FixtureFrame section="feed-layouts" variant="long-content">
        {masonry(3, { items: longMasonryFeed })}
      </FixtureFrame>
      <FixtureFrame section="feed-layouts" variant="large-text">
        {masonry(2)}
      </FixtureFrame>
      <FixtureFrame section="feed-layouts" variant="dark">
        {masonry(2)}
      </FixtureFrame>
      <FixtureFrame section="feed-layouts" variant="amoled">
        {masonry(2)}
      </FixtureFrame>
      <FixtureFrame section="feed-layouts" variant="small-width">
        {masonry(1)}
      </FixtureFrame>
    </FixtureSection>
  );
}
