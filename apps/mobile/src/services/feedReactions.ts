import { ApiError } from "./session";
import { getSupabase } from "./supabaseClient";
import { reactToPost, type ReactionResult } from "./posts";
import {
  nextLikeReaction,
  normalizeReactionKind,
  type ReactionKind,
  type ReactionSummary,
} from "./reactions";

/**
 * Home-feed Like handling on the existing reaction row (packet `08` §2):
 * - Like writes the `LIKE` wire kind; the SQL folds it into LOVE for every
 *   count it returns, so one Like rule covers the feed, the detail page and the
 *   legacy `like_count` column.
 * - Unlike writes null and the caller's row is removed server-side.
 * - A caller already holding a positive reaction (a canonical LOVE/HELPFUL/
 *   SUPPORT/WOW row from the multi-kind era) is "mine": their Like clears it.
 *   A caller holding a legacy DISLIKE gets one Like added and their DISLIKE
 *   dropped — the RPC keeps exactly one row per caller per target.
 *
 * The per-card Like count is the caller's own state plus the card's legacy
 * `like_count` (raw LIKE rows). Canonical-era rows are visible on the detail
 * page's per-kind counts; folding them into the feed projection is a backend
 * contract change recorded in the CF-030 brief, not a client display decision.
 */

export type { ReactionKind, ReactionSummary } from "./reactions";

export type CallerReaction = "LIKE" | "DISLIKE" | null;

export interface FeedReactionEntry {
  /** Caller's own reaction (raw wire kind; LIKE reads as its canonical LOVE). */
  myReaction: ReactionKind | null;
  myRating: number | null;
  /** Per-kind summary once a write has returned it. */
  summary?: ReactionSummary;
}

/** The batch RPC caps input at 20 post ids per call (mirrors the SQL guard). */
export const FEED_REACTION_BATCH_LIMIT = 20;

const FEED_REACTION_STATE_RPC = "findback_feed_reaction_state_client";

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

/** Like/Unlike one post through the existing react RPC (`LIKE` / null). */
export async function toggleLikeReaction(
  postId: string,
  current: ReactionKind | null,
): Promise<ReactionResult> {
  return reactToPost(postId, nextLikeReaction(current));
}

/**
 * Legacy `like_count` / `dislike_count` deltas for a current→next move. Only
 * raw LIKE/DISLIKE rows touch those columns; a canonical LOVE/HELPFUL row is
 * invisible to them (it lives in the per-kind summary).
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

/** The legacy-column deltas a Like tap produces from the caller's own reaction. */
export function likeBucketDeltas(current: ReactionKind | null): { like: number; dislike: number } {
  return legacyCountDeltas(current, nextLikeReaction(current));
}

/**
 * Seed a per-kind summary from a feed item's legacy counts (the batch RPC
 * carries no counts, so the item's like/dislike counts ARE the LOVE/DISLIKE
 * buckets until a write returns server truth). A canonical own reaction
 * (LOVE/HELPFUL/…) is not counted in the legacy buckets, so its bucket gains
 * +1; a raw LIKE/DISLIKE own reaction is already inside the legacy counts and
 * gains nothing.
 */
export function seedSummaryFromItem(
  likeCount: number,
  dislikeCount: number,
  myReaction: ReactionKind | null,
): ReactionSummary {
  const counts: ReactionSummary["counts"] = {};
  if (likeCount > 0) counts.LOVE = likeCount;
  if (dislikeCount > 0) counts.DISLIKE = dislikeCount;
  if (myReaction !== null && myReaction !== "LIKE" && myReaction !== "DISLIKE") {
    const key = normalizeReactionKind(myReaction);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  const total = Object.values(counts).reduce<number>((sum, n) => sum + (n ?? 0), 0);
  return { counts, myReaction, total };
}
