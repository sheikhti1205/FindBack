import { ratePostSchema } from "@findback/shared";
import { getStore } from "../db/index.js";
import { AppError, newId, nowIso } from "./helpers.js";
import { emitGateway } from "../realtime/gateway.js";
import { summary } from "./reactionsService.js";

export interface RatingResult {
  postId: string;
  score: number;
  ratingAvg: number | null;
  ratingCount: number;
}

/**
 * 1-5 stars, one rating per user per post; later ratings update the score.
 * Returns the live average/count so the UI can update without a refresh.
 */
export async function rate(userId: string, postId: string, raw: unknown): Promise<RatingResult> {
  const input = ratePostSchema.parse(raw);
  const exists = await getStore().findPostById(postId);
  if (!exists) throw new AppError(404, "Post not found");

  const existing = await getStore().findRating(postId, userId);
  const now = nowIso();
  if (existing) {
    await getStore().updateRatingScore(String(existing.id), input.score, now);
  } else {
    await getStore().insertRating({
      id: newId(),
      post_id: postId,
      user_id: userId,
      score: input.score,
      created_at: now,
      updated_at: now,
    });
  }

  const s = await summary(postId);
  emitGateway("rating:changed", {
    postId,
    ratingAvg: s.ratingAvg,
    ratingCount: s.ratingCount,
  });
  return { postId, score: input.score, ratingAvg: s.ratingAvg, ratingCount: s.ratingCount };
}

export async function myRating(postId: string, userId: string): Promise<number | null> {
  const row = await getStore().findRating(postId, userId);
  return row ? Number(row.score) : null;
}
