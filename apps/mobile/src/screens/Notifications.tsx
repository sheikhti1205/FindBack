import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { motion, type PanInfo } from "framer-motion";
import { Bell, RotateCcw, Settings, Trash2 } from "lucide-react";
import { BackButton } from "../components/BackButton";
import { UserAvatar } from "../components/UserAvatar";
import {
  deleteNotifications,
  fetchNotifications,
  markNotificationsRead,
  markNotificationsUnread,
  restoreNotifications,
  type NotificationItem,
  type NotificationType,
} from "../services/notifications";
import { signalInboxChanged } from "../services/notificationSignals";
import { onRealtime } from "../services/realtime";
import { friendlyError } from "../utils/friendlyErrors";
import { formatTimestamp, timeAgo } from "../utils/dates";

/** How long the undo affordance stays available after a delete. */
export const UNDO_WINDOW_MS = 5000;
/** Horizontal drag distance (px) that commits a swipe action. */
export const SWIPE_THRESHOLD_PX = 72;

/** Pure swipe decision: right toggles read, left deletes, short drags do nothing. */
export function swipeActionFor(offsetX: number): "toggle-read" | "delete" | null {
  if (offsetX <= -SWIPE_THRESHOLD_PX) return "delete";
  if (offsetX >= SWIPE_THRESHOLD_PX) return "toggle-read";
  return null;
}

/**
 * Tap destination on the same allowlisted contract as share links and push
 * taps: comments focus the exact comment, reactions open activity, status
 * opens management. Never passes a raw external path into the router.
 */
export function notificationRoute(item: {
  postId: string | null;
  commentId: string | null;
  type: NotificationType;
}): string | null {
  if (!item.postId) return null;
  if ((item.type === "COMMENT" || item.type === "MENTION") && item.commentId) {
    return `/posts/${item.postId}?comment=${encodeURIComponent(item.commentId)}#detail-comments`;
  }
  if (item.type === "COMMENT" || item.type === "MENTION") {
    return `/posts/${item.postId}#detail-comments`;
  }
  if (item.type === "LIKE" || item.type === "DISLIKE" || item.type === "REACTION") {
    return `/posts/${item.postId}#detail-activity`;
  }
  if (item.type === "STATUS") return `/posts/${item.postId}#detail-manage`;
  return `/posts/${item.postId}`;
}

function typeLabel(type: NotificationType): string {
  switch (type) {
    case "LIKE":
      return "liked your report";
    case "DISLIKE":
      return "disliked your report";
    case "REACTION":
      return "reacted to your report";
    case "COMMENT":
      return "commented on your report";
    case "MENTION":
      return "mentioned you";
    case "STATUS":
      return "status update";
  }
}

type InboxView = "inbox" | "deleted";

export function Notifications() {
  const [view, setView] = useState<InboxView>("inbox");
  const [items, setItems] = useState<NotificationItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastDeleted, setLastDeleted] = useState<readonly string[] | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearUndo = useCallback(() => {
    if (undoTimer.current !== null) {
      clearTimeout(undoTimer.current);
      undoTimer.current = null;
    }
    setLastDeleted(null);
  }, []);

  useEffect(
    () => () => {
      if (undoTimer.current !== null) clearTimeout(undoTimer.current);
    },
    [],
  );

  const load = useCallback(async (target: InboxView) => {
    setError(null);
    try {
      setItems(await fetchNotifications({ deleted: target === "deleted" }));
    } catch (err) {
      setError(friendlyError(err).message);
    }
  }, []);

  useEffect(() => {
    void load(view);
    if (view === "deleted") return;
    const onFocus = () => void load("inbox");
    const onVisibility = () => {
      if (document.visibilityState === "visible") void load("inbox");
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load, view]);

  useEffect(() => {
    if (view !== "inbox") return;
    // Private inbox signal: refresh the list when a new notification lands.
    return onRealtime("notification:added", () => void load("inbox"));
  }, [load, view]);

  const updateItem = useCallback((id: string, patch: Partial<NotificationItem>) => {
    setItems((current) =>
      current ? current.map((item) => (item.id === id ? { ...item, ...patch } : item)) : current,
    );
  }, []);

  const handleMarkRead = useCallback(
    async (id: string) => {
      updateItem(id, { read: true });
      try {
        await markNotificationsRead([id]);
        signalInboxChanged();
      } catch {
        updateItem(id, { read: false });
      }
    },
    [updateItem],
  );

  const handleMarkUnread = useCallback(
    async (id: string) => {
      updateItem(id, { read: false });
      try {
        await markNotificationsUnread([id]);
        signalInboxChanged();
      } catch {
        updateItem(id, { read: true });
      }
    },
    [updateItem],
  );

  const handleMarkAllRead = useCallback(async () => {
    const previous = items;
    setItems((current) => current?.map((item) => ({ ...item, read: true })) ?? current);
    try {
      await markNotificationsRead();
      signalInboxChanged();
    } catch {
      setItems(previous);
    }
  }, [items]);

  const handleDelete = useCallback(
    async (ids: readonly string[]) => {
      const previous = items;
      setItems((current) => current?.filter((item) => !ids.includes(item.id)) ?? current);
      setLastDeleted(ids);
      if (undoTimer.current !== null) clearTimeout(undoTimer.current);
      undoTimer.current = setTimeout(() => {
        undoTimer.current = null;
        setLastDeleted(null);
      }, UNDO_WINDOW_MS);
      try {
        await deleteNotifications([...ids]);
        signalInboxChanged();
      } catch (err) {
        if (undoTimer.current !== null) {
          clearTimeout(undoTimer.current);
          undoTimer.current = null;
        }
        setItems(previous);
        setLastDeleted(null);
        setError(friendlyError(err).message);
      }
    },
    [items],
  );

  const handleUndoDelete = useCallback(async () => {
    if (!lastDeleted) return;
    const ids = lastDeleted;
    clearUndo();
    try {
      await restoreNotifications([...ids]);
      signalInboxChanged();
    } catch (err) {
      setError(friendlyError(err).message);
    }
    await load("inbox");
  }, [lastDeleted, clearUndo, load]);

  const handleRestore = useCallback(
    async (ids: readonly string[]) => {
      setItems((current) => current?.filter((item) => !ids.includes(item.id)) ?? current);
      try {
        await restoreNotifications([...ids]);
        signalInboxChanged();
      } catch (err) {
        setError(friendlyError(err).message);
        await load("deleted");
      }
    },
    [load],
  );

  const unreadCount = items?.filter((item) => !item.read).length ?? 0;

  return (
    <div className="flex min-h-full flex-col px-4 py-5">
      <header className="flex flex-wrap items-center gap-2">
        <BackButton fallbackTo="/" label="Back to home" />
        <h1 className="text-xl font-semibold tracking-tight">Notifications</h1>
        <div className="ml-auto flex items-center gap-1">
          {view === "inbox" && unreadCount > 0 && (
            <button
              type="button"
              onClick={() => void handleMarkAllRead()}
              className="min-h-[44px] rounded-full px-3 text-sm font-medium text-on-surface underline"
            >
              Mark all read
            </button>
          )}
          <Link
            to="/settings/notifications"
            aria-label="Notification settings"
            className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full px-2 text-on-surface-variant"
          >
            <Settings size={18} aria-hidden />
          </Link>
          <button
            type="button"
            onClick={() => {
              setView((current) => (current === "inbox" ? "deleted" : "inbox"));
              clearUndo();
            }}
            aria-pressed={view === "deleted"}
            className="min-h-[44px] rounded-full border border-outline-variant px-3 text-sm font-medium text-on-surface"
          >
            {view === "inbox" ? "Deleted" : "Inbox"}
          </button>
        </div>
      </header>

      {error ? (
        <section className="flex flex-1 flex-col items-center justify-center gap-3 px-4 py-12 text-center">
          <p role="alert" className="text-sm text-on-surface-variant">{error}</p>
          <button
            type="button"
            onClick={() => void load(view)}
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
          <h2 id="notifications-empty-title" className="text-lg font-semibold">
            {view === "deleted" ? "No deleted notifications" : "No notifications"}
          </h2>
          <p className="max-w-xs text-sm text-on-surface-variant">
            {view === "deleted"
              ? "Deleted notifications you can restore will appear here."
              : "You're all caught up. Reactions, comments, and mentions on your reports will show up here."}
          </p>
        </section>
      ) : (
        <ul className="flex flex-col gap-2 py-4" aria-label="Notifications">
          {items.map((item) => (
            <li key={item.id}>
              <motion.div
                drag={view === "inbox" ? "x" : false}
                dragDirectionLock
                dragConstraints={{ left: 0, right: 0 }}
                dragElastic={0.25}
                onDragEnd={(_event, info: PanInfo) => {
                  if (view !== "inbox") return;
                  const action = swipeActionFor(info.offset.x);
                  if (action === "delete") void handleDelete([item.id]);
                  else if (action === "toggle-read") {
                    if (item.read) void handleMarkUnread(item.id);
                    else void handleMarkRead(item.id);
                  }
                }}
                className={`flex flex-col rounded-m3-md border ${
                  !item.read && view === "inbox"
                    ? "border-primary bg-surface-container"
                    : "border-outline-variant"
                }`}
              >
                {item.postId ? (
                  <Link
                    to={notificationRoute(item) ?? `/posts/${item.postId}`}
                    onClick={() => {
                      if (!item.read) void handleMarkRead(item.id);
                    }}
                    aria-label={`${item.actorUsername ?? "FindBack"} ${typeLabel(item.type)}: ${item.postTitle ?? "your report"}`}
                    className="flex flex-col gap-1 p-3"
                  >
                    <NotificationBody item={item} />
                  </Link>
                ) : (
                  <div className="flex flex-col gap-1 p-3">
                    <NotificationBody item={item} />
                  </div>
                )}
                <div className="flex items-center gap-1 border-t border-outline-variant/60 px-2 py-1">
                  {view === "deleted" ? (
                    <button
                      type="button"
                      onClick={() => void handleRestore([item.id])}
                      className="inline-flex min-h-[44px] items-center gap-1.5 rounded-full px-3 text-sm font-medium text-on-surface"
                    >
                      <RotateCcw size={15} aria-hidden />
                      Restore
                    </button>
                  ) : (
                    <>
                      {item.read ? (
                        <button
                          type="button"
                          onClick={() => void handleMarkUnread(item.id)}
                          className="inline-flex min-h-[44px] items-center rounded-full px-3 text-sm font-medium text-on-surface-variant"
                        >
                          Mark unread
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void handleMarkRead(item.id)}
                          className="inline-flex min-h-[44px] items-center rounded-full px-3 text-sm font-medium text-on-surface-variant"
                        >
                          Mark read
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => void handleDelete([item.id])}
                        className="ml-auto inline-flex min-h-[44px] items-center gap-1.5 rounded-full px-3 text-sm font-medium text-error"
                      >
                        <Trash2 size={15} aria-hidden />
                        Delete
                      </button>
                    </>
                  )}
                </div>
              </motion.div>
            </li>
          ))}
        </ul>
      )}

      {lastDeleted && view === "inbox" ? (
        <div
          role="status"
          className="sticky bottom-3 mt-auto flex items-center gap-3 rounded-m3-md bg-on-surface px-4 py-3 text-sm text-surface"
        >
          <span className="flex-1">
            {lastDeleted.length === 1 ? "Notification deleted" : `${lastDeleted.length} notifications deleted`}
          </span>
          <button
            type="button"
            onClick={() => void handleUndoDelete()}
            className="min-h-[44px] rounded-full px-3 font-semibold underline"
          >
            Undo
          </button>
        </div>
      ) : null}
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
        <UserAvatar username={item.actorUsername} size={32} />
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
