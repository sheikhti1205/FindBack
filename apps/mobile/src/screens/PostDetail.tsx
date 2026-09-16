import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { ArrowLeft, Star, ThumbsDown, ThumbsUp, Trash2 } from "lucide-react";
import type { CommentItem, PostItem, PostStatus } from "@findback/shared";
import { POST_STATUSES } from "@findback/shared";
import { useAuth } from "../auth";
import { Button } from "../components/Button";
import { Segmented, statusLabel } from "../components/Segmented";
import { YouTubeEmbed } from "../components/YouTubeEmbed";
import { MapEmbed } from "../components/MapEmbed";
import { EmptyState, Spinner } from "../components/PostCard";
import { PossibleMatches } from "../components/PossibleMatches";
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
      setError(err instanceof Error ? err.message : "Could not load post");
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
      setError(e instanceof Error ? e.message : "Action failed");
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
      setError(e instanceof Error ? e.message : "Rating failed");
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
      setError(err instanceof Error ? err.message : "Could not comment");
    } finally {
      setBusy(false);
    }
  }

  async function onDeleteComment(commentId: string) {
    try {
      await deleteComment(current.id, commentId);
      setComments((prev) => prev.filter((c) => c.id !== commentId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete comment");
    }
  }

  async function onChangeStatus(status: PostStatus) {
    try {
      const updated = await updatePostStatus(current.id, status);
      setPost(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update status");
    }
  }

  const image = post.attachments.find((a) => a.mimeType.startsWith("image/"));

  return (
    <div className="flex flex-col gap-5">
      <header className="flex items-center gap-3 px-4 pt-5">
        <Link
          to="/"
          aria-label="Back to feed"
          className="flex min-h-[40px] items-center rounded-m3-xs text-on-surface hover:bg-surface-container"
        >
          <ArrowLeft size={20} />
        </Link>
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

        <p className="whitespace-pre-line text-[15px] leading-relaxed">{post.description}</p>

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
            <dd className="font-medium">{post.locationLabel ?? "Not specified"}</dd>
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
          >
            <ThumbsUp size={16} aria-hidden /> {post.likeCount}
          </Button>
          <Button
            variant={myReaction === "DISLIKE" ? "primary" : "outline"}
            onClick={() => toggleReaction("DISLIKE")}
          >
            <ThumbsDown size={16} aria-hidden /> {post.dislikeCount}
          </Button>
        </div>

        {/* Rating */}
        <section aria-label="Rating">
          <div className="flex items-center gap-2">
            <div className="flex" role="radiogroup" aria-label="Rate this post (1 to 5 stars)">
              {[1, 2, 3, 4, 5].map((star) => (
                <button
                  key={star}
                  type="button"
                  role="radio"
                  aria-checked={myRating === star}
                  aria-label={`${star} star${star > 1 ? "s" : ""}`}
                  onClick={() => onRate(star)}
                  className="p-1 text-on-surface-variant hover:opacity-80"
                >
                  <Star
                    size={26}
                    aria-hidden
                    className={
                      (myRating ?? 0) >= star || (myRating === null && post.ratingAvg != null && post.ratingAvg >= star)
                        ? "fill-on-surface text-on-surface"
                        : ""
                    }
                  />
                </button>
              ))}
            </div>
          </div>
          <p className="mt-1 text-xs text-on-surface-variant">
            {post.ratingCount > 0
              ? `${post.ratingAvg?.toFixed(1) ?? "—"} / 5 from ${post.ratingCount} rating${post.ratingCount === 1 ? "" : "s"}`
              : "No ratings yet — be the first to rate."}
          </p>
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
                <p className="mt-1 text-sm leading-relaxed">{c.body}</p>
                {mine && (
                  <button
                    type="button"
                    onClick={() => onDeleteComment(c.id)}
                    className="mt-2 inline-flex items-center gap-1 text-xs text-on-surface-variant hover:text-error"
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
