import { getStore } from "../db/index.js";
import { AppError, newId, nowIso } from "./helpers.js";
import { emitGateway } from "../realtime/gateway.js";

async function counts(postId: string): Promise<{ likeCount: number; dislikeCount: number }> {
  const store = getStore();
  const likeCount = await store.countReactions(postId, "LIKE");
  const dislikeCount = await store.countReactions(postId, "DISLIKE");
  return { likeCount, dislikeCount };
}

export interface ReactionResult {
  postId: string;
  likeCount: number;
  dislikeCount: number;
  myReaction: "LIKE" | "DISLIKE" | null;
}

/**
 * One reaction per user per post. `type` of null removes the reaction.
 * Switching LIKE <-> DISLIKE is an upsert in a single statement.
 */
export async function react(
  userId: string,
  postId: string,
  type: "LIKE" | "DISLIKE" | null,
): Promise<ReactionResult> {
  const exists = await getStore().findPostById(postId);
  if (!exists) throw new AppError(404, "Post not found");

  if (type === null) {
    await getStore().deleteReaction(postId, userId);
  } else {
    await getStore().upsertReaction({
      id: newId(),
      post_id: postId,
      user_id: userId,
      type,
      created_at: nowIso(),
    });
  }

  const c = await counts(postId);
  emitGateway("reaction:changed", { postId, ...c });
  return { postId, likeCount: c.likeCount, dislikeCount: c.dislikeCount, myReaction: type };
}

export async function myReaction(
  postId: string,
  userId: string,
): Promise<"LIKE" | "DISLIKE" | null> {
  const row = await getStore().findReaction(postId, userId);
  return row ? (String(row.type) as "LIKE" | "DISLIKE") : null;
}

export async function summary(postId: string): Promise<{
  ratingAvg: number | null;
  ratingCount: number;
  likeCount: number;
  dislikeCount: number;
}> {
  const stats = await getStore().ratingStats(postId);
  const c = await counts(postId);
  return {
    ratingAvg: stats.avg,
    ratingCount: stats.count,
    ...c,
  };
}
