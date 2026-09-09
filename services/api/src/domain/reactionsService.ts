import { get, run } from "../db/db.js";
import { AppError, newId, nowIso } from "./helpers.js";
import { emitGateway } from "../realtime/gateway.js";
import type { Row } from "../db/db.js";

function counts(postId: string): { likeCount: number; dislikeCount: number } {
  const like = get<Row>(
    "SELECT COUNT(*) AS c FROM reactions WHERE post_id = ? AND type = 'LIKE'",
    [postId],
  );
  const dislike = get<Row>(
    "SELECT COUNT(*) AS c FROM reactions WHERE post_id = ? AND type = 'DISLIKE'",
    [postId],
  );
  return { likeCount: Number(like?.c ?? 0), dislikeCount: Number(dislike?.c ?? 0) };
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
export function react(userId: string, postId: string, type: "LIKE" | "DISLIKE" | null): ReactionResult {
  const exists = get<Row>("SELECT id FROM item_posts WHERE id = ?", [postId]);
  if (!exists) throw new AppError(404, "Post not found");

  if (type === null) {
    run("DELETE FROM reactions WHERE post_id = ? AND user_id = ?", [postId, userId]);
  } else {
    run(
      `INSERT INTO reactions (id, post_id, user_id, type, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(post_id, user_id) DO UPDATE SET type = excluded.type`,
      [newId(), postId, userId, type, nowIso()],
    );
  }

  const c = counts(postId);
  emitGateway("reaction:changed", { postId, ...c });
  return { postId, likeCount: c.likeCount, dislikeCount: c.dislikeCount, myReaction: type };
}

export function myReaction(postId: string, userId: string): "LIKE" | "DISLIKE" | null {
  const row = get<Row>("SELECT type FROM reactions WHERE post_id = ? AND user_id = ?", [
    postId,
    userId,
  ]);
  return row ? (String(row.type) as "LIKE" | "DISLIKE") : null;
}

export function summary(postId: string): { ratingAvg: number | null; ratingCount: number; likeCount: number; dislikeCount: number } {
  const row = get<Row>(
    `SELECT (SELECT AVG(score) FROM ratings WHERE post_id = ?) AS avg,
            (SELECT COUNT(*) FROM ratings WHERE post_id = ?) AS cnt`,
    [postId, postId],
  );
  const c = counts(postId);
  return {
    ratingAvg: row?.avg == null ? null : Math.round(Number(row.avg) * 100) / 100,
    ratingCount: Number(row?.cnt ?? 0),
    ...c,
  };
}
