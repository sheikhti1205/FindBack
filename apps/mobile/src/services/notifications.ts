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

/** The signed-in user's notification inbox, newest first. */
export async function fetchNotifications(): Promise<NotificationItem[]> {
  const { data, error } = await getSupabase().rpc("findback_list_notifications_client", {});
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
