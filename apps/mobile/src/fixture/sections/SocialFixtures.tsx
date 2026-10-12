import { CommentComposer } from "../../components/CommentComposer";
import { EmptyState, Spinner } from "../../components/PostCard";
import { PostCard } from "../../components/PostCard";
import { PostCardContent } from "../../components/PostCardContent";
import { PostList } from "../../components/PostList";
import { UserAvatar } from "../../components/UserAvatar";
import { FixtureFrame, FixtureSection } from "../FixtureSection";
import {
  LONG_USERNAME,
  STRINGS,
  allHomeMatrixPosts,
  detailPost,
  fixtureComments,
  makePost,
} from "../posts";

function noopLoadMore(): Promise<void> {
  return Promise.resolve();
}

function noopSubmit(): Promise<void> {
  return Promise.resolve();
}

function noopError(): void {}

/** Static notification rows built from the production avatar. */
function NotificationRows() {
  const rows = [
    {
      id: "fx-n1",
      username: "samira",
      displayName: "Samira",
      text: "loved your report “Black canvas backpack”.",
      time: "5m ago",
    },
    {
      id: "fx-n2",
      username: LONG_USERNAME,
      displayName: LONG_USERNAME,
      text: "commented: “I saw this near the front desk.”",
      time: "1h ago",
    },
    {
      id: "fx-n3",
      username: "",
      displayName: null,
      text: "Your report was marked as matched.",
      time: "Yesterday",
    },
  ];
  return (
    <ul className="flex flex-col gap-3">
      {rows.map((row) => (
        <li key={row.id} className="flex min-w-0 items-start gap-2.5">
          <UserAvatar
            avatarUrl={null}
            username={row.username || null}
            size={36}
          />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">
              {row.displayName ?? "FindBack"}
            </p>
            <p className="text-sm">{row.text}</p>
            <p className="text-xs text-on-surface-variant">{row.time}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * Social preflight: comments/composer (`CommentComposer`), notifications
 * (avatar rows), search (compact-density `PostList`), My Reports
 * (owner-feed `PostList`). All use ACTUAL production components.
 */
export function SocialFixtures() {
  return (
    <>
      <FixtureSection
        id="comments"
        title="Comments & composer"
        description="Production CommentComposer plus static thread rows across states."
      >
        <FixtureFrame section="comments" variant="normal">
          <div className="flex flex-col gap-4">
            <ul className="flex flex-col gap-3">
              {fixtureComments.map((comment) => (
                <li key={comment.id} className="flex min-w-0 gap-2.5">
                  <UserAvatar
                    avatarUrl={comment.avatarUrl}
                    username={comment.username || null}
                    size={32}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">
                      {comment.displayName ?? "Someone"}
                    </p>
                    <p className="text-sm">{comment.body}</p>
                  </div>
                </li>
              ))}
            </ul>
            <CommentComposer
              postId={detailPost.id}
              participants={[]}
              onSubmit={noopSubmit}
              onError={noopError}
            />
          </div>
        </FixtureFrame>
        <FixtureFrame section="comments" variant="loading">
          <Spinner label="Loading comments…" />
        </FixtureFrame>
        <FixtureFrame section="comments" variant="empty">
          <EmptyState
            title="No comments yet"
            subtitle="Be the first to help."
          />
        </FixtureFrame>
        <FixtureFrame section="comments" variant="error">
          <EmptyState title="Could not load" subtitle={STRINGS.loadingError} />
        </FixtureFrame>
        <FixtureFrame section="comments" variant="long-content">
          <CommentComposer
            postId={detailPost.id}
            replyToUsername={LONG_USERNAME}
            participants={[]}
            onSubmit={noopSubmit}
            onError={noopError}
          />
        </FixtureFrame>
        <FixtureFrame section="comments" variant="large-text">
          <CommentComposer
            postId={detailPost.id}
            participants={[]}
            onSubmit={noopSubmit}
            onError={noopError}
          />
        </FixtureFrame>
        <FixtureFrame section="comments" variant="dark">
          <CommentComposer
            postId={detailPost.id}
            participants={[]}
            onSubmit={noopSubmit}
            onError={noopError}
          />
        </FixtureFrame>
        <FixtureFrame section="comments" variant="amoled">
          <CommentComposer
            postId={detailPost.id}
            participants={[]}
            disabled
            onSubmit={noopSubmit}
            onError={noopError}
          />
        </FixtureFrame>
        <FixtureFrame section="comments" variant="small-width">
          <CommentComposer
            postId={detailPost.id}
            replyToUsername={LONG_USERNAME}
            participants={[]}
            onSubmit={noopSubmit}
            onError={noopError}
          />
        </FixtureFrame>
      </FixtureSection>

      <FixtureSection
        id="notifications"
        title="Notifications"
        description="Production avatar rows for notification content across states."
      >
        <FixtureFrame section="notifications" variant="normal">
          <NotificationRows />
        </FixtureFrame>
        <FixtureFrame section="notifications" variant="loading">
          <Spinner label="Loading notifications…" />
        </FixtureFrame>
        <FixtureFrame section="notifications" variant="empty">
          <EmptyState
            title="No notifications"
            subtitle="Reactions, comments, and matches will show up here."
          />
        </FixtureFrame>
        <FixtureFrame section="notifications" variant="error">
          <EmptyState title="Could not load" subtitle={STRINGS.loadingError} />
        </FixtureFrame>
        <FixtureFrame section="notifications" variant="long-content">
          <NotificationRows />
        </FixtureFrame>
        <FixtureFrame section="notifications" variant="large-text">
          <NotificationRows />
        </FixtureFrame>
        <FixtureFrame section="notifications" variant="dark">
          <NotificationRows />
        </FixtureFrame>
        <FixtureFrame section="notifications" variant="amoled">
          <NotificationRows />
        </FixtureFrame>
        <FixtureFrame section="notifications" variant="small-width">
          <NotificationRows />
        </FixtureFrame>
      </FixtureSection>

      <FixtureSection
        id="search"
        title="Search"
        description="Production PostList at compact (search) density across states."
      >
        <FixtureFrame section="search" variant="normal">
          <PostList
            items={allHomeMatrixPosts.slice(0, 4)}
            loading={false}
            loadingMore={false}
            error={null}
            hasMore={false}
            onLoadMore={noopLoadMore}
            density="compact"
          />
        </FixtureFrame>
        <FixtureFrame section="search" variant="loading">
          <PostList
            items={[]}
            loading
            loadingMore={false}
            error={null}
            hasMore={false}
            onLoadMore={noopLoadMore}
            density="compact"
          />
        </FixtureFrame>
        <FixtureFrame section="search" variant="empty">
          <PostList
            items={[]}
            loading={false}
            loadingMore={false}
            error={null}
            hasMore={false}
            onLoadMore={noopLoadMore}
            density="compact"
            emptyTitle="No matches"
            emptySubtitle="Try different keywords or filters."
          />
        </FixtureFrame>
        <FixtureFrame section="search" variant="error">
          <PostList
            items={[]}
            loading={false}
            loadingMore={false}
            error={STRINGS.loadingError}
            hasMore={false}
            onLoadMore={noopLoadMore}
            density="compact"
            onRetry={noopLoadMore}
          />
        </FixtureFrame>
        <FixtureFrame section="search" variant="long-content">
          <PostList
            items={allHomeMatrixPosts}
            loading={false}
            loadingMore={false}
            error={null}
            hasMore={false}
            onLoadMore={noopLoadMore}
            density="compact"
          />
        </FixtureFrame>
        <FixtureFrame section="search" variant="large-text">
          <PostList
            items={allHomeMatrixPosts.slice(0, 3)}
            loading={false}
            loadingMore={false}
            error={null}
            hasMore={false}
            onLoadMore={noopLoadMore}
            density="compact"
          />
        </FixtureFrame>
        <FixtureFrame section="search" variant="dark">
          <PostList
            items={allHomeMatrixPosts.slice(0, 3)}
            loading={false}
            loadingMore={false}
            error={null}
            hasMore={false}
            onLoadMore={noopLoadMore}
            density="compact"
          />
        </FixtureFrame>
        <FixtureFrame section="search" variant="amoled">
          <PostList
            items={allHomeMatrixPosts.slice(0, 3)}
            loading={false}
            loadingMore={false}
            error={null}
            hasMore={false}
            onLoadMore={noopLoadMore}
            density="compact"
          />
        </FixtureFrame>
        <FixtureFrame section="search" variant="small-width">
          <PostList
            items={allHomeMatrixPosts.slice(0, 4)}
            loading={false}
            loadingMore={false}
            error={null}
            hasMore={false}
            onLoadMore={noopLoadMore}
            density="compact"
          />
        </FixtureFrame>
      </FixtureSection>

      <FixtureSection
        id="my-reports"
        title="My Reports"
        description="Production PostList at owner-feed density plus the classic owner card across states."
      >
        <FixtureFrame section="my-reports" variant="normal">
          <PostList
            items={allHomeMatrixPosts.slice(0, 3)}
            loading={false}
            loadingMore={false}
            error={null}
            hasMore={false}
            onLoadMore={noopLoadMore}
            density="owner-feed"
          />
        </FixtureFrame>
        <FixtureFrame section="my-reports" variant="loading">
          <PostList
            items={[]}
            loading
            loadingMore={false}
            error={null}
            hasMore={false}
            onLoadMore={noopLoadMore}
            density="owner-feed"
          />
        </FixtureFrame>
        <FixtureFrame section="my-reports" variant="empty">
          <PostList
            items={[]}
            loading={false}
            loadingMore={false}
            error={null}
            hasMore={false}
            onLoadMore={noopLoadMore}
            density="owner-feed"
            emptyTitle="No reports yet"
            emptySubtitle="Your published reports will appear here."
          />
        </FixtureFrame>
        <FixtureFrame section="my-reports" variant="error">
          <PostList
            items={[]}
            loading={false}
            loadingMore={false}
            error={STRINGS.loadingError}
            hasMore={false}
            onLoadMore={noopLoadMore}
            density="owner-feed"
            onRetry={noopLoadMore}
          />
        </FixtureFrame>
        <FixtureFrame section="my-reports" variant="long-content">
          <PostCard to="/posts/fx-detail" index={0}>
            <PostCardContent
              post={makePost("fx-owner-long", {
                title:
                  "Owner card with a very long title that must wrap honestly inside the owner layout",
              })}
              layout="classic"
            />
          </PostCard>
        </FixtureFrame>
        <FixtureFrame section="my-reports" variant="large-text">
          <PostList
            items={allHomeMatrixPosts.slice(0, 2)}
            loading={false}
            loadingMore={false}
            error={null}
            hasMore={false}
            onLoadMore={noopLoadMore}
            density="owner-feed"
          />
        </FixtureFrame>
        <FixtureFrame section="my-reports" variant="dark">
          <PostList
            items={allHomeMatrixPosts.slice(0, 2)}
            loading={false}
            loadingMore={false}
            error={null}
            hasMore={false}
            onLoadMore={noopLoadMore}
            density="owner-feed"
          />
        </FixtureFrame>
        <FixtureFrame section="my-reports" variant="amoled">
          <PostList
            items={allHomeMatrixPosts.slice(0, 2)}
            loading={false}
            loadingMore={false}
            error={null}
            hasMore={false}
            onLoadMore={noopLoadMore}
            density="owner-feed"
          />
        </FixtureFrame>
        <FixtureFrame section="my-reports" variant="small-width">
          <PostList
            items={allHomeMatrixPosts.slice(0, 3)}
            loading={false}
            loadingMore={false}
            error={null}
            hasMore={false}
            onLoadMore={noopLoadMore}
            density="owner-feed"
          />
        </FixtureFrame>
      </FixtureSection>
    </>
  );
}
