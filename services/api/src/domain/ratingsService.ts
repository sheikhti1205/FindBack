import { ratePostSchema } from "@findback/shared";
import { get, run } from "../db/index.js";
import { AppError, newId, nowIso } from "./helpers.js";
import { emitGateway } from "../realtime/gateway.js";
import { summary } from "./reactionsService.js";
import type { Row } from "../db/index.js";

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
  const exists = await get<Row>("SELECT id FROM item_posts WHERE id = ?", [postId]);
  if (!exists) throw new AppError(404, "Post not found");

  const existing = await get<Row>("SELECT id FROM ratings WHERE post_id = ? AND user_id = ?", [
    postId,
    userId,
  ]);
  const now = nowIso();
  if (existing) {
    await run("UPDATE ratings SET score = ?, updated_at = ? WHERE id = ?", [
      input.score,
      now,
      String(existing.id),
    ]);
  } else {
    await run(
      `INSERT INTO ratings (id, post_id, user_id, score, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [newId(), postId, userId, input.score, now, now],
    );
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
  const row = await get<Row>("SELECT score FROM ratings WHERE post_id = ? AND user_id = ?", [
    postId,
    userId,
  ]);
  return row ? Number(row.score) : null;
}
