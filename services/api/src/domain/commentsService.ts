import type { CommentItem } from "@findback/shared";
import { addCommentSchema } from "@findback/shared";
import { getStore } from "../db/index.js";
import { AppError, newId, nowIso } from "./helpers.js";
import { emitGateway } from "../realtime/gateway.js";
import type { Row } from "../db/index.js";

function rowToComment(row: Row): CommentItem {
  const author = {
    id: String(row.user_id),
    username: String(row.author_username),
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

export async function listComments(postId: string, limit = 200): Promise<CommentItem[]> {
  const rows = await getStore().listComments(postId, limit);
  return rows.map(rowToComment);
}

export async function addComment(userId: string, postId: string, raw: unknown): Promise<CommentItem> {
  const input = addCommentSchema.parse(raw);
  const exists = await getStore().findPostById(postId);
  if (!exists) throw new AppError(404, "Post not found");
  const id = newId();
  const now = nowIso();
  await getStore().insertComment({
    id,
    post_id: postId,
    user_id: userId,
    body: input.body.trim(),
    created_at: now,
    updated_at: now,
  });
  const row = await getStore().findCommentWithAuthor(id);
  const comment = rowToComment(row!);
  emitGateway("comment:added", { postId, comment });
  return comment;
}

export async function deleteComment(
  userId: string,
  postId: string,
  commentId: string,
): Promise<void> {
  const comment = await getStore().findComment(commentId, postId);
  if (!comment) throw new AppError(404, "Comment not found");
  const postOwnerId = await getStore().getPostOwnerId(postId);
  const isOwner = String(comment.user_id) === userId;
  const isPostAuthor = postOwnerId === userId;
  if (!isOwner && !isPostAuthor) {
    throw new AppError(403, "You can only delete your own comments");
  }
  await getStore().deleteComment(commentId);
  emitGateway("comment:deleted", { postId, commentId });
}
