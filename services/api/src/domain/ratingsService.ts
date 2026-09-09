import { ratePostSchema } from "@findback/shared";
import { get, run } from "../db/db.js";
import { AppError, newId, nowIso } from "./helpers.js";
import { emitGateway } from "../realtime/gateway.js";
import { summary } from "./reactionsService.js";
import type { Row } from "../db/db.js";

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
export function rate(userId: string, postId: string, raw: unknown): RatingResult {
  const input = ratePostSchema.parse(raw);
  const exists = get<Row>("SELECT id FROM item_posts WHERE id = ?", [postId]);
  if (!exists) throw new AppError(404, "Post not found");

  const existing = get<Row>("SELECT id FROM ratings WHERE post_id = ? AND user_id = ?", [
    postId,
    userId,
  ]);
  const now = nowIso();
  if (existing) {
    run("UPDATE ratings SET score = ?, updated_at = ? WHERE id = ?", [
      input.score,
      now,
      String(existing.id),
    ]);
  } else {
    run(
      `INSERT INTO ratings (id, post_id, user_id, score, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [newId(), postId, userId, input.score, now, now],
    );
  }

  const s = summary(postId);
  emitGateway("rating:changed", {
    postId,
    ratingAvg: s.ratingAvg,
    ratingCount: s.ratingCount,
  });
  return { postId, score: input.score, ratingAvg: s.ratingAvg, ratingCount: s.ratingCount };
}

export function myRating(postId: string, userId: string): number | null {
  const row = get<Row>("SELECT score FROM ratings WHERE post_id = ? AND user_id = ?", [
    postId,
    userId,
  ]);
  return row ? Number(row.score) : null;
}
