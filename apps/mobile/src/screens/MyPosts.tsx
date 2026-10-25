import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import type { PostItem, PostStatus, PostType } from "@findback/shared";
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
import { copyReportLink, shareReport } from "../utils/shareReport";
import { friendlyError } from "../utils/friendlyErrors";
import { invalidateFeedCaches } from "../hooks/feedCache";
import { useReportDeletionFailure } from "../components/ReportDeletionFeedback";
import { RecoverySheet } from "../components/RecoverySheet";

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

/** The status change is optimistic; this is how long its Undo stays offered. */
export const STATUS_UNDO_WINDOW_MS = 5000;

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

/** A just-committed status change that can still be put back. */
interface StatusUndo {
  postId: string;
  previous: PostStatus;
  next: PostStatus;
  type: PostType;
}

/** Owner-facing lifecycle language, matching the card's status chip. */
function ownerStatusLabel(status: PostStatus, type: PostType): string {
  if (status === "OPEN") return type === "LOST" ? "Still missing" : "Awaiting owner";
  if (status === "MATCHED") return "Potential match";
  return POST_STATUS_LABELS[status];
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
  const [recoveryPost, setRecoveryPost] = useState<PostItem | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [statusUndo, setStatusUndo] = useState<StatusUndo | null>(null);
  const statusUndoRef = useRef<StatusUndo | null>(null);
  const statusUndoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Per-row write order and last-writer-wins UI token. A fast second change
  // must not be overwritten by the slower first response, and the server must
  // receive the two writes in the order the user made them.
  const statusSeq = useRef(new Map<string, number>());
  const statusQueue = useRef(new Map<string, Promise<unknown>>());
  // The last status the server actually confirmed for a row. Optimistic
  // patches must never become the rollback target: if a change and an early
  // Undo both fail, the row belongs at the last confirmed status, not at
  // either optimistic value.
  const confirmedStatus = useRef(new Map<string, PostStatus>());
  const statusInFlight = useRef(new Map<string, number>());
  const [manualCopyUrl, setManualCopyUrl] = useState<string | null>(null);

  // The feed filter carries userId, so the resolved cache key is already
  // user-scoped: `my:reports:<filterKey>`. Passing the base (not a
  // pre-scoped key) keeps it identical to the hook's own key.
  const { items, total, loading, refreshing, loadingMore, error, hasMore, refresh, loadMore, removeItem, patchItem } = useFeed(
    { userId: user?.id, status: ownerStatus === "ALL" ? "" : ownerStatus },
    { cacheKey: MY_CACHE_BASE, scrollRef },
  );

  // The sheet always reads the live row, not the snapshot taken when it
  // opened: a refetch can replace the same id with a different type/owner.
  const liveRecoveryPost = recoveryPost
    ? items.find((item) => item.id === recoveryPost.id) ?? recoveryPost
    : null;

  const clearStatusUndo = useCallback(() => {
    if (statusUndoTimer.current !== null) {
      clearTimeout(statusUndoTimer.current);
      statusUndoTimer.current = null;
    }
    statusUndoRef.current = null;
    setStatusUndo(null);
  }, []);

  const armStatusUndo = useCallback(
    (undo: StatusUndo) => {
      clearStatusUndo();
      statusUndoRef.current = undo;
      setStatusUndo(undo);
      statusUndoTimer.current = setTimeout(() => {
        statusUndoTimer.current = null;
        statusUndoRef.current = null;
        setStatusUndo(null);
      }, STATUS_UNDO_WINDOW_MS);
    },
    [clearStatusUndo],
  );

  // A new account is a new ownership boundary. The old target and any
  // outstanding Undo must not stay armed under the new account.
  useEffect(() => {
    setRecoveryPost(null);
    setManualCopyUrl(null);
    clearStatusUndo();
    // In-flight writes belong to the old account's rows; their completions
    // must not patch the new account's list.
    statusSeq.current.clear();
    statusQueue.current.clear();
    confirmedStatus.current.clear();
    statusInFlight.current.clear();
  }, [user?.id, clearStatusUndo]);

  // Rows that are not being written track the feed's status, which is
  // server-confirmed data. Rows with a queued write keep their last confirmed
  // status so an optimistic value can never become a rollback target.
  useEffect(() => {
    for (const item of items) {
      if ((statusInFlight.current.get(item.id) ?? 0) === 0) {
        confirmedStatus.current.set(item.id, item.status);
      }
    }
  }, [items]);

  useEffect(() => {
    if (!recoveryPost) return;
    const live = items.find((item) => item.id === recoveryPost.id);
    // A row removed after a confirmed recovery is not an eligibility change:
    // the sheet keeps its receipt. A live row that is no longer a lost report
    // owned by this account is.
    if (live && (live.type !== "LOST" || live.userId !== user?.id)) setRecoveryPost(null);
  }, [items, recoveryPost, user?.id]);

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
      if (statusUndoTimer.current !== null) {
        clearTimeout(statusUndoTimer.current);
        statusUndoTimer.current = null;
      }
      statusUndoRef.current = null;
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
      clearStatusUndo();
      setManualCopyUrl(null);
      clearUndoTimer();
      pendingDeleteRef.current = { id: post.id, userId: user.id, title: post.title, phase: "pending" };
      setPendingDelete(pendingDeleteRef.current);
      undoTimer.current = setTimeout(() => {
        void commitDelete(post.id);
      }, DELETE_UNDO_WINDOW_MS);
    },
    [clearStatusUndo, clearUndoTimer, commitDelete, user],
  );

  const undoDelete = useCallback(() => {
    if (pendingDeleteRef.current?.phase !== "pending") return;
    clearUndoTimer();
    pendingDeleteRef.current = null;
    setPendingDelete(null);
    setNotice("Deletion cancelled — the report is still here.");
    announce("Deletion cancelled.");
  }, [clearUndoTimer]);

  const beginStatusWrite = useCallback((postId: string) => {
    statusInFlight.current.set(postId, (statusInFlight.current.get(postId) ?? 0) + 1);
  }, []);

  const endStatusWrite = useCallback((postId: string) => {
    const left = (statusInFlight.current.get(postId) ?? 1) - 1;
    if (left <= 0) statusInFlight.current.delete(postId);
    else statusInFlight.current.set(postId, left);
  }, []);

  const changeStatus = useCallback(
    (post: PostItem, status: PostStatus) => {
      if (status === post.status) return;
      // A recorded recovery is terminal: the server refuses any status change
      // on a report that already has a recovery row, and reopening it would
      // leave the recovery describing a report that reads Open. Say so here
      // instead of spending a round trip on a control that cannot work.
      if (post.status === "RECOVERED") {
        const message = "This report is already recorded as recovered.";
        setActionError(message);
        announce(message);
        return;
      }
      // Recovered is not a status write: it is the durable recovery
      // relationship (MC D25), so the owner chooses the helper first and the
      // server writes the row and the status together. A FOUND report cannot
      // be "recovered" by this path.
      if (status === "RECOVERED") {
        if (post.type !== "LOST") {
          const message = "Only a lost-item report can be marked recovered.";
          setActionError(message);
          announce(message);
          return;
        }
        setRecoveryPost(post);
        return;
      }
      // Closed is terminal for the searcher: confirm explicitly.
      if (status === "CLOSED") {
        const ok = window.confirm("Close this report? It will leave the open search.");
        if (!ok) return;
      }

      const previous = post.status;
      // The row may already show an optimistic status from a queued write.
      // Roll back to the last status the server confirmed, never to that
      // optimistic value.
      const confirmed = confirmedStatus.current.get(post.id) ?? previous;
      const seq = (statusSeq.current.get(post.id) ?? 0) + 1;
      statusSeq.current.set(post.id, seq);
      const latest = () => mountedRef.current && statusSeq.current.get(post.id) === seq;

      // Optimistic: the row shows the chosen status immediately. A failed
      // write puts the last confirmed status back and withdraws the Undo offer.
      beginStatusWrite(post.id);
      patchItem(post.id, { status });
      setActionError(null);
      setNotice(null);
      armStatusUndo({ postId: post.id, previous, next: status, type: post.type });

      // Writes for one row are serialised so the last choice is the last
      // write the server sees, even when the user changes status twice fast.
      const prior = statusQueue.current.get(post.id) ?? Promise.resolve();
      const write = prior.catch(() => undefined).then(() => updatePostStatus(post.id, status));
      statusQueue.current.set(post.id, write);

      void (async () => {
        try {
          const updated = await write;
          // This write is now server-confirmed even if a newer one follows.
          confirmedStatus.current.set(post.id, updated.status);
          // In All, patch in place. In a status-only list, a row that no
          // longer belongs must leave with its count; do not refetch/reorder.
          invalidateFeedCaches();
          if (!latest()) return;
          if (ownerStatusRef.current !== "ALL" && ownerStatusRef.current !== updated.status) removeItem(post.id);
          else patchItem(post.id, { status: updated.status });
          setActionError(null);
          announce(`Status updated to ${ownerStatusLabel(updated.status, post.type)}.`);
        } catch (err) {
          // A failed optimistic write must never be cached as clean either.
          invalidateFeedCaches();
          if (!latest()) return;
          // Read the confirmed value at settlement, not at click time: an
          // earlier queued write may have succeeded while this one was in
          // flight, and that newer server state is the correct rollback.
          patchItem(post.id, { status: confirmedStatus.current.get(post.id) ?? confirmed });
          clearStatusUndo();
          const message = friendlyError(err).message;
          setActionError(message);
          announce(message);
        } finally {
          endStatusWrite(post.id);
        }
      })();
    },
    [armStatusUndo, beginStatusWrite, clearStatusUndo, endStatusWrite, patchItem, removeItem],
  );

  const undoStatus = useCallback(() => {
    const pending = statusUndoRef.current;
    if (!pending) return;
    clearStatusUndo();

    const { postId, previous, type } = pending;
    // Undo restores what the server last confirmed, not the optimistic value
    // the change showed. If the change and the Undo both fail, the row must
    // land back on the server's status.
    const confirmed = confirmedStatus.current.get(postId) ?? previous;
    const seq = (statusSeq.current.get(postId) ?? 0) + 1;
    statusSeq.current.set(postId, seq);
    const latest = () => mountedRef.current && statusSeq.current.get(postId) === seq;

    // Undo is optimistic too: put the old status back now, then confirm.
    beginStatusWrite(postId);
    patchItem(postId, { status: previous });
    setNotice(null);

    const prior = statusQueue.current.get(postId) ?? Promise.resolve();
    const write = prior.catch(() => undefined).then(() => updatePostStatus(postId, previous));
    statusQueue.current.set(postId, write);

    void (async () => {
      try {
        const updated = await write;
        confirmedStatus.current.set(postId, updated.status);
        invalidateFeedCaches();
        if (!latest()) return;
        if (ownerStatusRef.current !== "ALL" && ownerStatusRef.current !== updated.status) {
          removeItem(postId);
          void refresh();
        } else {
          patchItem(postId, { status: updated.status });
          // A status-only list may have removed the row on the original
          // success; a refetch is the only way to put it back.
          if (ownerStatusRef.current !== "ALL") void refresh();
        }
        setNotice(`Status restored to ${ownerStatusLabel(updated.status, type)}.`);
        announce(`Status restored to ${ownerStatusLabel(updated.status, type)}.`);
      } catch (err) {
        // Same cache rule as a failed change: do not let an unmounted
        // optimistic snapshot be restored as clean.
        invalidateFeedCaches();
        if (!latest()) return;
        // The change may have settled successfully while this Undo was in
        // flight; roll back to that server-confirmed status, not the value
        // captured when Undo was tapped.
        patchItem(postId, { status: confirmedStatus.current.get(postId) ?? confirmed });
        if (ownerStatusRef.current !== "ALL") void refresh();
        const message = friendlyError(err).message;
        setActionError(message);
        announce(message);
      } finally {
        endStatusWrite(postId);
      }
    })();
  }, [beginStatusWrite, clearStatusUndo, endStatusWrite, patchItem, refresh, removeItem]);

  const shareOne = useCallback((post: PostItem) => {
    void (async () => {
      try {
        announce(await shareReport(post.id, post.title));
      } catch {
        announce("Couldn't share this report. Please try again.");
      }
    })();
  }, []);

  /**
   * Explicit Copy, next to Share. Clipboard support is not universal (and a
   * WebView can refuse it), so a refusal shows the actual link in a
   * selectable field instead of claiming it was copied.
   */
  const copyOne = useCallback((post: PostItem) => {
    void (async () => {
      try {
        const result = await copyReportLink(post.id);
        if (!mountedRef.current) return;
        if (result.status === "copied") {
          setManualCopyUrl(null);
          setActionError(null);
          setNotice("Link copied.");
          announce("Link copied.");
        } else {
          setManualCopyUrl(result.url);
          setNotice(null);
          announce("Copying isn't available here. Tap the link and copy it.");
        }
      } catch {
        if (!mountedRef.current) return;
        const message = "Couldn't build the link for this report.";
        setActionError(message);
        announce(message);
      }
    })();
  }, []);

  const onRecovered = useCallback(
    (_returnId: string, post: PostItem) => {
      // In All (or the Recovered filter) patch in place; a status-only list
      // that no longer matches loses the row with its count. The sheet already
      // invalidated the feed caches for the confirmed write, including a
      // success that completed after this dialog was dismissed.
      if (ownerStatusRef.current !== "ALL" && ownerStatusRef.current !== "RECOVERED") removeItem(post.id);
      else patchItem(post.id, { status: "RECOVERED" });
      clearStatusUndo();
      setManualCopyUrl(null);
      setActionError(null);
      setNotice("Report marked recovered.");
    },
    [clearStatusUndo, patchItem, removeItem],
  );

  const actions: OwnerReportActionHandlers = {
    onChangeStatus: changeStatus,
    onEdit: (post) => navigate(`/my/${post.id}/edit`),
    onShare: shareOne,
    onCopy: copyOne,
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

      {manualCopyUrl && (
        <div
          role="group"
          aria-label="Copy link"
          data-testid="my-posts-copy-manual"
          className="mx-4 flex flex-col gap-1 rounded-m3-sm border border-outline-variant bg-surface-container-low p-3"
        >
          <label htmlFor="my-reports-copy-link" className="text-xs text-on-surface-variant">
            Report link
          </label>
          <input
            id="my-reports-copy-link"
            readOnly
            value={manualCopyUrl}
            onFocus={(event) => {
              try {
                event.currentTarget.select();
              } catch {
                announce("Automatic selection isn't available. Press and hold the link to select it.");
              }
            }}
            className="min-h-[44px] w-full min-w-0 rounded-m3-sm border border-outline-variant bg-surface px-2 text-sm text-on-surface"
          />
          <p className="text-xs text-on-surface-variant">Select the link to copy it.</p>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => setManualCopyUrl(null)}
              className="min-h-[44px] rounded-full px-3 text-sm font-semibold underline"
            >
              Done
            </button>
          </div>
        </div>
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

      <RecoverySheet
        open={recoveryPost !== null}
        post={liveRecoveryPost}
        scopeKey={`${user?.id ?? "guest"}:${liveRecoveryPost?.id ?? ""}:${liveRecoveryPost?.type ?? ""}:${liveRecoveryPost?.userId ?? ""}`}
        onClose={() => setRecoveryPost(null)}
        onRecovered={onRecovered}
        onRate={() => {
          setRecoveryPost(null);
          navigate("/settings/returns");
        }}
      />

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

      {statusUndo && !pendingDelete && (
        <div
          role="status"
          data-testid="my-posts-status-undo"
          className="sticky bottom-3 mx-4 flex items-center gap-3 rounded-m3-md bg-on-surface px-4 py-3 text-sm text-surface"
        >
          <span className="flex-1">
            Status changed to {ownerStatusLabel(statusUndo.next, statusUndo.type)} — Undo for a few seconds
          </span>
          <button
            type="button"
            onClick={undoStatus}
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
