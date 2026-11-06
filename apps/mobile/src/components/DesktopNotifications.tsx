import { useLayoutEffect } from "react";
import { useNavigate } from "react-router";
import { useAuth } from "../auth";
import { onRealtime } from "../services/realtime";
import { fetchNotifications, type NotificationItem } from "../services/notifications";
import { closeDesktopNotifications, desktopNotificationsEnabled, showDesktopNotification } from "../services/desktopNotifications";
import { fetchNotificationPreferences, type NotificationPreferences } from "../services/notificationPreferences";
import { notificationRoute, typeLabel } from "../screens/Notifications";

/** One sentence for the OS notification; the inbox row stays the full record. */
function describe(item: NotificationItem): { title: string; body: string } {
  if (item.blockedActor) return { title: "New activity in Norfold", body: "Open your inbox to review it." };
  const who = item.actorUsername ? `@${item.actorUsername}` : "Norfold";
  return {
    title: `${who} ${typeLabel(item.type)}`,
    body: item.preview?.trim() || item.postTitle?.trim() || "Open Norfold to see what changed.",
  };
}

function enabled(item: NotificationItem, prefs: NotificationPreferences): boolean {
  if (!prefs.pushEnabled) return false;
  switch (item.type) {
    case "COMMENT": return prefs.comments;
    case "MENTION": return prefs.mentions;
    case "LIKE": case "DISLIKE": case "REACTION": return prefs.likes;
    default: return prefs.status;
  }
}

/**
 * Raises desktop notifications for new inbox activity.
 *
 * The Realtime signal is deliberately data-free (a snooper on the private topic
 * learns only that a row was inserted), so the content comes from the caller's
 * own auth-scoped inbox. Nothing is shown while the reader is looking at the
 * app, and nothing is shown without an explicit opt-in plus a granted browser
 * permission — see services/desktopNotifications.ts.
 */
export function DesktopNotifications() {
  const { user } = useAuth();
  const navigate = useNavigate();
  useLayoutEffect(() => {
    if (!user) return;
    const accountId = user.id;
    let cancelled = false;
    const startedAt = Date.now();
    const off = onRealtime("notification:added", () => {
      if (cancelled || document.visibilityState === "visible") return;
      if (!desktopNotificationsEnabled(accountId)) return;
      void Promise.all([fetchNotifications(), fetchNotificationPreferences()]).then(([items, prefs]) => {
        if (cancelled || document.visibilityState === "visible") return;
        // A data-free signal is not proof that the first unread row is new.
        // Never replay old unread activity or disclose shielded previews.
        for (const item of items.filter(item => !item.read && Date.parse(item.createdAt) >= startedAt && enabled(item, prefs)).slice(0, 5)) {
          showDesktopNotification(accountId, {
            ...describe(item), tag: item.id,
            onClick: () => { if (!cancelled) navigate(notificationRoute(item) ?? "/notifications"); },
          });
        }
      }).catch(() => undefined);
    });
    return () => {
      cancelled = true;
      off();
      closeDesktopNotifications(accountId);
    };
  }, [user, navigate]);
  return null;
}
