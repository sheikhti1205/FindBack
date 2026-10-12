import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useParams } from "react-router";
import { motion } from "framer-motion";
import { CalendarDays, ChevronDown, CornerDownRight, ExternalLink, MapPin, MessageCircle, Star, Tag, ThumbsDown, Trash2, X } from "lucide-react";
import type { CanonicalReactionKind, CommentItem, PostItem, PostStatus, ReactionCounts, ReactionKind, ReactionSummary } from "@findback/shared";
import { POST_STATUSES } from "@findback/shared";
import { useAuth } from "../auth";
import { BackButton } from "../components/BackButton";
import { UserAvatar } from "../components/UserAvatar";
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
import { CommentComposer } from "../components/CommentComposer";
import { commentMediaProvenance, parseCommentBody } from "../services/commentBodyMedia";
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
import { ReactionTray, reactionKindLabel, topReactionKind } from "../components/ReactionTray";
import { ReactionArt } from "../components/ReactionArt";
import { ReactionPreviewStack } from "../components/ReactionPreviewStack";
import { useLongPress } from "../hooks/useLongPress";
import { useSlideSelect } from "../hooks/useSlideSelect";
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
  applyReactionDeltas,
  seedSummaryFromItem,
} from "../services/feedReactions";
import {
  nextReactionForTap,
  normalizeReactionKind,
  reactionCountsFromJson,
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
 * C2 compact per-comment reaction control. Tap toggles the default Love,
 * press-and-hold opens the floating pill (slide while held, release selects,
 * vertical travel cancels), and the chevron "Choose reaction" button opens
 * the same pill for keyboard/screen-reader users (no long-press needed).
 * The row shows the top preview art + the total OUTSIDE the tray; the tray
 * itself is icon-only. Writes go to the real comment RPC via the parent's
 * onToggle/onSelect; failures revert there and surface through the page's
 * existing inline actionError + announce pattern.
 */
function CommentReactionControl({
  comment,
  summary,
  pending,
  onToggle,
  onSelect,
}: {
  comment: CommentItem;
  summary: ReactionSummary;
  pending: boolean;
  onToggle: () => void;
  onSelect: (kind: CanonicalReactionKind) => void;
}) {
  const [trayOpen, setTrayOpen] = useState(false);
  const [opener, setOpener] = useState<"main" | "choose">("main");
  const [holding, setHolding] = useState(false);
  const press = useLongPress(
    () => {
      setOpener("main");
      setTrayOpen(true);
    },
    { disabled: pending || trayOpen },
  );
  const slide = useSlideSelect(trayOpen, holding, () => setTrayOpen(false));
  const slideHoverRef = useRef(slide.hovered);
  slideHoverRef.current = slide.hovered;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const mainId = `detail-comment-react-${comment.id}`;
  const chooseId = `detail-comment-choose-${comment.id}`;
  const mine =
    summary.myReaction === null
      ? null
      : (normalizeReactionKind(summary.myReaction) as CanonicalReactionKind);
  const top = topReactionKind(summary.counts);
  const display: CanonicalReactionKind | null = mine ?? top;
  const countWord = summary.total === 1 ? "reaction" : "reactions";
  const label =
    mine !== null
      ? `${reactionKindLabel(mine)}, ${summary.total} ${countWord}`
      : top !== null && summary.total > 0
        ? `${reactionKindLabel(top)}, ${summary.total} ${countWord}`
        : `React to comment by ${comment.author.username}`;

  function closeTray() {
    slide.reset();
    setTrayOpen(false);
  }

  // Slide-release while the opening finger is still held: select the hovered
  // choice, else leave the tray open for a follow-up tap (claimTap still
  // swallows the click).
  useEffect(() => {
    if (!trayOpen || opener !== "main") return;
    function onUp() {
      const hovered = slideHoverRef.current;
      setHolding(false);
      if (hovered !== null) {
        const kind = hovered;
        slide.reset();
        setTrayOpen(false);
        document.getElementById(mainId)?.focus({ preventScroll: true });
        onSelectRef.current(kind);
      } else {
        slide.reset();
      }
    }
    function onCancel() {
      setHolding(false);
      slide.reset();
      setTrayOpen(false);
    }
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    return () => {
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
  }, [trayOpen, opener, mainId]);

  return (
    <span className="relative ml-auto flex items-center gap-0.5">
      <button
        type="button"
        id={mainId}
        data-testid={`comment-react-${comment.id}`}
        aria-pressed={mine !== null}
        aria-label={label}
        disabled={pending}
        aria-busy={pending}
        onPointerDown={(e) => {
          setHolding(true);
          press.onPointerDown(e);
        }}
        onPointerMove={press.onPointerMove}
        onPointerUp={() => {
          setHolding(false);
          press.onPointerUp();
        }}
        onPointerCancel={() => {
          setHolding(false);
          press.onPointerCancel();
        }}
        onClick={() => {
          if (press.claimTap()) return;
          if (trayOpen) {
            closeTray();
            return;
          }
          onToggle();
        }}
        className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-1 rounded-full px-2 text-xs font-medium text-on-surface-variant"
      >
        {display ? (
          <ReactionArt kind={display} size={15} filled={mine !== null} />
        ) : (
          <ReactionArt kind="LOVE" size={15} filled={false} />
        )}
        <span aria-hidden className="tabular-nums">{summary.total}</span>
      </button>
      <button
        type="button"
        id={chooseId}
        data-testid={`comment-choose-${comment.id}`}
        aria-haspopup="menu"
        aria-expanded={trayOpen}
        aria-label={`Choose reaction for comment by ${comment.author.username}`}
        disabled={pending}
        onClick={() => {
          setOpener("choose");
          setTrayOpen((o) => !o);
        }}
        className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full px-1 text-xs text-on-surface-variant"
      >
        <ChevronDown size={14} aria-hidden />
      </button>
      {trayOpen && (
        <span className="absolute bottom-full right-0 z-20 mb-1 w-max max-w-[78vw]">
          <ReactionTray
            open
            myReaction={summary.myReaction}
            counts={summary.counts}
            total={summary.total}
            pending={pending}
            hoveredKind={holding ? slide.hovered : undefined}
            onHoverChange={holding ? slide.setHovered : undefined}
            onSelect={(kind) => {
              closeTray();
              document.getElementById(mainId)?.focus({ preventScroll: true });
              onSelect(kind);
            }}
            onClose={closeTray}
            triggerId={opener === "choose" ? chooseId : mainId}
          />
        </span>
      )}
    </span>
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
  const [trayTarget, setTrayTarget] = useState<"post" | string | null>(null);
  const [trayOpener, setTrayOpener] = useState<"main" | "choose">("main");

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
  // Press-and-hold on the post Love button opens the tray; a quick release
  // is a plain tap (the click handler consults claimTap). While held, the
  // finger may slide across the pill (hovered lifts) and release selects.
  const [postHolding, setPostHolding] = useState(false);
  const postPress = useLongPress(
    () => {
      setTrayOpener("main");
      setTrayTarget("post");
    },
    { disabled: reactionPendingRef.current },
  );
  const postSlide = useSlideSelect(trayTarget === "post", postHolding, () => setTrayTarget(null));
  // Slide-release refs live above the post-shell early return: hooks must
  // stay unconditional (loading renders return early below). The actual
  // write callback is assigned once the post resolves.
  const reactToKindRef = useRef<(kind: CanonicalReactionKind) => void>(() => {});
  const postSlideHoverRef = useRef<CanonicalReactionKind | null>(null);
  postSlideHoverRef.current = postSlide.hovered;
  const postSlideResetRef = useRef(postSlide.reset);
  postSlideResetRef.current = postSlide.reset;

  // Slide-release on the post pill while the opening finger is still held:
  // a release over a choice selects it; lifting without sliding leaves the
  // tray open for a follow-up tap (claimTap still swallows the hold's click).
  useEffect(() => {
    if (trayTarget !== "post" || trayOpener !== "main") return;
    function onUp() {
      const hovered = postSlideHoverRef.current;
      setPostHolding(false);
      if (hovered !== null) reactToKindRef.current(hovered);
      else postSlideResetRef.current();
    }
    function onCancel() {
      setPostHolding(false);
      postSlideResetRef.current();
      setTrayTarget(null);
    }
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    return () => {
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
  }, [trayTarget, trayOpener]);

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
          const total = Object.values(counts).reduce<number>((s, n) => s + (n ?? 0), 0);
          setCommentSummaries((prev) => ({
            ...prev,
            [p.commentId as string]: {
              counts,
              total,
              myReaction:
                prev[p.commentId as string]?.myReaction ??
                commentsRef.current.find((c) => c.id === p.commentId)?.reactionSummary?.myReaction ??
                null,
            },
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
          const counts = reactionCountsFromJson(p.reactionCounts);
          const total = Object.values(counts).reduce<number>((s, n) => s + (n ?? 0), 0);
          setPostCountsOverride({ postId: p.postId, counts, total });
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

  if (loading) return <Spinner label="Loading post…" />;
  if (error && !post) return <EmptyState title="Post unavailable" subtitle={error} />;
  if (!post) return null;

  const current = post;
  const isOwner = user?.id === current.author.id;

  // W3.3 post summary: server-truth counts/total once a write or realtime
  // event delivers them, else seeded from the legacy buckets (+1 for an own
  // canonical kind, which the legacy buckets never contain). The caller's
  // own reaction always comes from state, never from the override.
  const postActiveKind =
    myReaction === null ? null : (normalizeReactionKind(myReaction) as CanonicalReactionKind);
  const postSummary: ReactionSummary =
    postCountsOverride !== null && postCountsOverride.postId === current.id
      ? { counts: postCountsOverride.counts, total: postCountsOverride.total, myReaction }
      : seedSummaryFromItem(current.likeCount, current.dislikeCount, myReaction);
  const postLoveLabel =
    postActiveKind === null || postActiveKind === "LOVE"
      ? `Love, ${current.likeCount} ${current.likeCount === 1 ? "love" : "loves"}`
      : `${reactionKindLabel(postActiveKind)}, ${postSummary.total} ${postSummary.total === 1 ? "reaction" : "reactions"}`;

  async function applyReaction(next: ReactionKind | null) {
    if (reactionPendingRef.current) return;
    reactionPendingRef.current = true;
    setReactionPending(true);
    const prev = myReaction;
    // Optimistic update
    setMyReaction(next);
    // Increment sequence token - only the latest request's response will be applied
    const seq = ++reactionSeq.current;
    try {
      const res = await reactToPost(current.id, next);
      // Only apply if this is still the latest request
      if (reactionSeq.current === seq) {
        setPost((prevPost) =>
          prevPost ? { ...prevPost, likeCount: res.likeCount, dislikeCount: res.dislikeCount } : prevPost,
        );
        // The widened RPC returns server-truth per-kind counts; keep them so
        // the tray/total read exact counts without a refetch.
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
      if (reactionSeq.current === seq) {
        setMyReaction(prev);
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
   * Heart Love/Unlove (LIKE-era wire preserved): a LOVE-kind reaction
   * (LIKE or canonical LOVE) clears to null, anything else switches to LIKE.
   */
  function toggleLove() {
    void applyReaction(
      myReaction !== null && normalizeReactionKind(myReaction) === "LOVE" ? null : "LIKE",
    );
  }

  /** Tray write path: the tapped canonical kind goes to the real multi-kind RPC. */
  function reactToKind(kind: CanonicalReactionKind) {
    postSlide.reset();
    setTrayTarget(null);
    document.getElementById("detail-love")?.focus({ preventScroll: true });
    void applyReaction(nextReactionForTap(myReaction, kind));
  }
  reactToKindRef.current = reactToKind;

  /** Secondary "Not helpful" control (lives in the Community card). */
  function toggleDislike() {
    void applyReaction(myReaction === "DISLIKE" ? null : "DISLIKE");
  }

  async function onRate(score: number) {
    if (ratingPendingRef.current) return;
    ratingPendingRef.current = true;
    setRatingPending(true);
    const prev = myRating;
    // Optimistic update
    setMyRating(score);
    // Increment sequence token - only the latest request's response will be applied
    const seq = ++ratingSeq.current;
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
      ratingPendingRef.current = false;
      setRatingPending(false);
    }
  }

  /**
   * C3 comment write path: the composer owns text, mentions, emoji, and
   * attachments and hands over a complete body (text + `https://` media
   * lines, never base64). The 1000-character backend limit is enforced here
   * too — the composer already blocks over-limit sends, this stays as the
   * defensive second gate. Failures surface inline + announce (never silent).
   */
  async function postCommentBody(body: string) {
    if (!body.trim() || body.length > 1000) return;
    const comment = await addComment(current.id, body, replyTo?.id ?? null);
    setComments((prev) => (prev.some((c) => c.id === comment.id) ? prev : [...prev, comment]));
  }

  function commentFailed(message: string) {
    setActionError(message);
    announce(message);
  }

  async function onDeleteComment(commentId: string) {
    try {
      await deleteComment(current.id, commentId);
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
      c.reactionSummary ?? { counts: {}, myReaction: null, total: 0 }
    );
  }

  /**
   * Comment write path (W3.3): optimistic myReaction + per-kind counts over
   * the real comment RPC, full revert + inline announce on failure (same
   * actionError pattern as post reactions — never silent).
   */
  async function writeCommentReaction(c: CommentItem, next: ReactionKind | null) {
    if (commentPending[c.id]) return;
    const prev = commentSummaryFor(c);
    const counts = applyReactionDeltas(prev.counts, prev.myReaction, next);
    const optimistic: ReactionSummary = {
      counts,
      myReaction: next,
      total: Object.values(counts).reduce<number>((s, n) => s + (n ?? 0), 0),
    };
    setCommentPending((p) => ({ ...p, [c.id]: true }));
    setCommentSummaries((p) => ({ ...p, [c.id]: optimistic }));
    try {
      const res = await setCommentReaction(c.id, next);
      setCommentSummaries((p) => ({
        ...p,
        [c.id]: { counts: res.counts, myReaction: res.myReaction, total: res.total },
      }));
    } catch (err) {
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

  /** Comment tap: default Love; tapping the active Love removes it. */
  function toggleCommentReaction(c: CommentItem) {
    const summary = commentSummaryFor(c);
    void writeCommentReaction(c, nextReactionForTap(summary.myReaction, "LOVE"));
  }

  /** Comment tray write: the tapped kind (or unreact when it is active). */
  function reactCommentToKind(c: CommentItem, kind: CanonicalReactionKind) {
    const summary = commentSummaryFor(c);
    void writeCommentReaction(c, nextReactionForTap(summary.myReaction, kind));
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
    setStatusPending(true);
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
        <div className="flex items-center gap-2">
          <UserAvatar avatarUrl={c.author.avatarUrl} username={c.author.username} size={28} />
          <span className="min-w-0 flex-1 truncate text-sm font-semibold">@{c.author.username}</span>
          <span className="shrink-0 text-[11px] text-on-surface-variant">
            {formatTimestamp(c.createdAt)}
          </span>
        </div>
        <div className="mt-1 text-sm leading-relaxed">
          <MarkdownView text={bodyParts.text || c.body} linkMentions />
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
          <CommentReactionControl
            comment={c}
            summary={commentSummaryFor(c)}
            pending={commentPending[c.id] ?? false}
            onToggle={() => toggleCommentReaction(c)}
            onSelect={(kind) => reactCommentToKind(c, kind)}
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
          {/* Post reaction cell: the Love toggle keeps its flat styling and
              LIKE-era default-tap wire; hold opens the tray and the chevron
              opens the same tray for keyboard/screen-reader users. */}
          <div className="relative flex min-w-0 items-stretch gap-0.5">
            <button
              type="button"
              id="detail-love"
              className="fb-report-action min-h-[44px] flex-1"
              onClick={() => {
                if (postPress.claimTap()) return;
                if (trayTarget !== null) {
                  postSlide.reset();
                  setTrayTarget(null);
                  return;
                }
                toggleLove();
              }}
              disabled={reactionPending}
              aria-busy={reactionPending}
              aria-label={postLoveLabel}
              aria-pressed={postActiveKind !== null}
              onPointerDown={(e) => {
                setPostHolding(true);
                postPress.onPointerDown(e);
              }}
              onPointerMove={postPress.onPointerMove}
              onPointerUp={() => {
                setPostHolding(false);
                postPress.onPointerUp();
              }}
              onPointerCancel={() => {
                setPostHolding(false);
                postPress.onPointerCancel();
              }}
            >
              {postSummary.total > 0 ? (
                <>
                  <ReactionPreviewStack counts={postSummary.counts} />
                  <span aria-hidden className="tabular-nums">{postSummary.total}</span>
                </>
              ) : (
                <>
                  <ReactionArt kind="LOVE" size={20} filled={postActiveKind !== null} />
                  <span aria-hidden className="tabular-nums">{postSummary.total}</span>
                </>
              )}
            </button>
            <button
              type="button"
              id="detail-choose-reaction"
              data-testid="detail-choose-reaction"
              aria-haspopup="menu"
              aria-expanded={trayTarget === "post"}
              aria-label="Choose reaction"
              className="fb-report-action min-h-[44px] min-w-[44px] shrink-0"
              disabled={reactionPending}
              onClick={() => {
                setTrayOpener("choose");
                setTrayTarget((t) => (t === "post" ? null : "post"));
              }}
            >
              <ChevronDown size={16} aria-hidden />
            </button>
            {trayTarget === "post" && (
              <span className="absolute bottom-full left-0 z-20 mb-1 w-max max-w-[80vw]">
                <ReactionTray
                  open
                  myReaction={myReaction}
                  counts={postSummary.counts}
                  total={postSummary.total}
                  pending={reactionPending}
                  hoveredKind={postHolding ? postSlide.hovered : undefined}
                  onHoverChange={postHolding ? postSlide.setHovered : undefined}
                  onSelect={reactToKind}
                  onClose={() => {
                    postSlide.reset();
                    setTrayTarget(null);
                  }}
                  triggerId={trayOpener === "choose" ? "detail-choose-reaction" : "detail-love"}
                />
              </span>
            )}
          </div>
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
            onSubmit={(body) => postCommentBody(body)}
            onError={commentFailed}
            onSent={() => setReplyTo(null)}
          />

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
                {visibleRoots.map((c) => renderComment(c, 0))}
              </ul>
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
