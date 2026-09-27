import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router";
import { ExternalLink, ThumbsDown, ThumbsUp, Trash2 } from "lucide-react";
import type { CommentItem, PostItem, PostStatus } from "@findback/shared";
import { POST_STATUSES } from "@findback/shared";
import { useAuth } from "../auth";
import { BackButton } from "../components/BackButton";
import { Button } from "../components/Button";
import { Segmented, statusLabel } from "../components/Segmented";
import { YouTubeEmbed } from "../components/YouTubeEmbed";
import { InteractiveLocationMap } from "../components/InteractiveLocationMap";
import { EmptyState, Spinner } from "../components/PostCard";
import { MarkdownView } from "../components/MarkdownView";
import { RatingStars } from "../components/RatingStars";
import { PossibleMatches } from "../components/PossibleMatches";
import { announce } from "../components/LiveRegion";
import { friendlyError } from "../utils/friendlyErrors";
import { recordLoadTiming } from "../utils/loadTiming";
import { openInMaps } from "../utils/location";
import { formatEventDate, formatTimestamp } from "../utils/dates";
import {
  addComment,
  deleteComment,
  fetchComments,
  fetchPost,
  fetchSocialState,
  ratePost,
  reactToPost,
  updatePostStatus,
} from "../services/posts";
import {
  joinPostRoom,
  leavePostRoom,
  onRealtime,
} from "../services/realtime";

interface GalleryImage {
  fileUrl: string;
}

/**
 * Ordered 1..5 photo gallery. A single photo keeps the legacy rendering;
 * multiple photos get a main view + an explicit thumbnail strip (48dp
 * targets, no motion). Read-only: no reorder/remove here.
 */
function PostGallery({ title, images }: { title: string; images: GalleryImage[] }) {
  const [selected, setSelected] = useState(0);
  if (images.length === 0) return null;
  if (images.length === 1) {
    return (
      <img
        src={images[0]!.fileUrl}
        alt={`Photo for ${title}`}
        className="max-h-72 w-full rounded-m3-md border border-outline-variant object-contain"
      />
    );
  }
  const safeSelected = Math.min(selected, images.length - 1);
  const current = images[safeSelected]!;
  return (
    <figure className="flex flex-col gap-2">
      <img
        src={current.fileUrl}
        alt={`Photo ${safeSelected + 1} of ${images.length} for ${title}`}
        className="max-h-72 w-full rounded-m3-md border border-outline-variant object-contain"
      />
      <figcaption className="text-xs text-on-surface-variant" role="status">
        Photo {safeSelected + 1} of {images.length}
      </figcaption>
      <div role="group" aria-label="Report photos" className="flex gap-2 overflow-x-auto pb-1">
        {images.map((img, i) => (
          <button
            key={`${img.fileUrl}#${i}`}
            type="button"
            onClick={() => setSelected(i)}
            aria-label={`Show photo ${i + 1}`}
            aria-pressed={i === safeSelected}
            className={`flex min-h-[48px] min-w-[48px] items-center justify-center rounded-m3-sm border p-1 ${
              i === safeSelected ? "border-on-surface" : "border-outline-variant"
            }`}
          >
            <img src={img.fileUrl} alt="" aria-hidden className="h-12 w-12 rounded-m3-xs object-cover" />
          </button>
        ))}
      </div>
    </figure>
  );
}

export function PostDetail() {
  const { id = "" } = useParams();
  const { user } = useAuth();
  const [post, setPost] = useState<PostItem | null>(null);
  const [comments, setComments] = useState<CommentItem[]>([]);
  const [myReaction, setMyReaction] = useState<"LIKE" | "DISLIKE" | null>(null);
  const [myRating, setMyRating] = useState<number | null>(null);
  const [commentText, setCommentText] = useState("");
  const [busy, setBusy] = useState(false);
  // Post shell state: the article renders as soon as the post resolves.
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Independent secondary states: comments/social hydrate on their own and
  // never block the post shell.
  const [commentsLoading, setCommentsLoading] = useState(true);
  const [commentsError, setCommentsError] = useState<string | null>(null);
  const [socialLoading, setSocialLoading] = useState(true);
  const [socialError, setSocialError] = useState<string | null>(null);

  // Sequence tokens for latest-request-wins mutation sequencing
  const reactionSeq = useRef(0);
  const ratingSeq = useRef(0);
  const statusSeq = useRef(0);
  // Generation guard: only the current post id / reload may apply results.
  const loadGen = useRef(0);
  // Per-section retry tokens: retries reuse the same generation, so each
  // comments/social request carries its own latest-request-wins sequence.
  const commentsSeq = useRef(0);
  const socialSeq = useRef(0);
  const postPresentRef = useRef(false);
  // Track in-flight mutations to disable owner controls
  const [mutationActive, setMutationActive] = useState<"reaction" | "rating" | "status" | null>(null);

  const loadPost = useCallback(
    async (gen: number) => {
      const startedAt = Date.now();
      try {
        const p = await fetchPost(id);
        recordLoadTiming("post", Date.now() - startedAt);
        if (loadGen.current !== gen) return;
        postPresentRef.current = true;
        setError(null);
        setPost(p);
      } catch (err) {
        recordLoadTiming("post", Date.now() - startedAt);
        if (loadGen.current !== gen) return;
        setError(friendlyError(err).message);
      } finally {
        if (loadGen.current === gen) setLoading(false);
      }
    },
    [id],
  );

  const loadComments = useCallback(
    async (gen: number, seq: number) => {
      const startedAt = Date.now();
      try {
        const cs = await fetchComments(id);
        recordLoadTiming("comments", Date.now() - startedAt);
        if (loadGen.current !== gen || commentsSeq.current !== seq) return;
        setCommentsError(null);
        setComments(cs);
      } catch (err) {
        recordLoadTiming("comments", Date.now() - startedAt);
        if (loadGen.current !== gen || commentsSeq.current !== seq) return;
        setCommentsError(friendlyError(err).message);
      } finally {
        if (loadGen.current === gen && commentsSeq.current === seq) setCommentsLoading(false);
      }
    },
    [id],
  );

  const loadSocial = useCallback(
    async (gen: number, seq: number) => {
      const startedAt = Date.now();
      try {
        const social = await fetchSocialState(id);
        recordLoadTiming("social", Date.now() - startedAt);
        if (loadGen.current !== gen || socialSeq.current !== seq) return;
        setSocialError(null);
        setMyReaction(social.myReaction);
        setMyRating(social.myRating);
      } catch (err) {
        recordLoadTiming("social", Date.now() - startedAt);
        if (loadGen.current !== gen || socialSeq.current !== seq) return;
        setSocialError(friendlyError(err).message);
      } finally {
        if (loadGen.current === gen && socialSeq.current === seq) setSocialLoading(false);
      }
    },
    [id],
  );

  // Start post/comments/social in parallel; each section reconciles on its
  // own generation-guarded resolution so the post never waits on the
  // secondaries. A reload with a visible post keeps it on screen.
  const load = useCallback(async () => {
    const gen = ++loadGen.current;
    const cSeq = ++commentsSeq.current;
    const sSeq = ++socialSeq.current;
    if (!postPresentRef.current) setLoading(true);
    setCommentsLoading(true);
    setSocialLoading(true);
    setError(null);
    setCommentsError(null);
    setSocialError(null);
    void loadPost(gen);
    void loadComments(gen, cSeq);
    void loadSocial(gen, sSeq);
  }, [loadPost, loadComments, loadSocial]);

  const retryComments = useCallback(() => {
    const gen = loadGen.current;
    const seq = ++commentsSeq.current;
    setCommentsLoading(true);
    setCommentsError(null);
    void loadComments(gen, seq);
  }, [loadComments]);

  const retrySocial = useCallback(() => {
    const gen = loadGen.current;
    const seq = ++socialSeq.current;
    setSocialLoading(true);
    setSocialError(null);
    void loadSocial(gen, seq);
  }, [loadSocial]);

  useEffect(() => {
    void load();
  }, [load]);

  // Live updates while viewing this post (no refresh).
  useEffect(() => {
    joinPostRoom(id);
    const offs = [
      onRealtime("comment:added", (payload) => {
        const p = payload as { comment: CommentItem };
        setComments((prev) => (prev.some((c) => c.id === p.comment.id) ? prev : [...prev, p.comment]));
      }),
      onRealtime("comment:deleted", (payload) => {
        const p = payload as { commentId: string };
        setComments((prev) => prev.filter((c) => c.id !== p.commentId));
      }),
      onRealtime("reaction:changed", (payload) => {
        const p = payload as { postId: string; likeCount: number; dislikeCount: number };
        if (p.postId !== id) return;
        setPost((prev) =>
          prev ? { ...prev, likeCount: p.likeCount, dislikeCount: p.dislikeCount } : prev,
        );
      }),
      onRealtime("rating:changed", (payload) => {
        const p = payload as { postId: string; ratingAvg: number | null; ratingCount: number };
        if (p.postId !== id) return;
        setPost((prev) => (prev ? { ...prev, ratingAvg: p.ratingAvg, ratingCount: p.ratingCount } : prev));
      }),
      onRealtime("post:updated", (payload) => {
        const p = payload as { postId: string };
        if (p.postId === id) void load();
      }),
    ];
    return () => {
      leavePostRoom(id);
      offs.forEach((off) => off());
    };
  }, [id, load]);

  if (loading) return <Spinner label="Loading post…" />;
  if (error && !post) return <EmptyState title="Post unavailable" subtitle={error} />;
  if (!post) return null;

  const current = post;
  const isOwner = user?.id === current.author.id;

  async function toggleReaction(type: "LIKE" | "DISLIKE") {
    const next = myReaction === type ? null : type;
    // Optimistic update
    setMyReaction(next);
    // Increment sequence token - only the latest request's response will be applied
    const seq = ++reactionSeq.current;
    setMutationActive("reaction");
    try {
      const res = await reactToPost(current.id, next);
      // Only apply if this is still the latest request
      if (reactionSeq.current === seq) {
        setPost((prev) =>
          prev ? { ...prev, likeCount: res.likeCount, dislikeCount: res.dislikeCount } : prev,
        );
      }
    } catch (e) {
      // Only rollback if this is still the latest request
      if (reactionSeq.current === seq) {
        setMyReaction(myReaction);
        setError(friendlyError(e).message);
      }
    } finally {
      // Functional clear: the closure holds the pre-mutation value, so a
      // direct comparison would never reset and lock the owner controls.
      setMutationActive((cur) => (cur === "reaction" ? null : cur));
    }
  }

  async function onRate(score: number) {
    // Optimistic update
    setMyRating(score);
    // Increment sequence token - only the latest request's response will be applied
    const seq = ++ratingSeq.current;
    setMutationActive("rating");
    try {
      const res = await ratePost(current.id, score);
      // Only apply if this is still the latest request
      if (ratingSeq.current === seq) {
        setPost((prev) =>
          prev ? { ...prev, ratingAvg: res.ratingAvg, ratingCount: res.ratingCount } : prev,
        );
      }
    } catch (e) {
      // Only rollback if this is still the latest request
      if (ratingSeq.current === seq) {
        setMyRating(myRating);
        setError(friendlyError(e).message);
      }
    } finally {
      // Functional clear (see toggleReaction): never leave controls stuck.
      setMutationActive((cur) => (cur === "rating" ? null : cur));
    }
  }

  async function onComment(e: React.FormEvent) {
    e.preventDefault();
    const body = commentText.trim();
    if (!body) return;
    // Defensive client-side limit (backend is authoritative).
    if (body.length > 1000) return;
    setBusy(true);
    try {
      const comment = await addComment(current.id, body);
      setComments((prev) => (prev.some((c) => c.id === comment.id) ? prev : [...prev, comment]));
      setCommentText("");
    } catch (err) {
      setError(friendlyError(err).message);
    } finally {
      setBusy(false);
    }
  }

  async function onDeleteComment(commentId: string) {
    try {
      await deleteComment(current.id, commentId);
      setComments((prev) => prev.filter((c) => c.id !== commentId));
    } catch (err) {
      setError(friendlyError(err).message);
    }
  }

  async function onChangeStatus(status: PostStatus) {
    // Recovered/Closed are terminal for the searcher: confirm explicitly.
    // All other transitions stay direct. No new statuses are introduced.
    if ((status === "RECOVERED" || status === "CLOSED") && current.status !== status) {
      const ok = window.confirm(
        status === "RECOVERED"
          ? "Mark this report as recovered? It will leave the open search."
          : "Close this report? It will leave the open search.",
      );
      if (!ok) return;
    }
    // Increment sequence token - only the latest request's response will be applied
    const seq = ++statusSeq.current;
    setMutationActive("status");
    try {
      const updated = await updatePostStatus(current.id, status);
      // Only apply if this is still the latest request
      if (statusSeq.current === seq) {
        setPost(updated);
        announce(`Status updated to ${statusLabel(updated.status)}.`);
      }
    } catch (err) {
      // Only show error if this is still the latest request
      if (statusSeq.current === seq) {
        setError(friendlyError(err).message);
      }
    } finally {
      // Functional clear (see toggleReaction): the owner control must unlock
      // so a confirmed Recovered/Closed can be followed by another change.
      setMutationActive((cur) => (cur === "status" ? null : cur));
    }
  }

  const images = post.attachments.filter((a) => a.mimeType.startsWith("image/"));

  // Owner status control is disabled while any mutation is active
  const ownerControlsDisabled = mutationActive !== null;

  return (
    <div className="flex flex-col gap-5">
      <header className="flex items-center gap-3 px-4 pt-5">
        <BackButton fallbackTo="/" label="Back to feed" />
        <span className="rounded-full border border-outline px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide">
          {post.type === "LOST" ? "Lost item" : "Found item"}
        </span>
        <span className="text-xs text-on-surface-variant">Posted {formatTimestamp(post.createdAt)}</span>
      </header>

      {error && (
        <p className="mx-4 rounded-m3-sm border border-error px-3 py-2 text-sm text-error">{error}</p>
      )}

      <article className="flex flex-col gap-4 px-4">
        {/* key remounts the gallery per post: selection resets without a
            reset effect, so a thumbnail click can never be clobbered by a
            still-pending passive effect after the gallery first paints. */}
        <PostGallery key={post.id} title={post.title} images={images} />

        <div>
          <h1 className="break-words text-2xl font-semibold leading-tight tracking-tight">{post.title}</h1>
          <p className="mt-1 text-sm text-on-surface-variant">
            @{post.author.username} · {post.category}
          </p>
        </div>

        <MarkdownView text={post.description} />

        {post.status === "OPEN" && <PossibleMatches post={post} />}

        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-m3-md border border-outline-variant bg-surface-container-low p-4 text-sm">
          <div>
            <dt className="text-xs text-on-surface-variant">Status</dt>
            <dd className="font-medium">{statusLabel(post.status)}</dd>
          </div>
          <div>
            <dt className="text-xs text-on-surface-variant">{post.type === "LOST" ? "Lost on" : "Found on"}</dt>
            <dd className="font-medium">{formatEventDate(post.eventDate)}</dd>
          </div>
          <div className="col-span-2">
            <dt className="text-xs text-on-surface-variant">Location</dt>
            <dd className="break-words font-medium">
              {post.locationLabel ?? (post.latitude != null ? "Pinned location" : "Not specified")}
            </dd>
            {(post.latitude != null || post.locationLabel) && (
              <dd className="mt-1">
                <Button
                  type="button"
                  variant="text"
                  size="md"
                  onClick={() => void openInMaps(post.latitude, post.longitude, post.locationLabel ?? "")}
                >
                  <ExternalLink size={14} aria-hidden /> Open in Maps
                </Button>
              </dd>
            )}
          </div>
        </dl>

        {post.youtubeUrl && <YouTubeEmbed url={post.youtubeUrl} />}

        {(post.latitude != null || post.locationLabel) && (
          <InteractiveLocationMap lat={post.latitude} lng={post.longitude} label={post.locationLabel} />
        )}

        {/* Reactions hydrate independently; the post never waits on them. */}
        {socialLoading && (
          <p role="status" className="text-sm text-on-surface-variant">
            Loading reactions…
          </p>
        )}
        {socialError && (
          <div className="flex items-center justify-between gap-2 rounded-m3-sm border border-error px-3 py-2 text-sm text-error">
            <span>Could not load reactions: {socialError}</span>
            <button
              type="button"
              onClick={retrySocial}
              className="min-h-[48px] shrink-0 px-3 font-medium underline"
            >
              Retry
            </button>
          </div>
        )}
        <div className="flex items-center gap-3">
          <Button
            variant={myReaction === "LIKE" ? "primary" : "outline"}
            onClick={() => toggleReaction("LIKE")}
            aria-label={`Helpful, ${post.likeCount} ${post.likeCount === 1 ? "vote" : "votes"}`}
            aria-pressed={myReaction === "LIKE"}
          >
            <ThumbsUp size={16} aria-hidden /> {post.likeCount}
          </Button>
          <Button
            variant={myReaction === "DISLIKE" ? "primary" : "outline"}
            onClick={() => toggleReaction("DISLIKE")}
            aria-label={`Not helpful, ${post.dislikeCount} ${post.dislikeCount === 1 ? "vote" : "votes"}`}
            aria-pressed={myReaction === "DISLIKE"}
          >
            <ThumbsDown size={16} aria-hidden /> {post.dislikeCount}
          </Button>
        </div>

        {/* Rating: community average and the user's own rating are separate. */}
        <section aria-label="Rating">
          <p className="text-sm text-on-surface" aria-live="polite">
            {post.ratingCount > 0
              ? `Community rating: ${post.ratingAvg?.toFixed(1) ?? "—"} / 5 from ${post.ratingCount} rating${post.ratingCount === 1 ? "" : "s"}`
              : "No community ratings yet — be the first to rate."}
          </p>
          <p className="mt-2 text-sm font-medium" id="your-rating-label">
            Your rating{myRating != null ? `: ${myRating} out of 5` : ""}
          </p>
          <RatingStars value={myRating} onRate={onRate} labelId="your-rating-label" />
        </section>

        {/* Owner status control */}
        {isOwner && (
          <section className="rounded-m3-md border border-outline-variant p-3">
            <p className="mb-2 text-sm font-medium">Update status (owner only)</p>
            <Segmented<PostStatus>
              ariaLabel="Post status"
              value={post.status}
              onChange={onChangeStatus}
              options={POST_STATUSES.map((s) => ({ value: s, label: statusLabel(s) }))}
              disabled={ownerControlsDisabled}
            />
          </section>
        )}
      </article>

      {/* Comments */}
      <section className="flex flex-col gap-3 px-4" aria-label="Comments">
        <h2 className="text-base font-semibold">
          Comments <span className="text-on-surface-variant">({comments.length})</span>
        </h2>

        <form onSubmit={onComment} className="flex items-start gap-2">
          <input
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
            placeholder="Write a helpful comment…"
            aria-label="Comment"
            maxLength={1000}
            className="w-full rounded-m3-sm border border-outline-variant bg-surface px-3.5 py-3 text-sm placeholder:text-on-surface-variant focus:border-on-surface focus:outline-none"
          />
          <Button type="submit" loading={busy} disabled={!commentText.trim()}>
            Post
          </Button>
        </form>

        {commentsLoading ? (
          <p role="status" className="text-sm text-on-surface-variant">
            Loading comments…
          </p>
        ) : commentsError ? (
          <div className="flex items-center justify-between gap-2 rounded-m3-sm border border-error px-3 py-2 text-sm text-error">
            <span>Could not load comments: {commentsError}</span>
            <button
              type="button"
              onClick={retryComments}
              className="min-h-[48px] shrink-0 px-3 font-medium underline"
            >
              Retry
            </button>
          </div>
        ) : (
          <>
            {comments.length === 0 && (
              <p className="text-sm text-on-surface-variant">No comments yet.</p>
            )}
            <ul className="flex flex-col gap-3">
              {comments.map((c) => {
                const canDelete = c.author.id === user?.id || isOwner;
                return (
                  <li key={c.id} className="rounded-m3-md border border-outline-variant p-3">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm font-semibold">@{c.author.username}</span>
                      <span className="shrink-0 text-[11px] text-on-surface-variant">
                        {formatTimestamp(c.createdAt)}
                      </span>
                    </div>
                    <div className="mt-1 text-sm leading-relaxed">
                      <MarkdownView text={c.body} />
                    </div>
                    {canDelete && (
                      <button
                        type="button"
                        onClick={() => onDeleteComment(c.id)}
                        aria-label={`Delete comment by ${c.author.username}`}
                        className="mt-2 inline-flex min-h-[48px] items-center gap-1 px-2 text-xs text-on-surface-variant hover:text-error"
                      >
                        <Trash2 size={13} aria-hidden /> Delete
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </section>

      <div className="h-4" aria-hidden />
    </div>
  );
}
