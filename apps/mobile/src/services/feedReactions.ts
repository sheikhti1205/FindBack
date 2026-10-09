import { ApiError } from "./session";
import { getSupabase } from "./supabaseClient";
import { reactToPost, type ReactionResult } from "./posts";
import {
  DEFAULT_REACTION_KIND,
  nextReactionForTap,
  normalizeReactionKind,
  reactionToggleDeltas,
  setPostReaction,
  type ReactionCounts,
  type ReactionKind,
  type ReactionSummary,
} from "./reactions";

/**
 * Home-feed Love/Unlove on the EXISTING reaction model (UXN-2):
 * - Love = LIKE (the canonical Love wire kind; LIKE counts toward LOVE)
 * - Unlove = null (reaction removed server-side)
 * - a DISLIKE switches to LIKE when Loved
 *
 * No separate LOVE kind is needed for this fast path — the multi-kind model in
 * `reactions.ts` maps LIKE to LOVE for display and adds the other kinds.
 */

export type { ReactionKind, ReactionSummary } from "./reactions";

export type CallerReaction = "LIKE" | "DISLIKE" | null;

export interface FeedReactionEntry {
  /** Caller's own reaction (raw wire kind; LIKE reads as LOVE for display). */
  myReaction: ReactionKind | null;
  myRating: number | null;
  /** Per-kind summary once a kind-aware write has returned it (W3.3). */
  summary?: ReactionSummary;
}

/** The batch RPC caps input at 20 post ids per call (mirrors the SQL guard). */
export const FEED_REACTION_BATCH_LIMIT = 20;

const FEED_REACTION_STATE_RPC = "findback_feed_reaction_state_client";

/** Love-toggle target: loved (LIKE or canonical LOVE) → null, else LIKE. */
export function nextLoveReaction(current: ReactionKind | null): "LIKE" | null {
  return current !== null && normalizeReactionKind(current) === "LOVE" ? null : "LIKE";
}

/**
 * Optimistic like/dislike count deltas for a Love toggle from `current`.
 * Non-Love kinds (HELPFUL/…) switch to LIKE: one like added, no legacy
 * dislike movement (their bucket lives in the per-kind summary).
 */
export function loveToggleDeltas(current: ReactionKind | null): { like: number; dislike: number } {
  if (current !== null && normalizeReactionKind(current) === "LOVE") return { like: -1, dislike: 0 };
  if (current === "DISLIKE") return { like: 1, dislike: -1 };
  return { like: 1, dislike: 0 };
}

interface FeedReactionStateRow {
  post_id: string;
  my_reaction: string | null;
  my_rating: number | null;
}

/**
 * Batch-hydrate the caller's own reaction/rating for a page of feed cards.
 *
 * One RPC call per <=20 ids (chunked client-side). The per-card
 * `fetchSocialState(postId)` RPC must never be used for feed hydration.
 * Ids the RPC returns no row for resolve to nulls. Never rejects on empty
 * input — it simply makes no call.
 */
export async function fetchFeedReactionState(
  postIds: readonly string[],
): Promise<Record<string, FeedReactionEntry>> {
  const unique = [...new Set(postIds.filter((id) => id !== ""))];
  const merged: Record<string, FeedReactionEntry> = {};
  if (unique.length === 0) return merged;
  for (let i = 0; i < unique.length; i += FEED_REACTION_BATCH_LIMIT) {
    const chunk = unique.slice(i, i + FEED_REACTION_BATCH_LIMIT);
    const { data, error } = await getSupabase().rpc(FEED_REACTION_STATE_RPC, {
      p_post_ids: chunk,
    });
    if (error) throw new ApiError(error.message, 400);
    for (const row of (data ?? []) as FeedReactionStateRow[]) {
      merged[row.post_id] = {
        myReaction: (row.my_reaction as ReactionKind | null) ?? null,
        myRating: row.my_rating == null ? null : Number(row.my_rating),
      };
    }
  }
  for (const id of unique) {
    merged[id] ??= { myReaction: null, myRating: null };
  }
  return merged;
}

/** Love/Unlove one post through the existing react RPC (LIKE / null). */
export async function toggleLoveReaction(
  postId: string,
  current: ReactionKind | null,
): Promise<ReactionResult> {
  return reactToPost(postId, nextLoveReaction(current));
}

/**
 * Multi-kind write path for the reaction tray (W3.3). Tapping the caller's
 * current kind clears it; otherwise the tapped kind (default Love) is set. The
 * optimistic delta for this move is `reactionToggleDeltas(current, next)`.
 */
export async function togglePostReactionKind(
  postId: string,
  current: ReactionKind | null,
  kind: ReactionKind = DEFAULT_REACTION_KIND,
): Promise<ReactionSummary> {
  return setPostReaction(postId, nextReactionForTap(current, kind));
}

/**
 * Legacy like/dislike bucket deltas for a kind move. Only raw LIKE/DISLIKE
 * rows touch the legacy buckets (canonical LOVE/HELPFUL/… live in the
 * per-kind summary); LIKE and LOVE are deliberately NOT merged here.
 */
export function legacyCountDeltas(
  current: ReactionKind | null,
  next: ReactionKind | null,
): { like: number; dislike: number } {
  return {
    like: (next === "LIKE" ? 1 : 0) - (current === "LIKE" ? 1 : 0),
    dislike: (next === "DISLIKE" ? 1 : 0) - (current === "DISLIKE" ? 1 : 0),
  };
}

/** Optimistic per-kind counts for a current→next move over `counts`. */
export function applyReactionDeltas(
  counts: ReactionCounts,
  current: ReactionKind | null,
  next: ReactionKind | null,
): ReactionCounts {
  const patched: ReactionCounts = { ...counts };
  for (const [kind, delta] of Object.entries(reactionToggleDeltas(current, next))) {
    const key = kind as ReactionKind;
    const value = (patched[key] ?? 0) + (delta ?? 0);
    if (value <= 0) delete patched[key];
    else patched[key] = value;
  }
  return patched;
}

/**
 * Seed a per-kind summary from a feed item's legacy counts (W3.3 feed
 * hydration: the batch RPC carries no counts, so the item's like/dislike
 * counts ARE the LOVE/DISLIKE buckets until a write returns server truth).
 * A canonical own reaction (LOVE/HELPFUL/…) is not counted in the legacy
 * buckets, so its bucket gains +1; a raw LIKE/DISLIKE own reaction is already
 * inside the legacy counts and gains nothing.
 */
export function seedSummaryFromItem(
  likeCount: number,
  dislikeCount: number,
  myReaction: ReactionKind | null,
): ReactionSummary {
  const counts: ReactionCounts = {};
  if (likeCount > 0) counts.LOVE = likeCount;
  if (dislikeCount > 0) counts.DISLIKE = dislikeCount;
  if (myReaction !== null && myReaction !== "LIKE" && myReaction !== "DISLIKE") {
    const key = normalizeReactionKind(myReaction);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  const total = Object.values(counts).reduce<number>((sum, n) => sum + (n ?? 0), 0);
  return { counts, myReaction, total };
}
