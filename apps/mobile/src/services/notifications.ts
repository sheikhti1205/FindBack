import { ApiError } from "./session";
import { getSupabase } from "./supabaseClient";

export type NotificationType = "LIKE" | "DISLIKE" | "COMMENT" | "MENTION" | "STATUS";

export interface NotificationItem {
  id: string;
  type: NotificationType;
  preview: string | null;
  read: boolean;
  createdAt: string;
  /** Null only for system STATUS rows (no actor performed them). */
  actorId: string | null;
  /** Null only for system STATUS rows; render a system label then. */
  actorUsername: string | null;
  postId: string | null;
  postTitle: string | null;
  commentId: string | null;
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
}

function mapNotification(row: NotificationRow): NotificationItem {
  return {
    id: row.id,
    type: row.type as NotificationType,
    preview: row.preview ?? null,
    read: Boolean(row.read),
    createdAt: row.created_at,
    actorId: row.actor_id ?? null,
    actorUsername: row.actor_username ?? null,
    postId: row.post_id ?? null,
    postTitle: row.post_title ?? null,
    commentId: row.comment_id ?? null,
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
