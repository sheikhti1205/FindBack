import type { NotificationType, ReactionKind } from "@findback/shared";
import { isReactionKind } from "./reactions";
import { ApiError } from "./session";
import { getSupabase } from "./supabaseClient";

export type { NotificationType };

export interface NotificationItem {
  id: string;
  type: NotificationType;
  preview: string | null;
  read: boolean;
  createdAt: string;
  /** Null for system STATUS/MODERATION rows (no public actor is projected). */
  actorId: string | null;
  /** Null for system STATUS/MODERATION rows; render a system label then. */
  actorUsername: string | null;
  postId: string | null;
  postTitle: string | null;
  commentId: string | null;
  /**
   * Canonical reaction kind carried by REACTION rows (W1-A). Null on every
   * legacy row (LIKE/DISLIKE/COMMENT/MENTION/STATUS): absence renders the
   * generic reaction copy, never a wrong kind.
   */
  reactionKind: ReactionKind | null;
  /**
   * O5 block signal (CF-060 B1): true when the caller is blocked with this
   * row's actor. Caller-scoped and direction-free — it never says who blocked
   * whom, and it never says whether the block exists at all on the actor's
   * side. The row is returned either way (the block half of D21 is superseded
   * by O5: a notification is a pointer to content the caller can still see,
   * so it is screened in place, never dropped).
   *
   * ABSENT when the backend does not project the bit (a backend older than
   * the notification reader that projects it) or when the column is not a
   * real boolean: absence is the pre-R10 rendering — no shield, no warning,
   * no crash — and it is exactly the canonical absent-preserving bit of
   * `services/posts.ts`. Absent and `false` render identically; the
   * difference between them is only that "the backend does not project this
   * bit" stays distinguishable from "the bit is false".
   */
  blockedActor?: boolean;
}

interface NotificationRow {
  id: string;
  type: string;
  preview: string | null;
  read: number | boolean | null;
  created_at: string;
  actor_id: string | null;
  actor_username: string | null;
  post_id: string | null;
  post_title: string | null;
  comment_id: string | null;
  reaction_kind?: unknown;
  /** O5 signal; absent on a backend older than the column. */
  blocked_actor?: unknown;
}

/**
 * O5 block bit (CF-060 B1). Only a real boolean is accepted: an older backend
 * omits the key, and a stringly-typed value must never be read as `true`.
 * Returns a spreadable fragment so an absent key stays absent — exactly the
 * canonical bit of `services/posts.ts` — and the shield treats absent exactly
 * as `false` (the pre-R10 rendering).
 */
function blockedActorFromRow(row: { blocked_actor?: unknown }): { blockedActor?: boolean } {
  return typeof row.blocked_actor === "boolean" ? { blockedActor: row.blocked_actor } : {};
}

function isNotificationType(value: unknown): value is NotificationType {
  return (
    value === "LIKE" ||
    value === "DISLIKE" ||
    value === "COMMENT" ||
    value === "MENTION" ||
    value === "STATUS" ||
    value === "REACTION" ||
    value === "MODERATION"
  );
}

function mapNotification(row: NotificationRow): NotificationItem {
  return {
    id: row.id,
    // Fail-safe: unknown future DB kinds become client-only UNKNOWN and
    // render generic copy (never an unvalidated cast into the UI).
    type: isNotificationType(row.type) ? row.type : "UNKNOWN",
    preview: row.preview ?? null,
    read: Boolean(row.read),
    createdAt: row.created_at,
    actorId: row.actor_id ?? null,
    actorUsername: row.actor_username ?? null,
    postId: row.post_id ?? null,
    postTitle: row.post_title ?? null,
    commentId: row.comment_id ?? null,
    reactionKind: isReactionKind(row.reaction_kind) ? row.reaction_kind : null,
    // Only a real boolean counts: a stringly-typed value must never be read
    // as `true`, and an absent column (older backend) stays absent.
    ...blockedActorFromRow(row),
  };
}

function notificationErrorStatus(code: string | undefined): number {
  if (code === "42501") return 403;
  if (code === "P0002") return 404;
  if (code === "28000") return 401;
  return 400;
}

/**
 * The signed-in user's notification inbox, newest first. Pass
 * `{ deleted: true }` for the soft-deleted view used by restore.
 */
export async function fetchNotifications(
  options: { deleted?: boolean } = {},
): Promise<NotificationItem[]> {
  const { data, error } = await getSupabase().rpc("findback_list_notifications_client", {
    p_deleted: options.deleted ?? false,
  });
  if (error) throw new ApiError(error.message, notificationErrorStatus(error.code));
  return ((data ?? []) as NotificationRow[]).map(mapNotification);
}

/** Count of unread notifications for the signed-in user. */
export async function fetchUnreadCount(): Promise<number> {
  const { data, error } = await getSupabase().rpc("findback_notification_count_client", {});
  if (error) throw new ApiError(error.message, notificationErrorStatus(error.code));
  return Number(data ?? 0);
}

/**
 * Mark notifications read. With ids, only those (owned) rows; without ids,
 * the whole owned inbox. Returns the number of rows updated.
 */
export async function markNotificationsRead(ids?: readonly string[]): Promise<number> {
  const { data, error } = await getSupabase().rpc("findback_mark_notifications_read_client", {
    p_ids: ids ? [...ids] : null,
  });
  if (error) throw new ApiError(error.message, notificationErrorStatus(error.code));
  return Number(data ?? 0);
}

/** Mark notifications unread. With ids, only those (owned) rows; without, all. */
export async function markNotificationsUnread(ids?: readonly string[]): Promise<number> {
  const { data, error } = await getSupabase().rpc("findback_mark_notifications_unread_client", {
    p_ids: ids ? [...ids] : null,
  });
  if (error) throw new ApiError(error.message, notificationErrorStatus(error.code));
  return Number(data ?? 0);
}

/**
 * Soft-delete notifications. With ids, only those (owned) rows; without, the
 * whole active inbox. Rows stay recoverable through {@link restoreNotifications}.
 */
export async function deleteNotifications(ids?: readonly string[]): Promise<number> {
  const { data, error } = await getSupabase().rpc("findback_delete_notifications_client", {
    p_ids: ids ? [...ids] : null,
  });
  if (error) throw new ApiError(error.message, notificationErrorStatus(error.code));
  return Number(data ?? 0);
}

/** Restore soft-deleted notifications. With ids, only those; without, all. */
export async function restoreNotifications(ids?: readonly string[]): Promise<number> {
  const { data, error } = await getSupabase().rpc("findback_restore_notifications_client", {
    p_ids: ids ? [...ids] : null,
  });
  if (error) throw new ApiError(error.message, notificationErrorStatus(error.code));
  return Number(data ?? 0);
}
