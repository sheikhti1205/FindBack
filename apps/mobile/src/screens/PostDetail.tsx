import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router";
import { ExternalLink, ThumbsDown, ThumbsUp, Trash2 } from "lucide-react";
import type { CommentItem, PostItem, PostStatus } from "@findback/shared";
import { POST_STATUSES } from "@findback/shared";
import { useAuth } from "../auth";
import { BackButton } from "../components/BackButton";
import { Button } from "../components/Button";
import { Segmented, statusLabel } from "../components/Segmented";
import { YouTubeEmbed } from "../components/YouTubeEmbed";
import { MapEmbed } from "../components/MapEmbed";
import { EmptyState, Spinner } from "../components/PostCard";
import { MarkdownView } from "../components/MarkdownView";
import { RatingStars } from "../components/RatingStars";
import { PossibleMatches } from "../components/PossibleMatches";
import { announce } from "../components/LiveRegion";
import { friendlyError } from "../utils/friendlyErrors";
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

export function PostDetail() {
  const { id = "" } = useParams();
  const { user } = useAuth();
  const [post, setPost] = useState<PostItem | null>(null);
  const [comments, setComments] = useState<CommentItem[]>([]);
  const [myReaction, setMyReaction] = useState<"LIKE" | "DISLIKE" | null>(null);
  const [myRating, setMyRating] = useState<number | null>(null);
  const [commentText, setCommentText] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [p, cs, social] = await Promise.all([
        fetchPost(id),
        fetchComments(id),
        fetchSocialState(id),
      ]);
      setError(null);
      setPost(p);
      setComments(cs);
      setMyReaction(social.myReaction);
      setMyRating(social.myRating);
    } catch (err) {
      setError(friendlyError(err).message);
    } finally {
      setLoading(false);
    }
  }, [id]);

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
    setMyReaction(next);
    try {
      const res = await reactToPost(current.id, next);
      setPost((prev) =>
        prev ? { ...prev, likeCount: res.likeCount, dislikeCount: res.dislikeCount } : prev,
      );
    } catch (e) {
      setMyReaction(myReaction);
      setError(friendlyError(e).message);
    }
  }

  async function onRate(score: number) {
    setMyRating(score);
    try {
      const res = await ratePost(current.id, score);
      setPost((prev) =>
        prev ? { ...prev, ratingAvg: res.ratingAvg, ratingCount: res.ratingCount } : prev,
      );
    } catch (e) {
      setMyRating(myRating);
      setError(friendlyError(e).message);
    }
  }

  async function onComment(e: React.FormEvent) {
    e.preventDefault();
    const body = commentText.trim();
    if (!body) return;
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
    try {
      const updated = await updatePostStatus(current.id, status);
      setPost(updated);
      announce(`Status updated to ${statusLabel(updated.status)}.`);
    } catch (err) {
      setError(friendlyError(err).message);
    }
  }

  const image = post.attachments.find((a) => a.mimeType.startsWith("image/"));

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
        {image && (
          <img src={image.fileUrl} alt={`Photo for ${post.title}`} className="max-h-72 w-full rounded-m3-md border border-outline-variant object-contain" />
        )}

        <div>
          <h1 className="text-2xl font-semibold leading-tight tracking-tight">{post.title}</h1>
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
            <dd className="font-medium">
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
          <MapEmbed lat={post.latitude} lng={post.longitude} label={post.locationLabel} />
        )}

        {/* Reactions */}
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
            className="w-full rounded-m3-sm border border-outline-variant bg-surface px-3.5 py-3 text-sm placeholder:text-on-surface-variant focus:border-on-surface focus:outline-none"
          />
          <Button type="submit" loading={busy} disabled={!commentText.trim()}>
            Post
          </Button>
        </form>

        {comments.length === 0 && (
          <p className="text-sm text-on-surface-variant">No comments yet.</p>
        )}
        <ul className="flex flex-col gap-3">
          {comments.map((c) => {
            const mine = c.author.id === user?.id || isOwner;
            return (
              <li key={c.id} className="rounded-m3-md border border-outline-variant p-3">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-semibold">@{c.author.username}</span>
                  <span className="text-[11px] text-on-surface-variant">
                    {formatTimestamp(c.createdAt)}
                  </span>
                </div>
                <div className="mt-1 text-sm leading-relaxed">
                  <MarkdownView text={c.body} />
                </div>
                {mine && (
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
      </section>

      <div className="h-4" aria-hidden />
    </div>
  );
}
