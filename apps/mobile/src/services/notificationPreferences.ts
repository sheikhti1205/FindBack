import { ApiError } from "./session";
import { getSupabase } from "./supabaseClient";

export interface NotificationPreferences {
  pushEnabled: boolean;
  likes: boolean;
  comments: boolean;
  mentions: boolean;
  status: boolean;
}

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  pushEnabled: true,
  likes: true,
  comments: true,
  mentions: true,
  status: true,
};

interface PreferenceRow {
  push_enabled: number | boolean;
  likes: number | boolean;
  comments: number | boolean;
  mentions: number | boolean;
  status: number | boolean;
}

function preferenceErrorStatus(code: string | undefined): number {
  if (code === "42501") return 403;
  if (code === "28000") return 401;
  return 400;
}

export function mapPreferences(row: PreferenceRow | undefined): NotificationPreferences {
  if (!row) return { ...DEFAULT_NOTIFICATION_PREFERENCES };
  return {
    pushEnabled: Boolean(row.push_enabled),
    likes: Boolean(row.likes),
    comments: Boolean(row.comments),
    mentions: Boolean(row.mentions),
    status: Boolean(row.status),
  };
}

/** The signed-in user's notification preferences (defaults when unset). */
export async function fetchNotificationPreferences(): Promise<NotificationPreferences> {
  const { data, error } = await getSupabase().rpc("findback_get_notification_preferences_client", {});
  if (error) throw new ApiError(error.message, preferenceErrorStatus(error.code));
  return mapPreferences(((data ?? []) as PreferenceRow[])[0]);
}

/** Persist the signed-in user's notification preferences. */
export async function saveNotificationPreferences(prefs: NotificationPreferences): Promise<void> {
  const { error } = await getSupabase().rpc("findback_set_notification_preferences_client", {
    p_push_enabled: prefs.pushEnabled,
    p_likes: prefs.likes,
    p_comments: prefs.comments,
    p_mentions: prefs.mentions,
    p_status: prefs.status,
  });
  if (error) throw new ApiError(error.message, preferenceErrorStatus(error.code));
}
