import type { PostItem } from "@findback/shared";
import { PostCard } from "../../components/PostCard";
import { PostCardContent } from "../../components/PostCardContent";
import { PostList } from "../../components/PostList";
import { FixtureFrame, FixtureSection } from "../FixtureSection";
import {
  STRINGS,
  allHomeMatrixPosts,
  homeEdgeVariants,
  homePhotoVariants,
  homeStatusVariants,
  makePost,
} from "../posts";

function noopLoadMore(): Promise<void> {
  return Promise.resolve();
}

/** One production card per matrix row so reviewers can screenshot each. */
function MatrixCards({ posts }: { posts: PostItem[] }) {
  return (
    <div className="flex flex-col gap-3">
      {posts.map((post, i) => (
        <PostCard key={post.id} to={`/posts/${post.id}`} index={i}>
          <PostCardContent post={post} layout="home-feed" />
        </PostCard>
      ))}
    </div>
  );
}

/**
 * Home feed preflight. Uses the ACTUAL `PostList` + `PostCard(Content)`
 * the Home screen renders (home-feed density), driven by the deterministic
 * matrix in `../posts` — 0/1/5 photos, all statuses, long title/location,
 * high reaction counts, long username/display name, no avatar.
 */
export function HomeFixtures() {
  return (
    <FixtureSection
      id="home"
      title="Home feed"
      description="Production PostList + PostCardContent (home-feed density) across feed states and the full Home matrix."
    >
      <FixtureFrame section="home" variant="normal">
        <PostList
          items={allHomeMatrixPosts}
          loading={false}
          loadingMore={false}
          error={null}
          hasMore={false}
          onLoadMore={noopLoadMore}
        />
      </FixtureFrame>
      <FixtureFrame section="home" variant="loading">
        <PostList
          items={[]}
          loading
          loadingMore={false}
          error={null}
          hasMore={false}
          onLoadMore={noopLoadMore}
        />
      </FixtureFrame>
      <FixtureFrame section="home" variant="empty">
        <PostList
          items={[]}
          loading={false}
          loadingMore={false}
          error={null}
          hasMore={false}
          onLoadMore={noopLoadMore}
          emptyTitle={STRINGS.emptyTitle}
          emptySubtitle={STRINGS.emptySubtitle}
        />
      </FixtureFrame>
      <FixtureFrame section="home" variant="error">
        <PostList
          items={[]}
          loading={false}
          loadingMore={false}
          error={STRINGS.loadingError}
          hasMore={false}
          onLoadMore={noopLoadMore}
          onRetry={noopLoadMore}
        />
      </FixtureFrame>
      <FixtureFrame section="home" variant="long-content">
        <MatrixCards posts={homeEdgeVariants} />
      </FixtureFrame>
      <FixtureFrame section="home" variant="large-text">
        <MatrixCards posts={homePhotoVariants} />
      </FixtureFrame>
      <FixtureFrame section="home" variant="dark">
        <MatrixCards posts={homePhotoVariants} />
      </FixtureFrame>
      <FixtureFrame section="home" variant="amoled">
        <MatrixCards posts={homeStatusVariants} />
      </FixtureFrame>
      <FixtureFrame section="home" variant="small-width">
        <MatrixCards
          posts={[
            ...homePhotoVariants,
            makePost("fx-home-320-long", {
              title:
                "320dp check: long title wrapping inside the narrowest supported viewport",
            }),
          ]}
        />
      </FixtureFrame>
    </FixtureSection>
  );
}
