import { useCallback, useEffect, useState } from "react";
import { SettingsGroup, SettingsPage } from "../components/settings";
import { ModerationCaseSheet } from "../components/ModerationCaseSheet";
import { fetchMyRole, type MyRole } from "../services/roles";
import { fetchModerationQueue, type ModerationQueueEntry } from "../services/moderation";
import { friendlyError } from "../utils/friendlyErrors";
import {
  MODERATION_VISIBILITY_LABELS,
  REPORT_REASON_LABELS,
  REPORT_TARGET_SUBJECTS,
  UNAVAILABLE_SENTENCES,
  formatSafetyDate,
} from "../utils/safetyCopy";
import { isMissingServerFunction } from "../utils/safetyService";
import "../components/AdminConsole.css";

/** The permission that opens the queue. The server checks it on every call. */
const QUEUE_CAPABILITY = "reports_review";

/**
 * The moderation queue — the open reports, the target behind them and the
 * actions a moderator may take.
 *
 * ORDINARY READERS NEVER REACH IT. The screen reads the signed-in account's
 * role from the server (`fetchMyRole` — the one read every privileged
 * surface uses) and, without the `reports_review` permission, it says so and
 * asks for nothing: the queue is never even requested. The route behind it
 * is guarded as well, so a typed URL lands back in Settings. The server
 * refuses the queue and the case reader with 42501 regardless of what the
 * client shows (MC D36) — the client check only avoids offering what the
 * server will refuse.
 *
 * A CASE IS DERIVED, NOT A ROW. There is no case table: the queue groups
 * the open reports by the thing they are about, and the target reader is
 * the detail (MC D38).
 */
export function ModerationQueue() {
  const [role, setRole] = useState<MyRole | null>(null);
  const [roleReady, setRoleReady] = useState(false);
  const [queue, setQueue] = useState<ModerationQueueEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [open, setOpen] = useState<ModerationQueueEntry | null>(null);

  const allowed = role !== null && (role.isAdmin || role.capabilities.includes(QUEUE_CAPABILITY));

  const load = useCallback(async () => {
    setError(null);
    setUnavailable(null);
    try {
      setQueue(await fetchModerationQueue());
    } catch (err) {
      if (isMissingServerFunction(err)) {
        // "There is nothing to review" would be a lie: the queue is missing.
        setUnavailable(UNAVAILABLE_SENTENCES.queue);
        setQueue(null);
        return;
      }
      setError(friendlyError(err).message);
      setQueue([]);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    void fetchMyRole()
      .then((value) => {
        if (!alive) return;
        setRole(value);
        setRoleReady(true);
      })
      .catch(() => {
        if (!alive) return;
        setRoleReady(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!allowed) return;
    void load();
  }, [allowed, load]);

  return (
    <SettingsPage
      title="Reports to review"
      backTo="/settings"
      description="The open reports, grouped by the thing they are about."
    >
      <SettingsGroup title="Open reports">
        {!roleReady ? (
          <p role="status" className="fb-admin-note">
            Checking your permissions…
          </p>
        ) : null}

        {roleReady && !allowed ? (
          <p role="status" data-testid="moderation-queue-denied" className="fb-admin-note">
            You do not have permission to review reports.
          </p>
        ) : null}

        {allowed && error ? (
          <p role="alert" data-testid="moderation-queue-error" className="fb-admin-error">
            {error}
          </p>
        ) : null}

        {allowed && unavailable ? (
          <p role="status" data-testid="moderation-queue-unavailable" className="fb-admin-note">
            {unavailable}
          </p>
        ) : null}

        {allowed && !error && !unavailable && queue === null ? (
          <p role="status" className="fb-admin-note">
            Loading the queue…
          </p>
        ) : null}

        {allowed && !error && !unavailable && queue !== null && queue.length === 0 ? (
          <p className="fb-admin-note">There is nothing to review.</p>
        ) : null}

        {allowed && !unavailable && queue !== null && queue.length > 0 ? (
          <ol className="fb-admin-log" data-testid="moderation-queue-list">
            {queue.map((entry) => {
              const reasons = entry.reasons.map((reason) => REPORT_REASON_LABELS[reason]);
              const visibility =
                entry.currentVisibility &&
                entry.currentVisibility in MODERATION_VISIBILITY_LABELS
                  ? MODERATION_VISIBILITY_LABELS[
                      entry.currentVisibility as keyof typeof MODERATION_VISIBILITY_LABELS
                    ]
                  : null;
              return (
                <li key={`${entry.targetType}-${entry.targetId}`} className="fb-admin-log-row">
                  <button
                    type="button"
                    onClick={() => setOpen(entry)}
                    data-testid="moderation-queue-row"
                    className="flex w-full flex-col items-start gap-1 rounded-m3-sm px-1 py-2 text-start hover:bg-surface-container"
                  >
                    <span className="fb-admin-log-headline">
                      {entry.reportCount === 1 ? "1 report" : `${entry.reportCount} reports`} about{" "}
                      {REPORT_TARGET_SUBJECTS[entry.targetType]}
                    </span>
                    <span className="fb-admin-log-detail">
                      {reasons.length > 0 ? `Reasons: ${reasons.join(", ")}. ` : ""}
                      Last reported {formatSafetyDate(entry.lastReportedAt)}.
                    </span>
                    {visibility ? (
                      <span className="fb-admin-log-detail">Now: {visibility}.</span>
                    ) : null}
                    {!entry.targetExists ? (
                      <span className="fb-admin-log-detail">
                        The thing that was reported no longer exists.
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ol>
        ) : null}
      </SettingsGroup>

      <ModerationCaseSheet
        open={open !== null}
        entry={open}
        capabilities={role?.capabilities ?? []}
        isAdmin={role?.isAdmin === true}
        onClose={() => setOpen(null)}
        onApplied={() => {
          setOpen(null);
          void load();
        }}
      />
    </SettingsPage>
  );
}
