import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { motion, type PanInfo } from "framer-motion";
import { Heading } from "react-aria-components";
import { Bell, Check, Mail, MoreVertical, RotateCcw, Settings, Trash2 } from "lucide-react";
import { BackButton } from "../components/BackButton";
import { ActionMenu } from "../components/ActionMenu";
import { useAuth } from "../auth";
import { BlockedByViewerShield } from "../components/BlockedByViewerShield";
import { UserAvatar } from "../components/UserAvatar";
import { announce } from "../components/LiveRegion";
import { ErrorView, InboxSkeleton, StateSwap } from "../components/uiPrimitives";
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
import { reactionEmojiForWire, reactionKindLabel } from "../services/reactions";
import { onRealtime } from "../services/realtime";
import { PUSH_RECEIVED_EVENT } from "../services/pushNotifications";
import { friendlyError } from "../utils/friendlyErrors";
import { formatTimestamp, timeAgo } from "../utils/dates";
import "./Notifications.css";

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

export function typeLabel(type: NotificationType): string {
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
    case "MODERATION":
      return "review update";
    case "UNKNOWN":
      return "sent you an update";
    default:
      return "sent you an update";
  }
}

type InboxView = "inbox" | "deleted";

/**
 * A gesture that starts on a shielded row's reveal control must NEVER become
 * a swipe.
 *
 * The row is a swipe-to-delete surface, and the shield's "Show content" button
 * sits inside it: a horizontal drag that starts on that button would commit
 * the swipe action (delete / mark-read) instead of revealing the content. The
 * reveal wins.
 *
 * The guard is a CAPTURE-phase listener on the list: it runs before the row's
 * own pointer handling, so the gesture never reaches the drag surface when it
 * starts inside a shield. Every other part of the row still swipes. The
 * listener is native (not React's delegated handler) because React's own
 * handler for a bubbled event runs after the row's listener has already
 * seen it.
 */
function startsInsideShield(event: Event): boolean {
  const target = event.target;
  if (!(target instanceof Element)) return false;
  return target.closest("[data-testid=\"blocked-shield\"]") !== null;
}

interface NotificationsProps {
  preview?: boolean;
  onNavigate?: () => void;
}

export function Notifications({ preview = false, onNavigate }: NotificationsProps = {}) {
  const { user } = useAuth();
  return user ? <AccountNotifications key={user.id} preview={preview} onNavigate={onNavigate} /> : null;
}

function AccountNotifications({ preview, onNavigate }: NotificationsProps) {
  const [view, setView] = useState<InboxView>("inbox");
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const [items, setItems] = useState<NotificationItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [lastDeleted, setLastDeleted] = useState<readonly string[] | null>(null);
  const lastDeletedRef = useRef<readonly string[] | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(false);
  const viewRef = useRef(view);
  const loadSequence = useRef(0);
  const mutationSequence = useRef(0);
  const lastDeleteWrite = useRef<Promise<void> | null>(null);
  const viewGeneration = useRef(0);
  const writeQueue = useRef<Promise<unknown>>(Promise.resolve());
  const pendingWrites = useRef(0);
  const confirmedRead = useRef(new Map<string, boolean>());
  const readSequence = useRef(new Map<string, number>());

  useLayoutEffect(() => {
    alive.current = true;
    return () => { alive.current = false; loadSequence.current += 1; };
  }, []);

  useLayoutEffect(() => {
    viewRef.current = view;
    viewGeneration.current += 1;
    loadSequence.current += 1;
    setItems(null);
    setError(null);
    setActionError(null);
  }, [view]);

  const clearUndo = useCallback(() => {
    if (undoTimer.current !== null) {
      clearTimeout(undoTimer.current);
      undoTimer.current = null;
    }
    lastDeletedRef.current = null;
    lastDeleteWrite.current = null;
    setLastDeleted(null);
  }, []);

  useEffect(
    () => () => {
      if (undoTimer.current !== null) clearTimeout(undoTimer.current);
    },
    [],
  );

  const load = useCallback(async (target: InboxView) => {
    if (!alive.current || target !== viewRef.current) return;
    const sequence = ++loadSequence.current;
    const current = () => alive.current && sequence === loadSequence.current && target === viewRef.current;
    setError(null);
    while (current()) {
      // A focus/realtime refresh must read after every already-admitted
      // mutation. Otherwise it can replace optimism with pre-write data.
      while (pendingWrites.current > 0 && current()) {
        const tail = writeQueue.current;
        await tail.catch(() => undefined);
        if (!current()) return;
      }
      if (!current()) return;
      const mutation = mutationSequence.current;
      try {
        const rows = await fetchNotifications({ deleted: target === "deleted" });
        if (!current()) return;
        // A newer choice invalidates the snapshot, not the requested refresh.
        // Retry after its write rather than dropping notification additions.
        if (mutation !== mutationSequence.current) continue;
        for (const row of rows) confirmedRead.current.set(row.id, row.read);
        setItems(rows);
        return;
      } catch (err) {
        if (!current()) return;
        if (mutation !== mutationSequence.current) continue;
        setError(friendlyError(err).message);
        return;
      }
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
    window.addEventListener(PUSH_RECEIVED_EVENT, onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener(PUSH_RECEIVED_EVENT, onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load, view]);

  useEffect(() => {
    if (view !== "inbox") return;
    // Private inbox signal: refresh the list when a new notification lands.
    return onRealtime("notification:added", () => void load("inbox"));
  }, [load, view]);

  const queueWrite = useCallback((work: () => Promise<void>) => {
    const idle = pendingWrites.current === 0;
    pendingWrites.current += 1;
    mutationSequence.current += 1;
    const run = async () => {
      try {
        // The account-keyed component may have gone away while this waited.
        if (alive.current) await work();
      } finally {
        pendingWrites.current -= 1;
      }
    };
    // A tap may navigate immediately after admitting its mark-read write.
    // Start an idle write now; only queued continuations wait/recheck lifetime.
    const write = idle ? run() : writeQueue.current.catch(() => undefined).then(run);
    writeQueue.current = write;
    return write;
  }, []);

  const changeRead = useCallback((ids: readonly string[] | undefined, read: boolean) => {
    const generation = viewGeneration.current;
    const affected = (items ?? []).filter((item) => !ids || ids.includes(item.id));
    const previousRead = new Map(affected.map((item) => [item.id, item.read]));
    const versions = new Map(affected.map((item) => {
      const next = (readSequence.current.get(item.id) ?? 0) + 1;
      readSequence.current.set(item.id, next);
      return [item.id, next];
    }));
    setActionError(null);
    setItems((current) => current?.map((item) => versions.has(item.id) ? { ...item, read } : item) ?? current);
    return queueWrite(async () => {
      try {
        if (read) {
          if (ids) await markNotificationsRead(ids);
          else await markNotificationsRead();
        }
        else await markNotificationsUnread(ids);
        for (const item of affected) confirmedRead.current.set(item.id, read);
        if (alive.current) signalInboxChanged();
      } catch (err) {
        if (!alive.current || generation !== viewGeneration.current) return;
        // Change only this operation's still-current read fields. Never
        // resurrect rows deleted meanwhile or revert a newer choice.
        setItems((current) => current?.map((item) => versions.get(item.id) === readSequence.current.get(item.id)
          && versions.has(item.id)
          ? { ...item, read: confirmedRead.current.get(item.id) ?? previousRead.get(item.id) ?? item.read }
          : item) ?? current);
        setActionError(friendlyError(err).message);
      }
    });
  }, [items, queueWrite]);

  const handleMarkRead = useCallback((id: string) => changeRead([id], true), [changeRead]);
  const handleMarkUnread = useCallback((id: string) => changeRead([id], false), [changeRead]);
  const handleMarkAllRead = useCallback(() => changeRead(undefined, true), [changeRead]);

  const handleDelete = useCallback(
    async (ids: readonly string[]) => {
      const generation = viewGeneration.current;
      const removed = (items ?? []).filter((item) => ids.includes(item.id));
      const positions = new Map((items ?? []).map((item, index) => [item.id, index]));
      setActionError(null);
      setItems((current) => current?.filter((item) => !ids.includes(item.id)) ?? current);
      lastDeletedRef.current = ids;
      setLastDeleted(ids);
      if (undoTimer.current !== null) clearTimeout(undoTimer.current);
      undoTimer.current = setTimeout(() => {
        undoTimer.current = null;
        lastDeletedRef.current = null;
        lastDeleteWrite.current = null;
        setLastDeleted(null);
      }, UNDO_WINDOW_MS);
      try {
        const write = queueWrite(async () => {
          await deleteNotifications([...ids]);
        });
        lastDeleteWrite.current = write;
        await write;
        if (alive.current) signalInboxChanged();
      } catch (err) {
        if (!alive.current || generation !== viewGeneration.current) return;
        if (lastDeletedRef.current === ids) clearUndo();
        setItems((current) => {
          if (!current) return current;
          const restored = [...current];
          for (const row of removed) {
            if (!restored.some((item) => item.id === row.id)) {
              restored.splice(Math.min(positions.get(row.id) ?? restored.length, restored.length), 0,
                { ...row, read: confirmedRead.current.get(row.id) ?? row.read });
            }
          }
          return restored;
        });
        setActionError(friendlyError(err).message);
      }
    },
    [items, queueWrite, clearUndo],
  );

  const handleUndoDelete = useCallback(async () => {
    if (!lastDeleted) return;
    const ids = lastDeleted;
    const deletion = lastDeleteWrite.current;
    const generation = viewGeneration.current;
    clearUndo();
    try {
      // Restore must follow the delete on the server. An early Undo cannot
      // race ahead and leave the notification deleted by the slower write.
      await deletion;
      if (!alive.current) return;
      await queueWrite(async () => { await restoreNotifications([...ids]); });
      if (alive.current) signalInboxChanged();
    } catch (err) {
      if (alive.current && generation === viewGeneration.current) setActionError(friendlyError(err).message);
    }
    if (alive.current) await load(viewRef.current);
  }, [lastDeleted, clearUndo, load, queueWrite]);

  const handleRestore = useCallback(
    async (ids: readonly string[]) => {
      const generation = viewGeneration.current;
      setItems((current) => current?.filter((item) => !ids.includes(item.id)) ?? current);
      try {
        await queueWrite(async () => { await restoreNotifications([...ids]); });
        if (alive.current) signalInboxChanged();
      } catch (err) {
        if (!alive.current || generation !== viewGeneration.current) return;
        setActionError(friendlyError(err).message);
        await load("deleted");
      }
    },
    [load, queueWrite],
  );

  const unreadCount = items?.filter((item) => !item.read).length ?? 0;
  const filteredItems = items?.filter((item) => filter === "all" || !item.read) ?? [];
  const visibleItems = preview ? filteredItems.slice(0, 8) : filteredItems;
  // The list owns the gesture guard: a pointer-down that starts inside a
  // shield never reaches the row's drag surface, so it can never commit a
  // swipe. The list is mounted only when there is something to show, so the
  // listener is bound to the list element itself.
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const onPointerDown = (event: Event) => {
      if (!startsInsideShield(event)) return;
      event.stopPropagation();
    };
    list.addEventListener("pointerdown", onPointerDown, true);
    return () => list.removeEventListener("pointerdown", onPointerDown, true);
  }, [items, filter]);

  return (
    <div className={`fb-notifications ${preview ? "fb-notifications--preview" : "fb-notifications--full"}`}>
      <header className="fb-notification-header">
        {!preview && <BackButton fallbackTo="/" label="Back to home" />}
        {preview ? <Heading slot="title" className="fb-notification-title">Notifications</Heading>
          : <h1 className="fb-notification-title">Notifications</h1>}
        <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1">
          {preview ? <ActionMenu label="Inbox actions" items={[
            { id: "read-all", label: "Mark all read", disabled: unreadCount === 0, icon: <Check size={16} aria-hidden />,
              onAction: () => void handleMarkAllRead() },
          ]} /> : <>
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
            onClick={onNavigate}
            aria-label="Notification settings"
            className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full px-2 text-on-surface-variant"
          >
            <Settings size={18} aria-hidden />
          </Link>
          <button
            type="button"
            onClick={() => {
              setView((current) => (current === "inbox" ? "deleted" : "inbox"));
              setFilter("all");
              clearUndo();
            }}
            aria-pressed={view === "deleted"}
            className="min-h-[44px] rounded-full border border-outline-variant px-3 text-sm font-medium text-on-surface"
          >
            {view === "inbox" ? "Deleted" : "Inbox"}
          </button>
          </>}
        </div>
      </header>

      {view === "inbox" && <div className="fb-notification-filters" role="group" aria-label="Filter notifications">
        <button type="button" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>All</button>
        <button type="button" aria-pressed={filter === "unread"} onClick={() => setFilter("unread")}>Unread</button>
      </div>}

      {actionError && <p role="alert" className="py-2 text-sm text-error [overflow-wrap:anywhere]">{actionError}</p>}

      {/* Inbox states swap with one short fade — loading holds fixed-size
          skeleton rows so resolving content never reflows. */}
      <div className="fb-notification-content">
      <StateSwap stateKey={error ? "error" : items === null ? "loading" : visibleItems.length === 0 ? "empty" : `content-${view}`}>
      {error ? (
        <section className="flex flex-1 flex-col items-center justify-center px-4 py-4 text-center">
          <ErrorView message={error} onRetry={() => void load(view)} />
        </section>
      ) : items === null ? (
        <section className="flex-1" aria-label="Loading notifications">
          <InboxSkeleton count={preview ? 5 : 4} />
        </section>
      ) : visibleItems.length === 0 ? (
        <section
          className="fb-notification-empty"
          aria-labelledby="notifications-empty-title"
        >
          <Bell size={24} aria-hidden className="text-on-surface-variant" />
          <h2 id="notifications-empty-title" className="font-semibold">
            {view === "deleted" ? "No deleted notifications" : filter === "unread" ? "No unread notifications" : "No notifications"}
          </h2>
          <p className="max-w-xs text-sm text-on-surface-variant">
            {view === "deleted"
              ? "Deleted notifications you can restore will appear here."
              : "You're all caught up. Reactions, comments, and mentions on your reports will show up here."}
          </p>
        </section>
      ) : (
        <ul ref={listRef} className="fb-notification-list" aria-label="Notifications">
          {visibleItems.map((item) => {
            // O5 (CF-060 B1): the DB returns the row either way and projects
            // the caller-scoped, direction-free `blocked_actor` bit. A blocked
            // row is screened IN PLACE with the canonical shield — never
            // dropped, and never a different row: the row's normal content
            // (including its link) sits INSIDE the shield, exactly like the
            // profile reports row does.
            const blocked = item.blockedActor === true;
            const route = notificationRoute(item);
            const body = item.postId ? (
              <Link
                to={route ?? `/posts/${item.postId}`}
                onClick={() => {
                  if (!item.read) void handleMarkRead(item.id);
                  onNavigate?.();
                }}
                aria-label={`${item.actorUsername ?? "FindBack"} ${typeLabel(item.type)}: ${item.postTitle ?? "your report"}`}
                className="fb-notification-body"
              >
                <NotificationBody item={item} />
              </Link>
            ) : (
              <div className="fb-notification-body">
                <NotificationBody item={item} />
              </div>
            );
            return (
              <li key={item.id}>
                <motion.div
                  drag={!preview && view === "inbox" ? "x" : false}
                  dragDirectionLock
                  dragConstraints={{ left: 0, right: 0 }}
                  dragElastic={0.25}
                  data-testid="notification-row"
                  onDragEnd={(_event, info: PanInfo) => {
                    if (preview || view !== "inbox") return;
                    const action = swipeActionFor(info.offset.x);
                    if (action === "delete") void handleDelete([item.id]);
                    else if (action === "toggle-read") {
                      if (item.read) void handleMarkUnread(item.id);
                      else void handleMarkRead(item.id);
                    }
                  }}
                  className="fb-notification-row"
                  data-unread={!item.read && view === "inbox" ? "true" : undefined}
                >
                  {blocked ? (
                    // The shield wraps the row's content region from OUTSIDE, so
                    // the reveal control is a sibling of the content — never a
                    // button inside the row's own link. `mode="row"` because the
                    // row is a short, fixed-rhythm list row: the warning shares
                    // one grid cell with the content, so it can never paint
                    // over the NEXT row.
                    //
                    // While locked, the shield makes the content wrapper
                    // `inert` + `aria-hidden`, so the row's link is neither
                    // focusable nor reachable by pointer. After the user taps
                    // "Show content" the same link works again — the same
                    // two-state rule the profile reports row and the detail
                    // report region already follow. Reading is preserved; only
                    // the hidden state is refused.
                    <BlockedByViewerShield
                      rowId={item.id}
                      blocked
                      mode="row"
                      className="min-w-0 flex-1"
                    >
                      {body}
                    </BlockedByViewerShield>
                  ) : body}
                  {/* Packet `08` §17: swipe is a shortcut, never the only route —
                      the row keeps one compact overflow trigger instead of a
                      permanent action bar. */}
                  <NotificationOverflow
                    item={item}
                    view={view}
                    onMarkRead={handleMarkRead}
                    onMarkUnread={handleMarkUnread}
                    onDelete={handleDelete}
                    onRestore={handleRestore}
                  />
                </motion.div>
              </li>
            );
          })}
        </ul>
      )}
      </StateSwap>
      </div>

      {lastDeleted && view === "inbox" ? (
        <div
          role="status"
          className="fb-notification-undo"
        >
          <span className="min-w-0 flex-[1_1_8rem] [overflow-wrap:anywhere]">
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
      {preview && <Link className="fb-notification-see-all" to="/notifications" onClick={onNavigate}>See all notifications</Link>}
    </div>
  );
}

/**
 * Packet `08` §17 overflow. The row's actions used to sit in a permanent
 * bottom bar; that bar is gone (it was the heaviest thing on the row and it
 * dominated the list), but every action it held stays reachable by tap and by
 * keyboard — swipe alone is never the only route to an action.
 */
function NotificationOverflow({
  item,
  view,
  onMarkRead,
  onMarkUnread,
  onDelete,
  onRestore,
}: {
  item: NotificationItem;
  view: "inbox" | "deleted";
  onMarkRead: (id: string) => Promise<void>;
  onMarkUnread: (id: string) => Promise<void>;
  onDelete: (ids: readonly string[]) => Promise<void>;
  onRestore: (ids: readonly string[]) => Promise<void>;
}) {
  // A shielded row must not name its actor: the row's content is hidden until
  // the user asks for it, so the trigger's label stays neutral for a blocked
  // actor (the block bit is direction-free — it never says who blocked whom).
  const summary = item.blockedActor === true
    ? "a hidden notification"
    : `${item.actorUsername ?? "FindBack"} ${typeLabel(item.type)}`;

  return (
    <div className="fb-notification-overflow" onPointerDown={(event) => event.stopPropagation()}>
      <ActionMenu label={`More actions for ${summary}`} icon={<MoreVertical size={18} aria-hidden />}
        items={view === "deleted" ? [
          { id: "restore", label: "Restore", icon: <RotateCcw size={16} aria-hidden />, onAction: () => void onRestore([item.id]) },
        ] : [
          { id: "read", label: item.read ? "Mark unread" : "Mark read",
            icon: item.read ? <Mail size={16} aria-hidden /> : <Check size={16} aria-hidden />,
            onAction: () => {
              announce(item.read ? "Marked as unread" : "Marked as read");
              void (item.read ? onMarkUnread(item.id) : onMarkRead(item.id));
            } },
          { id: "delete", label: "Delete", destructive: true, icon: <Trash2 size={16} aria-hidden />,
            onAction: () => void onDelete([item.id]) },
        ]} />
    </div>
  );
}

// Exact legacy system templates only. Historical MATCHED rows predate current
// mutual-consent enforcement: never retroactively claim both owners agreed.
const LEGACY_STATUS_PREVIEWS = new Map([
  ["Your report status changed to MATCHED", "Your report was marked as matched. Review its match activity."],
  ["Your report status changed to RECOVERED", "Recovery recorded. The item has been returned."],
  ["Your report status changed to CLOSED", "Your report is closed."],
]);

function NotificationBody({ item }: { item: NotificationItem }) {
  const preview = item.type === "STATUS" && item.preview
    ? LEGACY_STATUS_PREVIEWS.get(item.preview) ?? item.preview : item.preview;
  return (
    <>
      <span className="fb-notification-avatar">
        <UserAvatar username={item.actorUsername} size={32} />
      </span>
      <div className="fb-notification-copy">
        <p className="fb-notification-summary">
          <span className="font-semibold">{item.actorUsername ?? "FindBack"}</span>{" "}
          <span className="text-on-surface-variant">
            {item.type === "REACTION" && reactionKindLabel(item.reactionKind)
              ? (
                <>
                  reacted to your report with {reactionKindLabel(item.reactionKind)}{" "}
                  <span aria-hidden="true">{reactionEmojiForWire(item.reactionKind) ?? ""}</span>
                </>
              )
              : typeLabel(item.type)}
          </span>
        </p>
      {item.postTitle ? (
        <p className="fb-notification-subject">{item.postTitle}</p>
      ) : null}
      {preview && preview !== item.postTitle ? (
        <p className={`fb-notification-preview ${item.type === "MODERATION" || item.type === "STATUS" ? "" : "line-clamp-2"}`}>{preview}</p>
      ) : null}
      <div className="fb-notification-meta">
      {!item.read && <span aria-label="Unread" className="fb-notification-dot" />}
      <time
        dateTime={item.createdAt}
        title={formatTimestamp(item.createdAt)}
        className="fb-notification-time"
      >
        {timeAgo(item.createdAt)}
      </time>
      </div>
      </div>
    </>
  );
}
