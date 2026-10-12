import { CommentComposer } from "../../components/CommentComposer";
import { MarkdownView } from "../../components/MarkdownView";
import { EmptyState, Spinner } from "../../components/PostCard";
import { PostCardContent } from "../../components/PostCardContent";
import { UserAvatar } from "../../components/UserAvatar";
import { FixtureFrame, FixtureSection } from "../FixtureSection";
import { LONG_DESCRIPTION, LONG_TITLE, detailPost, fixtureComments } from "../posts";

function noopSubmit(): Promise<void> {
  return Promise.resolve();
}

function noopError(): void {}

/** Static comment rows using the production avatar (detail thread shape). */
function CommentRows() {
  return (
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
            <p className="text-xs text-on-surface-variant">{comment.createdAt}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * Post-detail preflight. Uses the ACTUAL detail building blocks —
 * `PostCardContent`, `MarkdownView`, `UserAvatar`, `CommentComposer` —
 * rather than the data-bound `PostDetail` screen (which needs auth +
 * network and therefore cannot render deterministically here).
 */
export function DetailFixtures() {
  return (
    <FixtureSection
      id="detail"
      title="Post detail"
      description="Production detail blocks (gallery card, markdown body, comment thread, composer) across states."
    >
      <FixtureFrame section="detail" variant="normal">
        <div className="flex flex-col gap-4">
          <PostCardContent post={detailPost} layout="classic" />
          <CommentRows />
          <CommentComposer
            postId={detailPost.id}
            participants={[]}
            onSubmit={noopSubmit}
            onError={noopError}
          />
        </div>
      </FixtureFrame>
      <FixtureFrame section="detail" variant="loading">
        <Spinner label="Loading report…" />
      </FixtureFrame>
      <FixtureFrame section="detail" variant="empty">
        <EmptyState title="No comments yet" subtitle="Be the first to help." />
      </FixtureFrame>
      <FixtureFrame section="detail" variant="error">
        <EmptyState
          title="Could not load"
          subtitle="Fixture preflight — no network is used."
        />
      </FixtureFrame>
      <FixtureFrame section="detail" variant="long-content">
        <div className="flex flex-col gap-4">
          <PostCardContent
            post={{ ...detailPost, title: LONG_TITLE, description: LONG_DESCRIPTION }}
            layout="classic"
          />
          <MarkdownView text={LONG_DESCRIPTION} />
        </div>
      </FixtureFrame>
      <FixtureFrame section="detail" variant="large-text">
        <CommentRows />
      </FixtureFrame>
      <FixtureFrame section="detail" variant="dark">
        <div className="flex flex-col gap-4">
          <PostCardContent post={detailPost} layout="classic" />
          <CommentRows />
        </div>
      </FixtureFrame>
      <FixtureFrame section="detail" variant="amoled">
        <CommentComposer
          postId={detailPost.id}
          participants={[]}
          onSubmit={noopSubmit}
          onError={noopError}
        />
      </FixtureFrame>
      <FixtureFrame section="detail" variant="small-width">
        <div className="flex flex-col gap-4">
          <PostCardContent
            post={{ ...detailPost, title: LONG_TITLE }}
            layout="classic"
          />
          <CommentRows />
          <CommentComposer
            postId={detailPost.id}
            participants={[]}
            onSubmit={noopSubmit}
            onError={noopError}
          />
        </div>
      </FixtureFrame>
    </FixtureSection>
  );
}
