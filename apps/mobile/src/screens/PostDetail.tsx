import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router";
import { motion } from "framer-motion";
import { ExternalLink, Heart, MessageCircle, Share2, ThumbsDown, Trash2 } from "lucide-react";
import type { CommentItem, PostItem, PostStatus } from "@findback/shared";
import { POST_STATUSES } from "@findback/shared";
import { useAuth } from "../auth";
import { BackButton } from "../components/BackButton";
import { Button } from "../components/Button";
import { Segmented, statusLabel } from "../components/Segmented";
import { YouTubeEmbed } from "../components/YouTubeEmbed";
import { InteractiveLocationMap } from "../components/InteractiveLocationMap";
import { EmptyState, Spinner } from "../components/PostCard";
import {
  sharedElementTransition,
  sharedTitleLayoutId,
} from "../components/PostCardContent";
import { DetailHeroGallery } from "../components/detail/DetailHeroGallery";
import type { PhotoLightboxOriginRect } from "../components/PhotoLightbox";
import { PhotoLightbox } from "../components/PhotoLightbox";
import { MarkdownView } from "../components/MarkdownView";
import { RatingStars } from "../components/RatingStars";
import { PossibleMatches } from "../components/PossibleMatches";
import { announce } from "../components/LiveRegion";
import { friendlyError } from "../utils/friendlyErrors";
import { recordLoadTiming } from "../utils/loadTiming";
import { openInMaps } from "../utils/location";
import { formatEventDate, formatTimestamp } from "../utils/dates";
import { stripMarkdown } from "../utils/stripMarkdown";
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

/** Plain-text preview limit before "Show more" collapses the description. */
const DESCRIPTION_PREVIEW_LIMIT = 280;
/** Comments shown before "View all N comments" expands the list. */
const COMMENTS_PREVIEW_COUNT = 5;

function scrollToSection(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  const reduced =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ behavior: reduced ? "instant" : "smooth", block: "start" });
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
  // Mutation failures stay inline + announce; they never own the page.
  const [actionError, setActionError] = useState<string | null>(null);

  // Redesign UI state: collapsed description, lazy map/video, comment paging,
  // and the fullscreen lightbox position.
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  const [videoOpen, setVideoOpen] = useState(false);
  const [commentsExpanded, setCommentsExpanded] = useState(false);
  const [lightbox, setLightbox] = useState<{ index: number; origin: PhotoLightboxOriginRect | null } | null>(null);

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

  async function applyReaction(next: "LIKE" | "DISLIKE" | null) {
    const prev = myReaction;
    // Optimistic update
    setMyReaction(next);
    // Increment sequence token - only the latest request's response will be applied
    const seq = ++reactionSeq.current;
    setMutationActive("reaction");
    try {
      const res = await reactToPost(current.id, next);
      // Only apply if this is still the latest request
      if (reactionSeq.current === seq) {
        setPost((prevPost) =>
          prevPost ? { ...prevPost, likeCount: res.likeCount, dislikeCount: res.dislikeCount } : prevPost,
        );
      }
    } catch (e) {
      // Only rollback if this is still the latest request; failures stay
      // inline and never blow away the page.
      if (reactionSeq.current === seq) {
        setMyReaction(prev);
        const message = friendlyError(e).message;
        setActionError(message);
        announce(message);
      }
    } finally {
      // Functional clear: the closure holds the pre-mutation value, so a
      // direct comparison would never reset and lock the owner controls.
      setMutationActive((cur) => (cur === "reaction" ? null : cur));
    }
  }

  /** Heart Love/Unlove: LIKE ⇄ null; a DISLIKE switches to LIKE. */
  function toggleLove() {
    void applyReaction(myReaction === "LIKE" ? null : "LIKE");
  }

  /** Secondary "Not helpful" control (lives in the Community card). */
  function toggleDislike() {
    void applyReaction(myReaction === "DISLIKE" ? null : "DISLIKE");
  }

  async function onRate(score: number) {
    const prev = myRating;
    // Optimistic update
    setMyRating(score);
    // Increment sequence token - only the latest request's response will be applied
    const seq = ++ratingSeq.current;
    setMutationActive("rating");
    try {
      const res = await ratePost(current.id, score);
      // Only apply if this is still the latest request
      if (ratingSeq.current === seq) {
        setPost((prevPost) =>
          prevPost ? { ...prevPost, ratingAvg: res.ratingAvg, ratingCount: res.ratingCount } : prevPost,
        );
      }
    } catch (e) {
      // Only rollback if this is still the latest request
      if (ratingSeq.current === seq) {
        setMyRating(prev);
        const message = friendlyError(e).message;
        setActionError(message);
        announce(message);
      }
    } finally {
      // Functional clear (see applyReaction): never leave controls stuck.
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
      const message = friendlyError(err).message;
      setActionError(message);
      announce(message);
    } finally {
      setBusy(false);
    }
  }

  async function onDeleteComment(commentId: string) {
    try {
      await deleteComment(current.id, commentId);
      setComments((prev) => prev.filter((c) => c.id !== commentId));
    } catch (err) {
      const message = friendlyError(err).message;
      setActionError(message);
      announce(message);
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
        const message = friendlyError(err).message;
        setActionError(message);
        announce(message);
      }
    } finally {
      // Functional clear (see applyReaction): the owner control must unlock
      // so a confirmed Recovered/Closed can be followed by another change.
      setMutationActive((cur) => (cur === "status" ? null : cur));
    }
  }

  async function onShare() {
    const url = window.location.href;
    try {
      if (typeof navigator.share === "function") {
        await navigator.share({ title: current.title, url });
        announce("Link shared.");
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        announce("Link copied to clipboard.");
      } else {
        setActionError("Sharing is not supported on this device.");
      }
    } catch (e) {
      if ((e as DOMException)?.name === "AbortError") {
        announce("Share dismissed.");
        return;
      }
      // Share sheet failed: fall back to copying the link.
      try {
        await navigator.clipboard.writeText(url);
        announce("Link copied to clipboard.");
      } catch {
        const message = friendlyError(e).message;
        setActionError(message);
        announce(message);
      }
    }
  }

  const images = post.attachments.filter((a) => a.mimeType.startsWith("image/"));
  const lightboxPhotos = images.map((a) => ({ id: a.id, previewUrl: a.fileUrl }));

  // Owner status control is disabled while any mutation is active
  const ownerControlsDisabled = mutationActive !== null;

  const strippedDescription = stripMarkdown(current.description ?? "");
  const descriptionIsLong = strippedDescription.length > DESCRIPTION_PREVIEW_LIMIT;
  const descriptionPreview = descriptionIsLong
    ? `${strippedDescription.slice(0, DESCRIPTION_PREVIEW_LIMIT).trimEnd()}…`
    : strippedDescription;

  const visibleComments =
    commentsExpanded || comments.length <= COMMENTS_PREVIEW_COUNT
      ? comments
      : comments.slice(0, COMMENTS_PREVIEW_COUNT);

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
            reset effect, so a swipe can never be clobbered by a still-pending
            passive effect after the gallery first paints. */}
        <DetailHeroGallery
          key={post.id}
          postId={post.id}
          title={post.title}
          images={images}
          onOpenLightbox={(index, origin) => setLightbox({ index, origin })}
        />

        {/* Primary info card */}
        <section aria-label="Report summary" className="flex flex-col gap-2">
          <div>
            {/* Shared-element pair for the card title (see PostCardContent). */}
            <motion.h1
              className="break-words text-2xl font-semibold leading-tight tracking-tight"
              layoutId={sharedTitleLayoutId(post.id)}
              data-shared-title={sharedTitleLayoutId(post.id)}
              transition={sharedElementTransition}
            >
              {post.title}
            </motion.h1>
            <p className="mt-1 text-sm text-on-surface-variant">
              @{post.author.username} · {post.category}
            </p>
          </div>

          {descriptionIsLong && !descriptionExpanded ? (
            <div>
              <p className="line-clamp-5 whitespace-pre-line break-words text-sm leading-relaxed">
                {descriptionPreview}
              </p>
              <button
                type="button"
                onClick={() => setDescriptionExpanded(true)}
                aria-expanded="false"
                className="mt-1 min-h-[48px] px-1 text-sm font-medium text-on-surface underline"
              >
                Show more
              </button>
            </div>
          ) : descriptionIsLong ? (
            <div>
              <MarkdownView text={post.description} />
              <button
                type="button"
                onClick={() => setDescriptionExpanded(false)}
                aria-expanded="true"
                className="mt-1 min-h-[48px] px-1 text-sm font-medium text-on-surface underline"
              >
                Show less
              </button>
            </div>
          ) : (
            <MarkdownView text={post.description} />
          )}
        </section>

        {/* Social action row: Love + Comments + Share (no share count). */}
        <div className="flex items-center gap-2" role="group" aria-label="Report actions">
          <Button
            variant={myReaction === "LIKE" ? "primary" : "outline"}
            onClick={toggleLove}
            aria-label={`Love, ${post.likeCount} ${post.likeCount === 1 ? "vote" : "votes"}`}
            aria-pressed={myReaction === "LIKE"}
          >
            <Heart size={16} aria-hidden /> {post.likeCount}
          </Button>
          <Button
            variant="outline"
            onClick={() => scrollToSection("detail-comments")}
            aria-label={`Comments, ${comments.length}`}
          >
            <MessageCircle size={16} aria-hidden /> {comments.length}
          </Button>
          <Button variant="outline" onClick={() => void onShare()} aria-label="Share report">
            <Share2 size={16} aria-hidden /> Share
          </Button>
        </div>

        {actionError && (
          <div className="flex items-center justify-between gap-2 rounded-m3-sm border border-error px-3 py-2 text-sm text-error">
            <span role="alert">{actionError}</span>
            <button
              type="button"
              onClick={() => setActionError(null)}
              className="min-h-[48px] shrink-0 px-3 font-medium underline"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Owner management sits early, right after summary/actions. */}
        {isOwner && (
          <section aria-label="Manage report" className="rounded-m3-md border border-outline-variant p-3">
            <p className="mb-1 text-sm">
              Current status: <strong>{statusLabel(post.status)}</strong>
            </p>
            <p className="mb-2 text-sm font-medium">Manage report (owner only)</p>
            <Segmented<PostStatus>
              ariaLabel="Post status"
              value={post.status}
              onChange={(s) => void onChangeStatus(s)}
              options={POST_STATUSES.map((s) => ({ value: s, label: statusLabel(s) }))}
              disabled={ownerControlsDisabled}
            />
          </section>
        )}

        {/* Section anchors: vertical scroll only, never a tab-carousel. */}
        <nav aria-label="Report sections" className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => scrollToSection("detail-overview")}
            className="min-h-[48px] flex-1 rounded-m3-sm border border-outline-variant px-3 text-sm font-medium"
          >
            Overview
          </button>
          <button
            type="button"
            onClick={() => scrollToSection("detail-matches")}
            className="min-h-[48px] flex-1 rounded-m3-sm border border-outline-variant px-3 text-sm font-medium"
          >
            Matches
          </button>
          <button
            type="button"
            onClick={() => scrollToSection("detail-comments")}
            className="min-h-[48px] flex-1 rounded-m3-sm border border-outline-variant px-3 text-sm font-medium"
          >
            Comments
          </button>
        </nav>

        {/* Overview: compact lazy heavy sections. */}
        <section data-testid="detail-overview" id="detail-overview" aria-label="Overview" className="flex flex-col gap-3">
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
                <dd className="mt-1 flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="text"
                    size="md"
                    onClick={() => void openInMaps(post.latitude, post.longitude, post.locationLabel ?? "")}
                  >
                    <ExternalLink size={14} aria-hidden /> Open in Maps
                  </Button>
                  <Button
                    type="button"
                    variant="text"
                    size="md"
                    onClick={() => setMapOpen((o) => !o)}
                    aria-expanded={mapOpen}
                  >
                    {mapOpen ? "Hide map" : "View map"}
                  </Button>
                </dd>
              )}
            </div>
          </dl>

          {/* MapLibre mounts only after the disclosure opens. */}
          {mapOpen && (post.latitude != null || post.locationLabel) && (
            <InteractiveLocationMap lat={post.latitude} lng={post.longitude} label={post.locationLabel} />
          )}

          {/* YouTube mounts only after its disclosure opens. */}
          {post.youtubeUrl && (
            <div className="rounded-m3-md border border-outline-variant">
              <button
                type="button"
                onClick={() => setVideoOpen((o) => !o)}
                aria-expanded={videoOpen}
                className="flex min-h-[48px] w-full items-center justify-between px-3 text-sm font-medium"
              >
                Video attached
                <span aria-hidden>{videoOpen ? "▾" : "▸"}</span>
              </button>
              {videoOpen && (
                <div className="px-3 pb-3">
                  <YouTubeEmbed url={post.youtubeUrl} />
                </div>
              )}
            </div>
          )}

          {/* Community: reactions hydrate independently; the post never waits. */}
          <section aria-label="Community" className="flex flex-col gap-2 rounded-m3-md border border-outline-variant p-3">
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
            <p className="text-sm text-on-surface" aria-live="polite">
              {post.ratingCount > 0
                ? `Community rating: ${post.ratingAvg?.toFixed(1) ?? "—"} / 5 from ${post.ratingCount} rating${post.ratingCount === 1 ? "" : "s"}`
                : "No community ratings yet — be the first to rate."}
            </p>
            <p className="mt-1 text-sm font-medium" id="your-rating-label">
              Your rating{myRating != null ? `: ${myRating} out of 5` : ""}
            </p>
            <RatingStars value={myRating} onRate={(s) => void onRate(s)} labelId="your-rating-label" />
            <div className="mt-1">
              <Button
                variant={myReaction === "DISLIKE" ? "primary" : "outline"}
                onClick={toggleDislike}
                aria-label={`Not helpful, ${post.dislikeCount} ${post.dislikeCount === 1 ? "vote" : "votes"}`}
                aria-pressed={myReaction === "DISLIKE"}
              >
                <ThumbsDown size={16} aria-hidden /> {post.dislikeCount}
              </Button>
            </div>
          </section>
        </section>

        {/* Matches: dedicated compact section, async, never blocks the shell. */}
        <section id="detail-matches" aria-label="Matches" className="flex flex-col gap-2">
          <h2 className="text-base font-semibold">Matches</h2>
          <p className="text-sm text-on-surface-variant">
            Reports of the opposite type with similar details. Review them yourself before reaching out.
          </p>
          {post.status === "OPEN" && <PossibleMatches post={post} />}
          <p className="text-xs text-on-surface-variant" role="note">
            Suggestions, not confirmed matches.
          </p>
        </section>

        {/* Comments */}
        <section data-testid="detail-comments" id="detail-comments" aria-label="Comments" className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">
            Comments <span className="text-on-surface-variant">({comments.length})</span>
          </h2>

          <form onSubmit={(e) => void onComment(e)} className="flex items-start gap-2">
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
                {visibleComments.map((c) => {
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
                          onClick={() => void onDeleteComment(c.id)}
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
              {!commentsExpanded && comments.length > COMMENTS_PREVIEW_COUNT && (
                <button
                  type="button"
                  onClick={() => setCommentsExpanded(true)}
                  aria-expanded="false"
                  className="min-h-[48px] rounded-m3-sm border border-outline-variant px-3 text-sm font-medium"
                >
                  View all {comments.length} comments
                </button>
              )}
              {commentsExpanded && comments.length > COMMENTS_PREVIEW_COUNT && (
                <button
                  type="button"
                  onClick={() => setCommentsExpanded(false)}
                  aria-expanded="true"
                  className="min-h-[48px] rounded-m3-sm border border-outline-variant px-3 text-sm font-medium"
                >
                  Show fewer comments
                </button>
              )}
            </>
          )}
        </section>
      </article>

      {/* Full-image inspection: contain fit, swipe + arrows + keyboard. */}
      {lightbox && lightboxPhotos.length > 0 && (
        <PhotoLightbox
          photo={lightboxPhotos[Math.min(lightbox.index, lightboxPhotos.length - 1)]!}
          index={Math.min(lightbox.index, lightboxPhotos.length - 1)}
          total={lightboxPhotos.length}
          originRect={lightbox.origin}
          onClose={() => setLightbox(null)}
          onPrev={
            lightboxPhotos.length > 1
              ? () =>
                  setLightbox((lb) =>
                    lb ? { index: (lb.index - 1 + lightboxPhotos.length) % lightboxPhotos.length, origin: null } : lb,
                  )
              : undefined
          }
          onNext={
            lightboxPhotos.length > 1
              ? () =>
                  setLightbox((lb) =>
                    lb ? { index: (lb.index + 1) % lightboxPhotos.length, origin: null } : lb,
                  )
              : undefined
          }
        />
      )}

      <div className="h-4" aria-hidden />
    </div>
  );
}
