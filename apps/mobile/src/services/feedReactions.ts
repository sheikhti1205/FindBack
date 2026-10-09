import { ApiError } from "./session";
import { getSupabase } from "./supabaseClient";
import { reactToPost, type ReactionResult } from "./posts";
import {
  DEFAULT_REACTION_KIND,
  nextReactionForTap,
  setPostReaction,
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
  myReaction: CallerReaction;
  myRating: number | null;
}

/** The batch RPC caps input at 20 post ids per call (mirrors the SQL guard). */
export const FEED_REACTION_BATCH_LIMIT = 20;

const FEED_REACTION_STATE_RPC = "findback_feed_reaction_state_client";

/** Love-toggle target for a caller reaction: LIKE→null, else LIKE. */
export function nextLoveReaction(current: CallerReaction): "LIKE" | null {
  return current === "LIKE" ? null : "LIKE";
}

/** Optimistic like/dislike count deltas for a Love toggle from `current`. */
export function loveToggleDeltas(current: CallerReaction): { like: number; dislike: number } {
  if (current === "LIKE") return { like: -1, dislike: 0 };
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
        myReaction: (row.my_reaction as CallerReaction) ?? null,
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
  current: CallerReaction,
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
