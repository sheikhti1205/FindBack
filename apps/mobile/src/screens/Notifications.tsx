import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { Bell } from "lucide-react";
import { BackButton } from "../components/BackButton";
import {
  fetchNotifications,
  markNotificationsRead,
  type NotificationItem,
  type NotificationType,
} from "../services/notifications";
import { friendlyError } from "../utils/friendlyErrors";
import { formatTimestamp, timeAgo } from "../utils/dates";

function typeLabel(type: NotificationType): string {
  switch (type) {
    case "LIKE":
      return "liked your report";
    case "DISLIKE":
      return "disliked your report";
    case "COMMENT":
      return "commented on your report";
    case "MENTION":
      return "mentioned you";
    case "STATUS":
      return "status update";
  }
}

export function Notifications() {
  const [items, setItems] = useState<NotificationItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const rows = await fetchNotifications();
      setItems(rows);
      if (rows.some((row) => !row.read)) {
        await markNotificationsRead();
        setItems(rows.map((row) => ({ ...row, read: true })));
      }
    } catch (err) {
      setError(friendlyError(err).message);
    }
  }, []);

  useEffect(() => {
    void load();
    // Pull the inbox again when the app regains focus (badge + list agree).
    const onFocus = () => void load();
    const onVisibility = () => {
      if (document.visibilityState === "visible") void load();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load]);

  return (
    <div className="flex min-h-full flex-col px-4 py-5">
      <header className="flex items-center gap-2">
        <BackButton fallbackTo="/" label="Back to home" />
        <h1 className="text-xl font-semibold tracking-tight">Notifications</h1>
      </header>

      {error ? (
        <section className="flex flex-1 flex-col items-center justify-center gap-3 px-4 py-12 text-center">
          <p role="alert" className="text-sm text-on-surface-variant">{error}</p>
          <button
            type="button"
            onClick={() => void load()}
            className="flex min-h-[48px] items-center rounded-m3-xs bg-primary px-4 text-sm font-medium text-on-primary"
          >
            Try again
          </button>
        </section>
      ) : items === null ? (
        <section className="flex flex-1 flex-col items-center justify-center gap-3 px-4 py-12 text-center">
          <p role="status" className="text-sm text-on-surface-variant">Loading notifications…</p>
        </section>
      ) : items.length === 0 ? (
        <section
          className="flex flex-1 flex-col items-center justify-center gap-3 px-4 py-12 text-center"
          aria-labelledby="notifications-empty-title"
        >
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-surface-container text-on-surface-variant">
            <Bell size={28} aria-hidden />
          </div>
          <h2 id="notifications-empty-title" className="text-lg font-semibold">No notifications</h2>
          <p className="max-w-xs text-sm text-on-surface-variant">
            You&apos;re all caught up. Likes, comments, and mentions on your reports will show up here.
          </p>
        </section>
      ) : (
        <ul className="flex flex-col gap-2 py-4" aria-label="Notifications">
          {items.map((item) => (
            <li key={item.id}>
              {item.postId ? (
                <Link
                  to={`/posts/${item.postId}`}
                  aria-label={`${item.actorUsername ?? "FindBack"} ${typeLabel(item.type)}: ${item.postTitle ?? "your report"}`}
                  className={`flex flex-col gap-1 rounded-m3-md border p-3 ${
                    item.read ? "border-outline-variant" : "border-primary bg-surface-container"
                  }`}
                >
                  <NotificationBody item={item} />
                </Link>
              ) : (
                <div
                  className={`flex flex-col gap-1 rounded-m3-md border p-3 ${
                    item.read ? "border-outline-variant" : "border-primary bg-surface-container"
                  }`}
                >
                  <NotificationBody item={item} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function NotificationBody({ item }: { item: NotificationItem }) {
  return (
    <>
      <div className="flex items-center gap-2">
        {!item.read && (
          <span
            aria-label="Unread"
            className="h-2 w-2 shrink-0 rounded-full bg-primary"
          />
        )}
        <p className="text-sm">
          <span className="font-semibold">{item.actorUsername ?? "FindBack"}</span>{" "}
          <span className="text-on-surface-variant">{typeLabel(item.type)}</span>
        </p>
      </div>
      {item.postTitle ? (
        <p className="text-sm font-medium">{item.postTitle}</p>
      ) : null}
      {item.preview && item.preview !== item.postTitle ? (
        <p className="line-clamp-2 text-sm text-on-surface-variant">{item.preview}</p>
      ) : null}
      <time
        dateTime={item.createdAt}
        title={formatTimestamp(item.createdAt)}
        className="text-xs text-on-surface-variant"
      >
        {timeAgo(item.createdAt)}
      </time>
    </>
  );
}
