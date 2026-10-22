import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import type { PostItem, PostStatus } from "@findback/shared";
import { POST_STATUS_LABELS } from "@findback/shared";
import { BackButton } from "../components/BackButton";
import { PostList } from "../components/PostList";
import { PullToRefresh, type PullToRefreshHandle } from "../components/PullToRefresh";
import { useFeed } from "../hooks/useFeed";
import { useTabTap } from "../components/TabTap";
import { useAuth } from "../auth";
import { announce } from "../components/LiveRegion";
import {
  OwnerReportActionsProvider,
  type OwnerReportActionHandlers,
} from "../components/OwnerReportActions";
import { deletePost, updatePostStatus } from "../services/posts";
import { shareReport } from "../utils/shareReport";
import { friendlyError } from "../utils/friendlyErrors";
import { invalidateFeedCaches } from "../hooks/feedCache";
import { useReportDeletionFailure } from "../components/ReportDeletionFeedback";

const MY_CACHE_BASE = "my:reports";

/**
 * How long a scheduled delete can still be undone.
 *
 * The same window the notification inbox uses for its undo affordance
 * (see `UNDO_WINDOW_MS` in screens/Notifications.tsx): long enough to read
 * the message and press Undo, short enough that a forgotten delete does not
 * keep a report hanging in the air.
 */
export const DELETE_UNDO_WINDOW_MS = 5000;

/** UXN-4 owner-status quick filters. ALL clears the status restriction;
 *  every option keeps the userId feed restriction. */
export type OwnerStatusFilter = "ALL" | PostStatus;

const OWNER_STATUS_OPTIONS: { value: OwnerStatusFilter; label: string }[] = [
  { value: "ALL", label: "All" },
  { value: "OPEN", label: "Open" },
  { value: "MATCHED", label: "Matched" },
  { value: "RECOVERED", label: "Recovered" },
  { value: "CLOSED", label: "Closed" },
];

/** A delete that is waiting for the undo window (or already on its way). */
interface PendingDelete {
  id: string;
  userId: string;
  title: string;
  /** "pending": the undo window is open. "sending": the server call is in flight. */
  phase: "pending" | "sending";
}

export function MyPosts() {
  const { user } = useAuth();
  const reportDeletionFailure = useReportDeletionFailure();
  const { tapCount } = useTabTap();
  const navigate = useNavigate();
  const scrollRef = useRef<PullToRefreshHandle>(null);
  const [ownerStatus, setOwnerStatus] = useState<OwnerStatusFilter>("ALL");
  const filterRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  // The pending delete, readable from the unmount cleanup without making
  // that cleanup depend on the state.
  const pendingDeleteRef = useRef<PendingDelete | null>(null);
  const mountedRef = useRef(false);
  const ownerStatusRef = useRef(ownerStatus);
  useEffect(() => { ownerStatusRef.current = ownerStatus; }, [ownerStatus]);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The feed filter carries userId, so the resolved cache key is already
  // user-scoped: `my:reports:<filterKey>`. Passing the base (not a
  // pre-scoped key) keeps it identical to the hook's own key.
  const { items, total, loading, refreshing, loadingMore, error, hasMore, refresh, loadMore, removeItem, patchItem } = useFeed(
    { userId: user?.id, status: ownerStatus === "ALL" ? "" : ownerStatus },
    { cacheKey: MY_CACHE_BASE, scrollRef },
  );

  // Active Profile tab tap does not reach here (My Reports is a sub-screen),
  // but keep the same refresh+top behavior for consistency.
  useEffect(() => {
    if (tapCount === 0) return;
    void refresh();
    scrollRef.current?.scrollToTop();
  }, [tapCount]);

  const clearUndoTimer = useCallback(() => {
    if (undoTimer.current !== null) {
      clearTimeout(undoTimer.current);
      undoTimer.current = null;
    }
  }, []);

  /**
   * The delete is DELAYED, and the delay is the point.
   *
   * The server's delete is irreversible: once the row is gone, nothing can
   * bring it back. So the server is NOT called when the user asks to delete
   * — the request is only scheduled, and the row stays on screen marked as
   * waiting. If the user undoes inside the window, nothing is ever sent.
   * Only when the window closes is the delete actually sent, and only a
   * server acceptance turns the row into a deleted report. A refused delete
   * puts the row back and says the report was NOT deleted.
   */
  const commitDelete = useCallback(
    async (id: string) => {
      const pending = pendingDeleteRef.current;
      if (!pending || pending.id !== id || pending.phase !== "pending") return;
      clearUndoTimer();
      // Ownership changes synchronously in the event, never during render.
      // Unmount and timer callbacks therefore cannot send it twice.
      pendingDeleteRef.current = { ...pending, phase: "sending" };
      if (mountedRef.current) setPendingDelete(pendingDeleteRef.current);
      try {
        await deletePost(id);
        invalidateFeedCaches();
        if (mountedRef.current) {
          removeItem(id);
          setActionError(null);
          setNotice("Report deleted.");
        }
        announce("Report deleted.");
      } catch (err) {
        // The server refused: the report is still there, and the screen says
        // so. It never shows a deleted state the server rejected.
        const message = `Report not deleted — ${friendlyError(err).message}`;
        reportDeletionFailure({ userId: pending.userId, message });
        announce(message);
      } finally {
        pendingDeleteRef.current = null;
        if (mountedRef.current) setPendingDelete(null);
      }
    },
    [clearUndoTimer, removeItem, reportDeletionFailure],
  );

  // Navigation commits the confirmed request. Use the exact same owner as
  // the timer, including its durable, account-scoped failure feedback.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearUndoTimer();
      const pending = pendingDeleteRef.current;
      if (pending?.phase === "pending") void commitDelete(pending.id);
    };
  }, [clearUndoTimer, commitDelete]);

  const requestDelete = useCallback(
    (post: PostItem) => {
      if (!user || pendingDeleteRef.current) {
        setActionError("Finish or undo the current deletion before deleting another report.");
        return;
      }
      const ok = window.confirm(
        `Delete “${post.title}”? Once it’s gone it can’t be restored. You’ll have a few seconds to undo.`,
      );
      if (!ok) return;
      setActionError(null);
      setNotice(null);
      clearUndoTimer();
      pendingDeleteRef.current = { id: post.id, userId: user.id, title: post.title, phase: "pending" };
      setPendingDelete(pendingDeleteRef.current);
      undoTimer.current = setTimeout(() => {
        void commitDelete(post.id);
      }, DELETE_UNDO_WINDOW_MS);
    },
    [clearUndoTimer, commitDelete, user],
  );

  const undoDelete = useCallback(() => {
    if (pendingDeleteRef.current?.phase !== "pending") return;
    clearUndoTimer();
    pendingDeleteRef.current = null;
    setPendingDelete(null);
    setNotice("Deletion cancelled — the report is still here.");
    announce("Deletion cancelled.");
  }, [clearUndoTimer]);

  const changeStatus = useCallback(
    (post: PostItem, status: PostStatus) => {
      if (status === post.status) return;
      // Recovered/Closed are terminal for the searcher: confirm explicitly.
      // All other transitions stay direct. No new statuses are introduced.
      if ((status === "RECOVERED" || status === "CLOSED")) {
        const ok = window.confirm(
          status === "RECOVERED"
            ? "Mark this report as recovered? It will leave the open search."
            : "Close this report? It will leave the open search.",
        );
        if (!ok) return;
      }
      void (async () => {
        try {
          const updated = await updatePostStatus(post.id, status);
          // In All, patch in place. In a status-only list, a row that no
          // longer belongs must leave with its count; do not refetch/reorder.
          invalidateFeedCaches();
          if (ownerStatusRef.current !== "ALL" && ownerStatusRef.current !== updated.status) removeItem(post.id);
          else patchItem(post.id, { status: updated.status });
          setActionError(null);
          setNotice(`Status updated to ${POST_STATUS_LABELS[updated.status]}.`);
          announce(`Status updated to ${POST_STATUS_LABELS[updated.status]}.`);
        } catch (err) {
          const message = friendlyError(err).message;
          setActionError(message);
          announce(message);
        }
      })();
    },
    [patchItem, removeItem],
  );

  const shareOne = useCallback((post: PostItem) => {
    void (async () => {
      try {
        announce(await shareReport(post.id, post.title));
      } catch {
        announce("Couldn't share this report. Please try again.");
      }
    })();
  }, []);

  const actions: OwnerReportActionHandlers = {
    onChangeStatus: changeStatus,
    onEdit: (post) => navigate(`/my/${post.id}/edit`),
    onShare: shareOne,
    onDelete: requestDelete,
    pendingDeleteId: pendingDelete?.id ?? null,
    onUndoDelete: undoDelete,
  };

  return (
    <div className="flex h-full flex-col gap-4 py-5">
      <header className="flex items-center gap-2 px-4">
        <BackButton fallbackTo="/profile" label="Back to profile" />
        <div>
          <h1 className="text-xl font-semibold tracking-tight">My reports</h1>
          <p className="text-sm text-on-surface-variant">
            {total} report{total === 1 ? "" : "s"} · manage the status of items you have reported.
          </p>
        </div>
      </header>

      {actionError && (
        <p role="alert" className="mx-4 rounded-m3-sm border border-error px-3 py-2 text-sm text-error">
          {actionError}
        </p>
      )}

      <div className="fb-scroll-fade mx-4">
        <div
          role="radiogroup"
          aria-label="Filter by status"
          className="fb-scroll-row flex gap-2"
          onKeyDown={(event) => {
            const index = filterRefs.current.findIndex((button) => button === document.activeElement);
            if (index < 0) return;
            const next = event.key === "Home" ? 0 : event.key === "End" ? OWNER_STATUS_OPTIONS.length - 1
              : event.key === "ArrowRight" || event.key === "ArrowDown" ? (index + 1) % OWNER_STATUS_OPTIONS.length
                : event.key === "ArrowLeft" || event.key === "ArrowUp" ? (index + OWNER_STATUS_OPTIONS.length - 1) % OWNER_STATUS_OPTIONS.length : null;
            if (next == null) return;
            event.preventDefault();
            filterRefs.current[next]?.focus();
            setOwnerStatus(OWNER_STATUS_OPTIONS[next]!.value);
          }}
        >
          {OWNER_STATUS_OPTIONS.map((o, index) => {
            const selected = o.value === ownerStatus;
            return (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={selected}
                tabIndex={selected ? 0 : -1}
                ref={(element) => { filterRefs.current[index] = element; }}
                onClick={() => setOwnerStatus(o.value)}
                className={`min-h-[44px] shrink-0 rounded-full border px-4 text-sm font-medium transition-colors ${
                  selected
                    ? "border-transparent bg-on-surface text-surface"
                    : "border-outline-variant bg-surface text-on-surface-variant hover:bg-surface-container"
                }`}
              >
                {o.label}
              </button>
            );
          })}
        </div>
      </div>

      <OwnerReportActionsProvider value={actions}>
        <PullToRefresh ref={scrollRef} onRefresh={refresh} disabled={loading || refreshing} className="flex-1">
          <PostList
            items={items}
            loading={loading}
            loadingMore={loadingMore}
            error={error}
            hasMore={hasMore}
            onLoadMore={loadMore}
            onRetry={refresh}
            emptyTitle="You have no reports yet"
            emptySubtitle="Tap Report to post a lost or found item."
            density="owner-feed"
          />
        </PullToRefresh>
      </OwnerReportActionsProvider>

      {pendingDelete && pendingDelete.phase === "pending" && (
        <div
          role="status"
          data-testid="my-posts-delete-undo"
          className="sticky bottom-3 mx-4 flex items-center gap-3 rounded-m3-md bg-on-surface px-4 py-3 text-sm text-surface"
        >
          <span className="flex-1">Delete scheduled — Undo for a few seconds</span>
          <button
            type="button"
            onClick={undoDelete}
            className="min-h-[44px] rounded-full px-3 font-semibold underline"
          >
            Undo
          </button>
        </div>
      )}

      {notice && !pendingDelete && (
        <p role="status" data-testid="my-posts-notice" className="mx-4 text-sm text-on-surface-variant">
          {notice}
        </p>
      )}
    </div>
  );
}
