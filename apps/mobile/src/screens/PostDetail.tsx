import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useParams } from "react-router";
import { motion } from "framer-motion";
import { CalendarDays, CornerDownRight, ExternalLink, Heart, MapPin, MessageCircle, Star, Tag, ThumbsDown, Trash2, X } from "lucide-react";
import type { CommentItem, PostItem, PostStatus, ReactionCounts, ReactionKind, ReactionSummary } from "@findback/shared";
import { POST_STATUSES } from "@findback/shared";
import { useAuth } from "../auth";
import { BackButton } from "../components/BackButton";
import { UserAvatar } from "../components/UserAvatar";
import { Button } from "../components/Button";
import { Segmented, statusLabel } from "../components/Segmented";
import { YouTubeEmbed } from "../components/YouTubeEmbed";
import { InteractiveLocationMap } from "../components/InteractiveLocationMap";
import { EmptyState } from "../components/PostCard";
import { CommentSkeleton, DetailSkeleton } from "../components/uiPrimitives";
import {
  sharedElementTransition,
  sharedTitleLayoutId,
} from "../components/PostCardContent";
import { DetailHeroGallery } from "../components/detail/DetailHeroGallery";
import type { PhotoLightboxOriginRect } from "../components/PhotoLightbox";
import { PhotoLightbox } from "../components/PhotoLightbox";
import { MarkdownView } from "../components/MarkdownView";
import { BlockedByViewerShield } from "../components/BlockedByViewerShield";
import { ReportReferenceCard } from "../components/ReportReferenceCard";
import { ReportPreviewProvider } from "../components/CommentReportPreviews";
import { CommentComposer } from "../components/CommentComposer";
import { commentMediaProvenance, parseCommentBody } from "../services/commentBodyMedia";
import { mapCommentAttachmentRefs } from "../services/commentAttachments";
import { RatingStars } from "../components/RatingStars";
import { ReportShareButton } from "../components/ReportShareButton";
import { PossibleMatches } from "../components/PossibleMatches";
import { announce } from "../components/LiveRegion";
import { listItemVariants, motionDurations, shouldReduceMotion } from "../components/uiMotion";
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
  type CommentAttachmentDescriptor,
} from "../services/posts";
import { seedSummaryFromItem } from "../services/feedReactions";
import {
  applyCountDeltas,
  likeState,
  nextLikeReaction,
  reactionCountsFromJson,
  reactionMoveDeltas,
  reactionSummaryFromCounts,
  setCommentReaction,
} from "../services/reactions";
import {
  joinPostRoom,
  leavePostRoom,
  onRealtime,
} from "../services/realtime";

/** Plain-text preview limit before "Show more" collapses the description. */
const DESCRIPTION_PREVIEW_LIMIT = 280;
/** Comments shown before "View all N comments" expands the list. */
const COMMENTS_PREVIEW_COUNT = 5;
/** Replies visible per thread before "View N more replies" (W3 inline threads). */
const COMMENT_FIRST_REPLIES = 2;
/** Incremental replies revealed per "View N more replies" tap (W3). */
const COMMENT_REPLIES_INCREMENT = 5;
/** Visual indent cap: deeper logical levels render flat with an @reply target. */
const COMMENT_MAX_VISUAL_DEPTH = 2;

function scrollToSection(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  // Override-aware (not OS-only): the persisted appearance Reduce Motion
  // setting layers on top of prefers-reduced-motion — see shouldReduceMotion.
  const reduced = shouldReduceMotion();
  el.focus({ preventScroll: true });
  el.scrollIntoView({ behavior: reduced ? "instant" : "smooth", block: "start" });
}

/**
 * Forward-provisioning for typed report references (I4b): the writer RPC
 * returns comment + author columns only, so the descriptors just sent are
 * merged onto the local comment and the card appears before any refetch.
 * Media descriptors are ignored here — they render from the body — and the
 * refs go through the same kind-gated mapper as the list path.
 */
export function withSentReportRefs(
  comment: CommentItem,
  attachments?: readonly CommentAttachmentDescriptor[],
): CommentItem {
  const refs = mapCommentAttachmentRefs(attachments);
  return refs.length ? { ...comment, attachments: refs } : comment;
}

/**
 * C2 per-comment Like control (packet `08` §2 — reactions are Like-only).
 *
 * One tap toggles the caller's Like (`LIKE`/null through the real comment RPC),
 * the count is the comment's positive-reaction total, and the heart is filled
 * for the caller's own Like. There is no tray, no chevron picker and no
 * long-press. Writes go through the parent's `onToggle`; failures revert there
 * and surface through the page's existing inline actionError + announce
 * pattern, so a failed Like is never silent.
 */
function CommentLikeButton({
  comment,
  summary,
  pending,
  onToggle,
}: {
  comment: CommentItem;
  summary: ReactionSummary;
  pending: boolean;
  onToggle: () => void;
}) {
  const state = likeState(summary);
  const label = `${state.mine ? "Liked" : "Like this comment"}, ${state.count} ${state.count === 1 ? "like" : "likes"}`;
  const mainId = `detail-comment-like-${comment.id}`;

  return (
    <button
      type="button"
      id={mainId}
      data-testid={`comment-react-${comment.id}`}
      aria-pressed={state.mine}
      aria-label={label}
      disabled={pending}
      aria-busy={pending}
      onClick={onToggle}
      className={`ml-auto inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-1 rounded-full px-2 text-xs font-medium ${state.mine ? "text-primary" : "text-on-surface-variant"}`}
    >
      <Heart size={15} aria-hidden fill={state.mine ? "currentColor" : "none"} />
      <span aria-hidden className="tabular-nums">{state.count}</span>
    </button>
  );
}

export function PostDetail() {
  const { id = "" } = useParams();
  const { hash, search, key: locationKey } = useLocation();
  const requestedComment = new URLSearchParams(search).get("comment");
  const linkedComment = requestedComment && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestedComment) ? requestedComment : null;
  const focusedLink = useRef<string | null>(null);
  const { user } = useAuth();
  const [post, setPost] = useState<PostItem | null>(null);
  const [comments, setComments] = useState<CommentItem[]>([]);
  // W3.3: the caller's reaction is any valid kind (LIKE/DISLIKE-era wire plus
  // canonical LOVE/HELPFUL/SUPPORT/WOW). LIKE reads as LOVE for display.
  const [myReaction, setMyReaction] = useState<ReactionKind | null>(null);
  const [myRating, setMyRating] = useState<number | null>(null);
  /**
   * Mention sources (W3.2): unique comment authors on this post rank first,
   * the report owner second, server prefix-search last (inside the
   * autocomplete). No reply-body prefill — parentId stays the reply relation.
   * Above the `if (!post)` guard: hooks must stay unconditional.
   */
  const mentionParticipants = useMemo(() => {
    const seen = new Set<string>();
    const out: { username: string; displayName?: string | null; avatarUrl?: string | null }[] = [];
    for (const c of comments) {
      const key = c.author.username.toLowerCase();
      if (!c.author.username || seen.has(key)) continue;
      seen.add(key);
      out.push({
        username: c.author.username,
        displayName: c.author.displayName ?? null,
        avatarUrl: c.author.avatarUrl ?? null,
      });
    }
    return out;
  }, [comments]);
  // Post shell state: the article renders as soon as the post resolves.
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Independent secondary states: comments/social hydrate on their own and
  // never block the post shell.
  const [commentsLoading, setCommentsLoading] = useState(true);
  const [commentsError, setCommentsError] = useState<string | null>(null);
  // Bumped on every applied list read: the report-preview map is dropped on a
  // refetch, so a resolved preview never outlives the list that produced it.
  const [commentsEpoch, setCommentsEpoch] = useState(0);
  const [socialLoading, setSocialLoading] = useState(true);
  const [socialError, setSocialError] = useState<string | null>(null);
  // Mutation failures stay inline + announce; they never own the page.
  const [actionError, setActionError] = useState<string | null>(null);

  // W3.3 multi-kind reaction UI state. The post summary override holds
  // server-truth counts/total once a write or realtime event delivers them;
  // otherwise the seeded summary (legacy buckets + own canonical kind) is
  // derived at render. Comment overrides are keyed by comment id and take
  // precedence over the fetched CommentItem.reactionSummary.
  const [postCountsOverride, setPostCountsOverride] = useState<{
    postId: string;
    counts: ReactionCounts;
    total: number;
  } | null>(null);
  const [commentSummaries, setCommentSummaries] = useState<Record<string, ReactionSummary>>({});
  const [commentPending, setCommentPending] = useState<Record<string, boolean>>({});

  // Redesign UI state: collapsed description, lazy map/video, comment paging,
  // and the fullscreen lightbox position.
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  const [videoOpen, setVideoOpen] = useState(false);
  const [commentsExpanded, setCommentsExpanded] = useState(false);
  const [replyTo, setReplyTo] = useState<CommentItem | null>(null);
  // W3 inline threads: per-thread visible-reply counts keyed by comment id.
  // Absent = COMMENT_FIRST_REPLIES (collapsed to the first replies).
  const [threadCounts, setThreadCounts] = useState<Record<string, number>>({});
  // Briefly highlights the jump target of an @reply-to tap (same pattern as
  // the linked-comment highlight below — focus ring, no navigation).
  const [flashComment, setFlashComment] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<{ index: number; origin: PhotoLightboxOriginRect | null } | null>(null);

  // Sequence tokens for latest-request-wins mutation sequencing
  const reactionSeq = useRef(0);
  const ratingSeq = useRef(0);
  const statusSeq = useRef(0);
  // Mutation identity: this instance is reused across in-place post
  // navigation (the route carries no key) and across account switches, so a
  // late mutation callback must confirm it still owns the viewed post and
  // account before writing state — otherwise it patches the wrong screen.
  const viewedPostIdRef = useRef(id);
  viewedPostIdRef.current = id;
  const viewerIdRef = useRef<string | undefined>(user?.id);
  viewerIdRef.current = user?.id;
  // Sequence guards only protect response application. Synchronous locks
  // also prevent competing server writes before React flushes disabled UI.
  const reactionPendingRef = useRef(false);
  const ratingPendingRef = useRef(false);
  const [reactionPending, setReactionPending] = useState(false);
  const [ratingPending, setRatingPending] = useState(false);
  // Generation guard: only the current post id / reload may apply results.
  const loadGen = useRef(0);
  // Per-section retry tokens: retries reuse the same generation, so each
  // comments/social request carries its own latest-request-wins sequence.
  const commentsSeq = useRef(0);
  const socialSeq = useRef(0);
  const postPresentRef = useRef(false);
  // Track in-flight mutations to disable owner controls
  const [statusPending, setStatusPending] = useState(false);
  // Latest comments for realtime comment-reaction patches (the effect below
  // only depends on [id, load], so it reads through this ref).
  const commentsRef = useRef<CommentItem[]>([]);
  commentsRef.current = comments;

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
        setCommentsEpoch((n) => n + 1);
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

  // A feed Comments shortcut targets the existing section once the shell is
  // mounted. Retry/social/realtime hydration must not keep stealing focus.
  useEffect(() => {
    if (loading || post?.id !== id || !["#detail-comments", "#detail-activity", "#detail-manage"].includes(hash)) return;
    if (linkedComment && commentsLoading) return;
    const focusKey = `${id}:${locationKey}:${hash}:${linkedComment ?? ""}`;
    if (focusedLink.current === focusKey) return;
    const frame = requestAnimationFrame(() => {
      focusedLink.current = focusKey;
      const target = linkedComment && comments.some(c => c.id === linkedComment)
        ? `detail-comment-${linkedComment}` : hash.slice(1);
      scrollToSection(target);
    });
    return () => cancelAnimationFrame(frame);
  }, [loading, post?.id, id, hash, locationKey, linkedComment, commentsLoading, comments]);

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
        const p = payload as {
          postId: string;
          likeCount?: number;
          dislikeCount?: number;
          reactionCounts?: unknown;
          commentId?: string;
        };
        if (p.postId !== id) return;
        // Comment reaction broadcast: patch that comment's summary live,
        // keeping the caller's own reaction (the payload carries no
        // my_reaction — it is counts-only).
        if (typeof p.commentId === "string") {
          const counts = reactionCountsFromJson(p.reactionCounts);
          setCommentSummaries((prev) => ({
            ...prev,
            [p.commentId as string]: reactionSummaryFromCounts(
              counts,
              prev[p.commentId as string]?.myReaction ??
                commentsRef.current.find((c) => c.id === p.commentId)?.reactionSummary?.myReaction ??
                null,
            ),
          }));
          return;
        }
        setPost((prev) =>
          prev
            ? {
                ...prev,
                likeCount: p.likeCount ?? prev.likeCount,
                dislikeCount: p.dislikeCount ?? prev.dislikeCount,
              }
            : prev,
        );
        if (p.reactionCounts !== undefined) {
          const summary = reactionSummaryFromCounts(reactionCountsFromJson(p.reactionCounts), null);
          setPostCountsOverride({ postId: p.postId, counts: summary.counts, total: summary.total });
        }
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

  // W3 inline threads: ancestor chain of the ?comment= deep link. Derived
  // (not state) so a linked reply inside a collapsed branch auto-expands on
  // the same render that reveals it — no effect ordering with the focus
  // scroll below. parentId stays the true relation; this only forces
  // visibility for the linked chain.
  const linkedAncestors = useMemo(() => {
    const chain = new Set<string>();
    if (!linkedComment) return chain;
    const byId = new Map(comments.map((c) => [c.id, c]));
    let cur = byId.get(linkedComment);
    while (cur?.parentId) {
      if (!byId.has(cur.parentId) || chain.has(cur.parentId)) break;
      chain.add(cur.parentId);
      cur = byId.get(cur.parentId);
    }
    return chain;
  }, [linkedComment, comments]);

  // W3 inline threads: drop per-thread expand counts for comments that are
  // gone (local cascade delete or realtime comment:deleted) so re-added
  // same-id threads render collapsed again. Live threads are untouched
  // (unchanged object identity bails out of a re-render).
  useEffect(() => {
    const live = new Set(comments.map((c) => c.id));
    setThreadCounts((prev) => {
      let pruned: Record<string, number> | null = null;
      for (const key of Object.keys(prev)) {
        if (!live.has(key)) {
          if (!pruned) pruned = { ...prev };
          delete pruned[key];
        }
      }
      return pruned ?? prev;
    });
  }, [comments]);

  // Stable skeleton holds the hero/body shape so resolving content never
  // reflows; the sticky escape bar stays mounted underneath via the shell.
  if (loading) return <DetailSkeleton />;
  if (error && !post) return <EmptyState title="Post unavailable" subtitle={error} />;
  if (!post) return null;

  const current = post;
  const isOwner = user?.id === current.author.id;

  /**
   * True when a mutation started for `snap` may no longer write: the viewer
   * has navigated to another post or switched accounts since. Pending flags
   * still clear in `finally` — only state writes and error display are gated.
   */
  function isStaleMutation(snap: { postId: string; viewer: string | undefined }): boolean {
    return viewedPostIdRef.current !== snap.postId || viewerIdRef.current !== snap.viewer;
  }

  // The Like control's state (packet `08` §2): the count is the target's
  // positive-reaction total and "mine" is whether the caller holds one. Server
  // truth wins once a write or realtime event delivers counts; otherwise the
  // detail fetch's own row mapping (`reactionSummaryFromRow`, L-CONSOLIDATE)
  // seeds it, or the legacy like/dislike buckets for older backends. The
  // caller's own reaction always comes from state, never from the row.
  const postSummary: ReactionSummary =
    postCountsOverride !== null && postCountsOverride.postId === current.id
      ? { counts: postCountsOverride.counts, total: postCountsOverride.total, myReaction }
      : current.reactionSummary
        ? { counts: current.reactionSummary.counts, total: current.reactionSummary.total, myReaction }
        : seedSummaryFromItem(current.likeCount, current.dislikeCount, myReaction);
  const postLike = likeState(postSummary);
  const postLikeLabel = `${postLike.mine ? "Liked" : "Like"}, ${postLike.count} ${postLike.count === 1 ? "like" : "likes"}`;

  async function applyReaction(next: ReactionKind | null) {
    if (reactionPendingRef.current) return;
    reactionPendingRef.current = true;
    setReactionPending(true);
    const prev = myReaction;
    const snap = { postId: current.id, viewer: user?.id };
    // Optimistic update: the caller's own reaction AND the per-kind counts move
    // with the tap (the Like control's number is derived from those counts), so
    // the number never lags the heart. Server truth replaces both on success.
    const optimisticCounts = applyCountDeltas(postSummary.counts, reactionMoveDeltas(prev, next));
    setMyReaction(next);
    setPostCountsOverride({
      postId: current.id,
      counts: optimisticCounts,
      total: Object.values(optimisticCounts).reduce<number>((sum, n) => sum + (n ?? 0), 0),
    });
    // Increment sequence token - only the latest request's response will be applied
    const seq = ++reactionSeq.current;
    try {
      const res = await reactToPost(current.id, next);
      // Only apply if this is still the latest request for the same post/account
      if (reactionSeq.current === seq && !isStaleMutation(snap)) {
        setPost((prevPost) =>
          prevPost ? { ...prevPost, likeCount: res.likeCount, dislikeCount: res.dislikeCount } : prevPost,
        );
        // The RPC returns server-truth per-kind counts; keep them so the Like
        // control reads exact counts without a refetch.
        if (res.reactionCounts) {
          setPostCountsOverride({
            postId: res.postId,
            counts: res.reactionCounts.counts,
            total: res.reactionCounts.total,
          });
        }
      }
    } catch (e) {
      // Only rollback if this is still the latest request; failures stay
      // inline and never blow away the page.
      if (reactionSeq.current === seq && !isStaleMutation(snap)) {
        setMyReaction(prev);
        setPostCountsOverride(
          postCountsOverride !== null && postCountsOverride.postId === current.id
            ? postCountsOverride
            : null,
        );
        const message = friendlyError(e).message;
        setActionError(message);
        announce(message);
      }
    } finally {
      reactionPendingRef.current = false;
      setReactionPending(false);
    }
  }

  /**
   * Like/Unlike (packet `08` §2 — new writes are Like/null only). A caller
   * holding any positive reaction un-likes; everyone else likes.
   */
  function toggleLike() {
    void applyReaction(nextLikeReaction(myReaction));
  }

  /** Secondary "Not helpful" control (lives in the Community card). */
  function toggleDislike() {
    void applyReaction(myReaction === "DISLIKE" ? null : "DISLIKE");
  }

  async function onRate(score: number) {
    if (ratingPendingRef.current) return;
    ratingPendingRef.current = true;
    setRatingPending(true);
    const prev = myRating;
    const snap = { postId: current.id, viewer: user?.id };
    // Optimistic update
    setMyRating(score);
    // Increment sequence token - only the latest request's response will be applied
    const seq = ++ratingSeq.current;
    try {
      const res = await ratePost(current.id, score);
      // Only apply if this is still the latest request for the same post/account
      if (ratingSeq.current === seq && !isStaleMutation(snap)) {
        setPost((prevPost) =>
          prevPost ? { ...prevPost, ratingAvg: res.ratingAvg, ratingCount: res.ratingCount } : prevPost,
        );
      }
    } catch (e) {
      // Only rollback if this is still the latest request
      if (ratingSeq.current === seq && !isStaleMutation(snap)) {
        setMyRating(prev);
        const message = friendlyError(e).message;
        setActionError(message);
        announce(message);
      }
    } finally {
      ratingPendingRef.current = false;
      setRatingPending(false);
    }
  }

  /**
   * C3 comment write path: the composer owns text, mentions, emoji, and
   * attachments and hands over a complete body (text + `https://` media
   * lines, never base64) plus the ordered attachment descriptors for the
   * atomic `findback_add_comment_with_attachments` RPC (FB-AUD-02). The
   * 1000-character backend limit is enforced here too — the composer
   * already blocks over-limit sends, this stays as the defensive second
   * gate. Failures surface inline + announce (never silent). A body-only
   * submit keeps the exact legacy 3-arg addComment call so existing suites
   * observe no change; descriptors travel only when staged.
   */
  async function postCommentBody(body: string, attachments?: readonly CommentAttachmentDescriptor[]) {
    if ((!body.trim() && !attachments?.length) || body.length > 1000) return;
    const snap = { postId: current.id, viewer: user?.id };
    const comment =
      attachments && attachments.length > 0
        ? await addComment(current.id, body, replyTo?.id ?? null, attachments)
        : await addComment(current.id, body, replyTo?.id ?? null);
    if (isStaleMutation(snap)) return;
    const withRefs = withSentReportRefs(comment, attachments);
    setComments((prev) => (prev.some((c) => c.id === comment.id) ? prev : [...prev, withRefs]));
  }

  function commentFailed(message: string) {
    setActionError(message);
    announce(message);
  }

  async function onDeleteComment(commentId: string) {
    const snap = { postId: current.id, viewer: user?.id };
    try {
      await deleteComment(current.id, commentId);
      if (isStaleMutation(snap)) return;
      // Deleting a parent cascades server-side; mirror that locally by removing
      // the whole subtree so no orphaned reply is left on screen.
      const doomed = new Set<string>([commentId]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const c of comments) {
          if (c.parentId && doomed.has(c.parentId) && !doomed.has(c.id)) {
            doomed.add(c.id);
            grew = true;
          }
        }
      }
      setComments((prev) => prev.filter((c) => !doomed.has(c.id)));
      if (replyTo && doomed.has(replyTo.id)) setReplyTo(null);
    } catch (err) {
      if (isStaleMutation(snap)) return;
      const message = friendlyError(err).message;
      setActionError(message);
      announce(message);
    }
  }

  /**
   * Comment reaction state: local overrides win over the fetched
   * CommentItem.reactionSummary (populated by the extended list-RPC mapping);
   * untouched comments fall through to the fetched summary, else empty.
   */
  function commentSummaryFor(c: CommentItem): ReactionSummary {
    return (
      commentSummaries[c.id] ??
      c.reactionSummary ?? reactionSummaryFromCounts({}, null)
    );
  }

  /**
   * Comment Like write path (packet `08` §2 — Like/null only): optimistic
   * myReaction + per-kind counts over the real comment RPC, full revert +
   * inline announce on failure (same actionError pattern as post reactions —
   * never silent).
   */
  async function writeCommentReaction(c: CommentItem, next: ReactionKind | null) {
    if (commentPending[c.id]) return;
    const prev = commentSummaryFor(c);
    const snap = { postId: current.id, viewer: user?.id };
    const optimistic: ReactionSummary = reactionSummaryFromCounts(
      applyCountDeltas(prev.counts, reactionMoveDeltas(prev.myReaction, next)),
      next,
    );
    setCommentPending((p) => ({ ...p, [c.id]: true }));
    setCommentSummaries((p) => ({ ...p, [c.id]: optimistic }));
    try {
      const res = await setCommentReaction(c.id, next);
      if (isStaleMutation(snap)) return;
      setCommentSummaries((p) => ({
        ...p,
        [c.id]: { counts: res.counts, myReaction: res.myReaction, total: res.total },
      }));
    } catch (err) {
      if (isStaleMutation(snap)) return;
      setCommentSummaries((p) => ({ ...p, [c.id]: prev }));
      const message = friendlyError(err).message;
      setActionError(message);
      announce(message);
    } finally {
      setCommentPending((p) => {
        const rest = { ...p };
        delete rest[c.id];
        return rest;
      });
    }
  }

  /** Comment Like tap (packet `08` §2): a positive row un-likes, else LIKE. */
  function toggleCommentReaction(c: CommentItem) {
    const summary = commentSummaryFor(c);
    void writeCommentReaction(c, nextLikeReaction(summary.myReaction));
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
    const snap = { postId: current.id, viewer: user?.id };
    setStatusPending(true);
    try {
      const updated = await updatePostStatus(current.id, status);
      // Only apply if this is still the latest request for the same post/account
      if (statusSeq.current === seq && !isStaleMutation(snap)) {
        setPost(updated);
        announce(`Status updated to ${statusLabel(updated.status)}.`);
      }
    } catch (err) {
      // Only show error if this is still the latest request
      if (statusSeq.current === seq && !isStaleMutation(snap)) {
        const message = friendlyError(err).message;
        setActionError(message);
        announce(message);
      }
    } finally {
      if (statusSeq.current === seq) setStatusPending(false);
    }
  }

  const images = post.attachments.filter((a) => a.mimeType.startsWith("image/"));
  const lightboxPhotos = images.map((a) => ({ id: a.id, previewUrl: a.fileUrl }));

  // Owner status control is disabled while any mutation is active
  const ownerControlsDisabled = reactionPending || ratingPending || statusPending;

  const strippedDescription = stripMarkdown(current.description ?? "");
  const descriptionIsLong = strippedDescription.length > DESCRIPTION_PREVIEW_LIMIT;
  const descriptionPreview = descriptionIsLong
    ? `${strippedDescription.slice(0, DESCRIPTION_PREVIEW_LIMIT).trimEnd()}…`
    : strippedDescription;

  // Threaded comments: group replies under their parent. A reply whose parent is
  // not in the current page is treated as a root so it is never hidden.
  // W3 inline threads: replies expand inline per thread (first replies +
  // "View N more replies" / "Hide replies"); visual indent caps at
  // COMMENT_MAX_VISUAL_DEPTH and deeper logical levels render flat with an
  // @reply-to jump target. parentId/depth semantics are untouched.
  const commentsById = new Map<string, CommentItem>();
  for (const c of comments) commentsById.set(c.id, c);
  const childrenByParent = new Map<string, CommentItem[]>();
  const commentRoots: CommentItem[] = [];
  for (const c of comments) {
    const parentId = c.parentId ?? null;
    if (parentId && commentsById.has(parentId)) {
      const list = childrenByParent.get(parentId) ?? [];
      list.push(c);
      childrenByParent.set(parentId, list);
    } else {
      commentRoots.push(c);
    }
  }
  const visibleRoots =
    commentsExpanded || linkedComment || commentRoots.length <= COMMENTS_PREVIEW_COUNT
      ? commentRoots
      : commentRoots.slice(0, COMMENTS_PREVIEW_COUNT);

  /** Visible slice of a thread: linked ancestors force full visibility. */
  function visibleRepliesFor(c: CommentItem): { visible: CommentItem[]; remaining: number } {
    const all = childrenByParent.get(c.id) ?? [];
    const count = linkedAncestors.has(c.id)
      ? all.length
      : (threadCounts[c.id] ?? COMMENT_FIRST_REPLIES);
    const visible = all.slice(0, count);
    return { visible, remaining: all.length - visible.length };
  }

  function showMoreReplies(c: CommentItem) {
    const total = childrenByParent.get(c.id)?.length ?? 0;
    setThreadCounts((prev) => ({
      ...prev,
      [c.id]: Math.min((prev[c.id] ?? COMMENT_FIRST_REPLIES) + COMMENT_REPLIES_INCREMENT, total),
    }));
  }

  function hideReplies(c: CommentItem) {
    setThreadCounts((prev) => ({ ...prev, [c.id]: COMMENT_FIRST_REPLIES }));
  }

  /**
   * @reply-to jump: focuses + highlights the parent comment in place (same
   * reduced-motion policy as section scrolls). Never navigates away.
   */
  function jumpToComment(targetId: string) {
    const el = document.getElementById(`detail-comment-${targetId}`);
    if (!el) return;
    el.focus({ preventScroll: true });
    if (typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ behavior: shouldReduceMotion() ? "instant" : "smooth", block: "start" });
    }
    setFlashComment(targetId);
    window.setTimeout(() => {
      setFlashComment((cur) => (cur === targetId ? null : cur));
    }, 1600);
  }

  const renderComment = (c: CommentItem, level = 0): React.ReactNode => {
    const canDelete = c.author.id === user?.id || isOwner;
    // C3 body media: `https://` attachment lines lift out into a gallery;
    // the remaining text keeps the existing markdown path untouched.
    const bodyParts = parseCommentBody(c.body);
    const children = childrenByParent.get(c.id) ?? [];
    const { visible, remaining } = visibleRepliesFor(c);
    const expandedBeyondDefault = visible.length > COMMENT_FIRST_REPLIES;
    const isReplyTarget = replyTo?.id === c.id;
    const highlighted = linkedComment === c.id || flashComment === c.id;
    // Deeper logical nesting stays real (parentId/replyTo untouched) but
    // renders flat: indented connector only while level < cap, otherwise an
    // @username prefix names the true parent.
    const nestChildren = level < COMMENT_MAX_VISUAL_DEPTH;
    const showTarget = level > COMMENT_MAX_VISUAL_DEPTH;
    const parentName =
      showTarget && c.parentId ? (commentsById.get(c.parentId)?.author.username ?? null) : null;
    const threadControls = children.length > 0 && (
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {remaining > 0 && (
          <button
            type="button"
            onClick={() => showMoreReplies(c)}
            aria-expanded={expandedBeyondDefault}
            aria-label={`View ${remaining} more ${remaining === 1 ? "reply" : "replies"} to ${c.author.username}`}
            className="inline-flex min-h-[44px] items-center gap-1 rounded-full px-2 text-xs font-medium text-on-surface-variant underline"
          >
            View {remaining} more {remaining === 1 ? "reply" : "replies"}
          </button>
        )}
        {remaining === 0 && expandedBeyondDefault && (
          <button
            type="button"
            onClick={() => hideReplies(c)}
            aria-expanded="true"
            aria-label={`Hide replies to ${c.author.username}`}
            className="inline-flex min-h-[44px] items-center gap-1 rounded-full px-2 text-xs font-medium text-on-surface-variant underline"
          >
            Hide replies
          </button>
        )}
      </div>
    );
    return (
      <motion.li
        key={c.id}
        id={`detail-comment-${c.id}`}
        tabIndex={-1}
        initial="hidden"
        animate="visible"
        variants={listItemVariants}
        transition={{ duration: motionDurations.fast }}
        className={`scroll-mt-4 rounded-m3-md border p-3 focus:outline-2 focus:outline-offset-2 focus:outline-on-surface ${highlighted ? "border-on-surface" : "border-outline-variant"}`}
      >
        {showTarget && parentName && c.parentId && (
          <button
            type="button"
            onClick={() => jumpToComment(c.parentId as string)}
            aria-label={`Jump to parent comment by ${parentName}`}
            className="mb-1 inline-flex min-h-[44px] items-center rounded-full text-xs font-semibold text-on-surface-variant underline"
          >
            @{parentName}
          </button>
        )}
        {/* O5 mount (CF-060 R10): this comment's own content only. The child
            reply list, the thread controls and the @parent jump stay outside,
            so an unblocked reply (or a blocked reply's own reveal control) is
            never inert beneath this shield. */}
        <BlockedByViewerShield rowId={c.id} blocked={c.blockedAuthor} mode="row" contentClassName="flex flex-col">
        <div className="flex items-center gap-2">
          <UserAvatar avatarUrl={c.author.avatarUrl} username={c.author.username} size={28} />
          <span className="min-w-0 flex-1 truncate text-sm font-semibold">@{c.author.username}</span>
          <span className="shrink-0 text-[11px] text-on-surface-variant">
            {formatTimestamp(c.createdAt)}
          </span>
        </div>
        <div className="mt-1 text-sm leading-relaxed">
          <MarkdownView text={bodyParts.text || c.body} linkMentions unfurlReports />
        </div>
        {bodyParts.media.length > 0 && (
          <div
            data-testid={`comment-media-${c.id}`}
            className="mt-2 flex flex-wrap gap-1.5"
            aria-label={`Attachments on comment by ${c.author.username}`}
          >
            {bodyParts.media.map((m, i) => {
              // Display order = appearance order: appendBodyMedia emits one
              // media line per attachment in display_order (1..4), and
              // parseCommentBody lifts them back in that same order.
              const provenance = commentMediaProvenance(m.url);
              const sourceLabel = provenance === "klipy" ? "KLIPY" : "Storage";
              return (
                <figure key={`${m.url}-${i}`} className="relative m-0">
                  {m.kind === "video" ? (
                    <video
                      src={m.url}
                      controls
                      playsInline
                      preload="metadata"
                      aria-label={`Attached video ${i + 1} via ${sourceLabel}`}
                      className="h-24 max-w-full rounded-m3-sm border border-outline-variant object-cover"
                    />
                  ) : (
                    <img
                      src={m.url}
                      alt={`Attached photo ${i + 1} via ${sourceLabel}`}
                      loading="lazy"
                      className="h-24 w-auto rounded-m3-sm border border-outline-variant object-cover"
                    />
                  )}
                  {provenance && (
                    <figcaption
                      data-testid={`comment-media-source-${c.id}-${i}`}
                      data-provenance={provenance}
                      className="pointer-events-none absolute left-1 top-1 rounded-full bg-black/60 px-1.5 py-0.5 text-[10px] font-semibold text-white"
                    >
                      {sourceLabel}
                    </figcaption>
                  )}
                </figure>
              );
            })}
          </div>
        )}
        {c.attachments && c.attachments.length > 0 && (
          <div
            data-testid={`comment-reports-${c.id}`}
            className="mt-2 flex flex-wrap items-center gap-1.5"
          >
            {c.attachments.map((ref) => (
              <ReportReferenceCard
                key={`${ref.displayOrder}-${ref.reportPostId ?? "unavailable"}`}
                postId={ref.reportPostId}
              />
            ))}
          </div>
        )}
        </BlockedByViewerShield>
        <div className="mt-2 flex items-center gap-1">
          <button
            type="button"
            onClick={() => setReplyTo(isReplyTarget ? null : c)}
            aria-pressed={isReplyTarget}
            aria-label={`Reply to ${c.author.username}`}
            className="inline-flex min-h-[48px] items-center gap-1 rounded-full px-2 text-xs font-medium text-on-surface-variant"
          >
            <CornerDownRight size={13} aria-hidden /> Reply
          </button>
          {canDelete && (
            <button
              type="button"
              onClick={() => void onDeleteComment(c.id)}
              aria-label={`Delete comment by ${c.author.username}`}
              className="inline-flex min-h-[48px] items-center gap-1 px-2 text-xs text-on-surface-variant hover:text-error"
            >
              <Trash2 size={13} aria-hidden /> Delete
            </button>
          )}
          <CommentLikeButton
            comment={c}
            summary={commentSummaryFor(c)}
            pending={commentPending[c.id] ?? false}
            onToggle={() => toggleCommentReaction(c)}
          />
        </div>
        {children.length > 0 && nestChildren && (
          <ul className="mt-3 flex flex-col gap-3 border-l border-outline-variant pl-3">
            {visible.map((ch) => renderComment(ch, level + 1))}
          </ul>
        )}
        {children.length > 0 && !nestChildren && (
          <ul className="mt-2 flex flex-col gap-3">
            {visible.map((ch) => renderComment(ch, level + 1))}
          </ul>
        )}
        {threadControls}
      </motion.li>
    );
  };

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
        {/* O5 mount (CF-060 R10): the report-content region only — summary
            through the matches section, ending BEFORE detail-comments. The
            comment thread stays a sibling: wrapping the <article> would blur
            every comment (the bit is per row) and put their reveal controls
            inside an inert subtree. */}
        <BlockedByViewerShield
          rowId={post.id}
          blocked={post.blockedAuthor}
          contentClassName="flex flex-col gap-4"
        >
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
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-on-surface-variant">
              <span className="font-medium text-on-surface">@{post.author.username}</span>
              <span className="fb-category-chip"><Tag size={14} aria-hidden /> <span>{post.category}</span></span>
            </div>
            {post.locationLabel && <p className="mt-2 flex items-center gap-1.5 text-sm text-on-surface-variant"><MapPin size={16} aria-hidden className="shrink-0" />{post.locationLabel}</p>}
          </div>
        </section>

        <DetailHeroGallery
          key={post.id}
          postId={post.id}
          title={post.title}
          images={images}
          onOpenLightbox={(index, origin) => setLightbox({ index, origin })}
        />

        <div id="detail-activity" tabIndex={-1} className="grid scroll-mt-4 grid-cols-3 gap-2" role="group" aria-label="Report actions">
          {/* Post Like cell (packet `08` §2 — Like-only): one tap toggles the
              caller's Like (LIKE/null) and the heart fills when it is theirs. */}
          <button
            type="button"
            id="detail-love"
            data-testid="detail-like"
            className={`fb-report-action min-h-[44px] flex-1 gap-1 ${postLike.mine ? "bg-surface-container text-on-surface" : "text-on-surface-variant"}`}
            onClick={toggleLike}
            disabled={reactionPending}
            aria-busy={reactionPending}
            aria-label={postLikeLabel}
            aria-pressed={postLike.mine}
          >
            <Heart size={20} aria-hidden fill={postLike.mine ? "currentColor" : "none"} />
            <span aria-hidden className="tabular-nums">{postLike.count}</span>
          </button>
          <button type="button" className="fb-report-action" onClick={() => scrollToSection("detail-comments")} aria-label={`Comments, ${comments.length}`}>
            <MessageCircle size={20} aria-hidden /> {comments.length}
          </button>
          <ReportShareButton postId={post.id} title={post.title} />
        </div>

        <section aria-label="Description" className="rounded-m3-lg border border-outline-variant bg-surface-container-low p-4">
          <h2 className="mb-2 text-sm font-medium text-on-surface-variant">Description</h2>
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
          <section id="detail-manage" tabIndex={-1} aria-label="Manage report" className="scroll-mt-4 rounded-m3-md border border-outline-variant p-3">
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

        <section aria-label="Community Rating" className="flex flex-col gap-3 rounded-m3-lg border border-outline-variant bg-surface-container-low p-4">
          <h2 className="text-sm font-medium text-on-surface-variant">Community Rating</h2>
          <div aria-live="polite">
            <p className="sr-only">
              {post.ratingCount > 0 ? `Community rating: ${post.ratingAvg?.toFixed(1) ?? "—"} / 5 from ${post.ratingCount} rating${post.ratingCount === 1 ? "" : "s"}` : "No community ratings yet — be the first to rate."}
            </p>
            <div className="flex flex-wrap items-center gap-3" aria-hidden="true">
              <span className="text-4xl font-semibold tabular-nums tracking-tight">{post.ratingCount > 0 ? post.ratingAvg?.toFixed(1) ?? "—" : "—"}</span>
              <div className="flex gap-1">
                {[0, 1, 2, 3, 4].map((i) => (
                  <span key={i} className="relative inline-flex text-on-surface-variant">
                    <Star size={24} />
                    <span className="absolute inset-y-0 left-0 overflow-hidden text-on-surface" style={{ width: `${Math.max(0, Math.min(1, (post.ratingAvg ?? 0) - i)) * 100}%` }}><Star size={24} fill="currentColor" /></span>
                  </span>
                ))}
              </div>
            </div>
            <p className="mt-1 text-sm text-on-surface-variant" aria-hidden="true">{post.ratingCount} rating{post.ratingCount === 1 ? "" : "s"}</p>
          </div>
          {socialLoading && <p role="status" className="text-sm text-on-surface-variant">Loading reactions…</p>}
          {socialError && (
            <div className="flex items-center justify-between gap-2 rounded-m3-sm border border-error px-3 py-2 text-sm text-error">
              <span>Could not load reactions: {socialError}</span>
              <button type="button" onClick={retrySocial} className="min-h-[48px] shrink-0 px-3 font-medium underline">Retry</button>
            </div>
          )}
          <div className="border-t border-outline-variant pt-3">
            <p className="text-sm font-medium" id="your-rating-label">Your rating{myRating != null ? `: ${myRating} out of 5` : ""}</p>
            <RatingStars value={myRating} onRate={(s) => void onRate(s)} labelId="your-rating-label" pending={ratingPending} />
            <p className="text-xs text-on-surface-variant">Tap a star to rate this report.</p>
          </div>
          <Button variant="text" className="self-start" onClick={toggleDislike} disabled={reactionPending} aria-busy={reactionPending} aria-label={`Not helpful, ${post.dislikeCount} ${post.dislikeCount === 1 ? "reaction" : "reactions"}`} aria-pressed={myReaction === "DISLIKE"}>
            <ThumbsDown size={16} aria-hidden /> Not helpful · {post.dislikeCount}
          </Button>
        </section>

        {/* Overview: compact lazy heavy sections. */}
        <section data-testid="detail-overview" id="detail-overview" aria-label="Overview" className="flex flex-col gap-3">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-m3-lg border border-outline-variant bg-surface-container-low p-4 text-sm">
            <div>
              <dt className="text-xs text-on-surface-variant">Status</dt>
              <dd className="font-medium">{statusLabel(post.status)}</dd>
            </div>
            <div>
              <dt className="flex items-center gap-1 text-xs text-on-surface-variant"><CalendarDays size={14} aria-hidden />{post.type === "LOST" ? "Lost on" : "Found on"}</dt>
              <dd className="font-medium">{formatEventDate(post.eventDate)}</dd>
            </div>
            <div className="col-span-2">
              <dt className="flex items-center gap-1 text-xs text-on-surface-variant"><MapPin size={14} aria-hidden />Location</dt>
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

          {/* Native map mounts only after the disclosure opens. */}
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

        </section>

        {/* Matches: dedicated compact section, async, never blocks the shell. */}
        <section id="detail-matches" aria-label="Matches" className="flex flex-col gap-2">
          <h2 className="text-base font-semibold">Matches</h2>
          <p className="text-sm text-on-surface-variant">
            Reports of the opposite type with similar details. Review them yourself before reaching out.
          </p>
          {post.status === "OPEN" && <PossibleMatches post={post} />}
        </section>
        </BlockedByViewerShield>

        {/* Comments */}
        <section data-testid="detail-comments" id="detail-comments" tabIndex={-1} aria-label="Comments" className="flex scroll-mt-4 flex-col gap-3">
          <h2 className="text-base font-semibold">
            Comments <span className="text-on-surface-variant">({comments.length})</span>
          </h2>

          {replyTo ? (
            <div
              role="status"
              className="flex items-center gap-2 rounded-m3-sm border border-outline-variant bg-surface-container/50 px-3 py-2 text-xs text-on-surface-variant"
            >
              <span className="flex-1 truncate">
                Replying to <span className="font-semibold text-on-surface">@{replyTo.author.username}</span>
              </span>
              <button
                type="button"
                onClick={() => setReplyTo(null)}
                aria-label="Cancel reply"
                className="inline-flex min-h-[44px] items-center gap-1 rounded-full px-2 font-medium"
              >
                <X size={13} aria-hidden /> Cancel
              </button>
            </div>
          ) : null}

          <CommentComposer
            postId={current.id}
            replyToUsername={replyTo?.author.username ?? null}
            currentUser={user}
            participants={mentionParticipants}
            owner={{
              username: current.author.username,
              displayName: current.author.displayName ?? null,
              avatarUrl: current.author.avatarUrl ?? null,
            }}
            onSubmit={(body, attachments) => postCommentBody(body, attachments)}
            onError={commentFailed}
            onSent={() => setReplyTo(null)}
          />

          {commentsLoading ? (
            <CommentSkeleton />
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
              <ReportPreviewProvider resetKey={`${user?.id ?? "anon"}:${commentsEpoch}`}>
                <ul className="flex flex-col gap-3">
                  {visibleRoots.map((c) => renderComment(c, 0))}
                </ul>
              </ReportPreviewProvider>
              {!commentsExpanded && !linkedComment && commentRoots.length > COMMENTS_PREVIEW_COUNT && (
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
          photos={lightboxPhotos}
          title={post.title}
          onSelect={(index) => setLightbox({ index, origin: null })}
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
