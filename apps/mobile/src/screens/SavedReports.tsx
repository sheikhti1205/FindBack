import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bookmark, X } from "lucide-react";
import { Link } from "react-router";
import type { PostItem } from "@findback/shared";
import { useAuth } from "../auth";
import { BackButton } from "../components/BackButton";
import { EmptyView, ErrorView, Skeleton } from "../components/uiPrimitives";
import { useSavedReportsState, type SavedReportRow } from "../hooks/useSavedReports";
import { ApiError } from "../services/session";
import { fetchPost } from "../services/posts";
import { timeAgo } from "../utils/dates";

/**
 * Saved reports — where the reader sees what they saved.
 *
 * This screen owns NOTHING but the report CONTENT. The saved list itself
 * belongs to the saved-reports provider: the device list, the account list,
 * the loading state, the errors and the retry all live there, so the button on
 * a report and the row on this screen can never disagree about what is saved.
 * The screen reads that one list and fetches the reports it points at.
 *
 * A report that no longer exists (deleted, or not fetchable) is LABELLED, not
 * crashed: the row keeps the saved title and says so, and the reader can still
 * remove it. The footer states where the saves live — "Saved to your account"
 * only when the account confirmed every one of them, "Saved on this device"
 * otherwise, and "Saved for this session only" when the browser refused to
 * store the list AND the account does not hold the saves. It never claims a
 * sync that did not happen.
 */

/**
 * How many saved reports the list shows at a time.
 *
 * This is a PAGE size, not a limit: the reader can grow the list, so a saved
 * report past the first page is still reachable and removable. A cap with no
 * way past it would leave the tail of the list permanently unreachable.
 */
const PAGE_SIZE = 20;

/**
 * May this row claim the save is only on this device?
 *
 * "On this device only" is a claim about WHERE the save lives, so it may only
 * be said when the account does NOT hold the report. A record the account
 * holds is on the account, whatever a stale issue says — and the footer below
 * says exactly that, so a row that claimed otherwise would contradict the
 * screen it sits on.
 *
 * The predicate is exported so the rule can be pinned by a test instead of
 * only by the shape of the code.
 */
export function isDeviceOnlySave(row: {
  onAccount: boolean;
  issue?: { intent: string; accountFailed?: boolean } | null;
}): boolean {
  if (row.onAccount) return false;
  return row.issue?.intent === "save" && row.issue.accountFailed === true;
}

type RowNote = "missing" | "error" | null;

const NO_ROWS: readonly SavedReportRow[] = [];

export function SavedReports() {
  const { user } = useAuth();
  const accountId = user?.id ?? null;
  const api = useSavedReportsState();

  const rows = api?.rows ?? NO_ROWS;
  const ids = useMemo(() => rows.map((row) => row.id), [rows]);
  /** The ids as one key: the content is refetched when the SET of ids changes. */
  const rowKey = ids.join("|");

  /**
   * How many rows the list shows.
   *
   * The reader grows it a page at a time, so every saved report stays
   * reachable and removable — a cap with no way past it would strand the tail
   * of the list. A new ACCOUNT starts at the first page again, so one
   * reader's paging never carries into the next reader's list.
   */
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [pageAccount, setPageAccount] = useState(accountId);
  if (pageAccount !== accountId) {
    setPageAccount(accountId);
    setVisibleCount(PAGE_SIZE);
  }

  const [posts, setPosts] = useState<Record<string, PostItem>>({});
  const [notes, setNotes] = useState<Record<string, Exclude<RowNote, null>>>({});
  const [contentError, setContentError] = useState<string | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  const [retryToken, setRetryToken] = useState(0);
  /** The generation of the content fetch: a late answer from a previous
   * account (or an unmounted screen) is dropped instead of being written. */
  const fetchGeneration = useRef(0);
  const idsRef = useRef<string[]>(ids);
  idsRef.current = ids;

  /**
   * Fetch the reports behind the saved ids.
   *
   * Each report is fetched on its own; a report that cannot be fetched is
   * recorded as a note on its row instead of failing the whole screen. The
   * answer is only used when it belongs to the account that is on screen now
   * and the screen is still mounted.
   */
  useEffect(() => {
    if (!accountId) return;
    const generation = fetchGeneration.current + 1;
    fetchGeneration.current = generation;
    const wanted = idsRef.current;
    if (wanted.length === 0) {
      setPosts({});
      setNotes({});
      setContentError(null);
      setContentLoading(false);
      return;
    }
    let cancelled = false;
    setContentLoading(true);
    void (async () => {
      const results = await Promise.allSettled(wanted.map((id) => fetchPost(id)));
      if (cancelled || fetchGeneration.current !== generation) return;
      const nextPosts: Record<string, PostItem> = {};
      const nextNotes: Record<string, Exclude<RowNote, null>> = {};
      let transportFailures = 0;
      results.forEach((result, index) => {
        const id = wanted[index]!;
        if (result.status === "fulfilled") {
          nextPosts[id] = result.value;
          return;
        }
        const missing =
          result.reason instanceof ApiError && result.reason.status === 404;
        if (!missing) transportFailures += 1;
        nextNotes[id] = missing ? "missing" : "error";
      });
      setPosts(nextPosts);
      setNotes(nextNotes);
      // The screen failed to load what it points at — that is a real failure,
      // not an empty list. A report that merely no longer exists is labelled
      // on its own row.
      setContentError(
        transportFailures > 0 && transportFailures === wanted.length
          ? "Couldn't load your saved reports."
          : null,
      );
      setContentLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId, rowKey, retryToken]);

  /** The rows to render: the first page, plus whatever the reader asked for. */
  const visibleRows = useMemo(() => rows.slice(0, visibleCount), [rows, visibleCount]);
  const hiddenCount = Math.max(0, rows.length - visibleRows.length);

  /**
   * Remove one report — from the device list and from the account.
   *
   * The provider owns the removal (it knows the device list, the account list
   * and the account copy); the screen only asks and lets the list re-render.
   */
  const remove = useCallback(
    async (id: string) => {
      if (!api) return;
      await api.remove(id);
    },
    [api],
  );

  /**
   * Where the saves live. "Saved to your account" is only said when the
   * account answered AND holds every saved report; anything else is honestly
   * reported as device-only.
   *
   * A blocked store does not change where the SAVES live: when the account
   * holds every report, the save is on the account and only the DEVICE copy
   * is missing — saying "for this session only" would hide a save that is
   * safely on the account.
   */
  const storageLabel = useMemo(() => {
    if (!api) return "";
    if (api.pending) return "Saving to your account…";
    const allOnAccount = api.accountAnswered && api.rows.every((row) => row.onAccount);
    if (!api.storageHealthy) {
      return allOnAccount ? "Saved to your account" : "Saved for this session only";
    }
    if (api.rows.length === 0) return "Saved on this device";
    return allOnAccount ? "Saved to your account" : "Saved on this device";
  }, [api]);

  const loadError = api?.loadError ?? contentError;

  if (!api) {
    return (
      <div className="flex h-full flex-col gap-4 py-5">
        <header className="flex items-center gap-2 px-4">
          <BackButton fallbackTo="/profile" label="Back to profile" />
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight">Saved reports</h1>
          </div>
        </header>
        <p role="alert" className="px-4 text-sm text-on-surface-variant">
          Saved reports are unavailable right now.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-4 py-5">
      <header className="flex items-center gap-2 px-4">
        <BackButton fallbackTo="/profile" label="Back to profile" />
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">Saved reports</h1>
          <p className="text-sm text-on-surface-variant">
            {rows.length === 0
              ? "Reports you save are kept here."
              : `${rows.length} saved report${rows.length === 1 ? "" : "s"}`}
          </p>
        </div>
      </header>

      {api.error && (
        <p role="alert" className="px-4 text-sm text-error">
          {api.error}
        </p>
      )}

      {(api.loading || contentLoading) && rows.length === 0 ? (
        <div className="flex flex-col gap-3 px-4" data-testid="saved-reports-loading">
          <Skeleton label="Loading saved reports" height={60} />
          <Skeleton height={60} />
          <Skeleton height={60} />
        </div>
      ) : loadError ? (
        <ErrorView
          message={loadError}
          onRetry={() => {
            api.retry();
            setRetryToken((token) => token + 1);
          }}
        />
      ) : rows.length === 0 ? (
        <EmptyView
          icon={<Bookmark size={28} />}
          title="No saved reports yet"
          subtitle="Tap Save on a report to keep it here for later."
        />
      ) : (
        <>
          <ul className="flex flex-col" data-testid="saved-reports-list">
            {visibleRows.map((row) => {
              const post = posts[row.id];
              const note = notes[row.id] ?? null;
              const title = post?.title || row.title || "Saved report";
              return (
                <li
                  key={row.id}
                  className="flex items-center gap-1 border-b border-outline-variant px-4"
                >
                  <Link
                    to={`/posts/${row.id}`}
                    className="flex min-h-[60px] min-w-0 flex-1 items-center gap-3 py-2"
                  >
                    <Bookmark
                      size={18}
                      aria-hidden
                      fill="currentColor"
                      className="shrink-0 text-on-surface-variant"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] font-medium text-on-surface">
                        {title}
                      </span>
                      <span className="block truncate text-xs text-on-surface-variant">
                        Saved {row.savedAt ? timeAgo(row.savedAt) : "recently"}
                        {note === "missing" ? " · No longer available" : ""}
                        {note === "error" ? " · Couldn't load" : ""}
                        {row.issue?.storageFailed
                          ? row.onAccount
                            ? " · Not stored on this device"
                            : " · For this session only"
                          : ""}
                        {isDeviceOnlySave(row) ? " · On this device only" : ""}
                        {row.issue?.intent === "conflict"
                          ? " · Your account did not list it"
                          : ""}
                      </span>
                    </span>
                  </Link>
                  <button
                    type="button"
                    aria-label={`Remove ${title} from saved reports`}
                    onClick={() => void remove(row.id)}
                    className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-full text-on-surface-variant hover:bg-surface-container"
                  >
                    <X size={18} aria-hidden />
                  </button>
                </li>
              );
            })}
          </ul>
          {hiddenCount > 0 && (
            <div className="flex flex-col items-start gap-2 px-4">
              <p className="text-xs text-on-surface-variant">
                {hiddenCount} more saved report{hiddenCount === 1 ? "" : "s"} not shown.
              </p>
              <button
                type="button"
                onClick={() => setVisibleCount((count) => Math.min(count + PAGE_SIZE, rows.length))}
                className="min-h-[44px] rounded-m3-sm border border-outline-variant px-3 py-2 text-sm font-medium text-on-surface"
              >
                Show more
              </button>
            </div>
          )}
          <p
            data-testid="saved-reports-storage"
            className="px-4 text-xs text-on-surface-variant"
          >
            {storageLabel}
          </p>
        </>
      )}
    </div>
  );
}
