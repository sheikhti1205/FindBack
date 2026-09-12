import type { CommentItem } from "@findback/shared";
import { addCommentSchema } from "@findback/shared";
import { all, get, run } from "../db/index.js";
import { AppError, newId, nowIso } from "./helpers.js";
import { emitGateway } from "../realtime/gateway.js";
import type { Row } from "../db/index.js";

function rowToComment(row: Row): CommentItem {
  const author = {
    id: String(row.user_id),
    username: String(row.author_username),
    email: String(row.author_email),
    phone: String(row.author_phone),
    emailVerified: Boolean(row.author_email_verified),
    phoneVerified: Boolean(row.author_phone_verified),
    avatarUrl: row.author_avatar_url ? String(row.author_avatar_url) : null,
    createdAt: String(row.author_created_at),
  };
  return {
    id: String(row.id),
    postId: String(row.post_id),
    author,
    body: String(row.body),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

const COMMENT_SELECT = `
  SELECT c.*, u.username AS author_username, u.email AS author_email,
         u.phone AS author_phone, u.email_verified AS author_email_verified,
         u.phone_verified AS author_phone_verified,
         u.avatar_url AS author_avatar_url, u.created_at AS author_created_at
  FROM comments c JOIN users u ON u.id = c.user_id
`;

export async function listComments(postId: string, limit = 200): Promise<CommentItem[]> {
  const rows = await all<Row>(
    `${COMMENT_SELECT} WHERE c.post_id = ? ORDER BY c.created_at ASC LIMIT ?`,
    [postId, limit],
  );
  return rows.map(rowToComment);
}

export async function addComment(userId: string, postId: string, raw: unknown): Promise<CommentItem> {
  const input = addCommentSchema.parse(raw);
  const exists = await get<Row>("SELECT id FROM item_posts WHERE id = ?", [postId]);
  if (!exists) throw new AppError(404, "Post not found");
  const id = newId();
  const now = nowIso();
  await run(
    `INSERT INTO comments (id, post_id, user_id, body, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, postId, userId, input.body.trim(), now, now],
  );
  const row = await get<Row>(`${COMMENT_SELECT} WHERE c.id = ?`, [id]);
  const comment = rowToComment(row!);
  emitGateway("comment:added", { postId, comment });
  return comment;
}

export async function deleteComment(
  userId: string,
  postId: string,
  commentId: string,
): Promise<void> {
  const comment = await get<Row>("SELECT * FROM comments WHERE id = ? AND post_id = ?", [
    commentId,
    postId,
  ]);
  if (!comment) throw new AppError(404, "Comment not found");
  const post = await get<Row>("SELECT user_id FROM item_posts WHERE id = ?", [postId]);
  const isOwner = String(comment.user_id) === userId;
  const isPostAuthor = post && String(post.user_id) === userId;
  if (!isOwner && !isPostAuthor) {
    throw new AppError(403, "You can only delete your own comments");
  }
  await run("DELETE FROM comments WHERE id = ?", [commentId]);
  emitGateway("comment:deleted", { postId, commentId });
}
