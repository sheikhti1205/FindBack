import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../auth";
import { useSafetyLifetime } from "../utils/useSafetyLifetime";
import { SettingsGroup, SettingsPage, SettingsRow, StatusPill } from "../components/settings";
import { listMyReports, type ReportReceipt } from "../services/moderation";
import { friendlyError } from "../utils/friendlyErrors";
import {
  REPORT_REASON_LABELS,
  REPORT_STATUS_LABELS,
  REPORT_TARGET_LABELS,
  UNAVAILABLE_SENTENCES,
  formatSafetyDate,
} from "../utils/safetyCopy";
import { isMissingServerFunction } from "../utils/safetyService";

/**
 * The reader's own reports and their status.
 *
 * This is the honest receipt: the server grants a reporter FIVE fields about
 * their own report — what kind of thing it was about, which reason, what
 * state it is in, and when it was sent (MC D4). There is no target id, no
 * evidence snapshot, no internal note and no reviewer, and this screen shows
 * exactly those five things and nothing else.
 *
 * The reader never learns who looked at a report, and no moderator note,
 * reviewer identity or target identifier is ever rendered here — the server
 * does not grant them, so there is nothing to leak.
 */
export function SafetyReports() {
  const { user } = useAuth();
  if (!user) return null;
  return <AccountSafetyReports key={user.id} />;
}

function AccountSafetyReports() {
  const alive = useSafetyLifetime();
  const request = useRef(0);
  const [rows, setRows] = useState<ReportReceipt[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);

  const load = useCallback(async () => {
    const version = ++request.current;
    const isCurrent = () => alive.current && request.current === version;
    setError(null);
    setUnavailable(null);
    try {
      const result = await listMyReports();
      if (isCurrent()) setRows(result);
    } catch (err) {
      if (!isCurrent()) return;
      if (isMissingServerFunction(err)) {
        // "You have not sent any reports" would be a lie here: the list is
        // missing, not empty.
        setUnavailable(UNAVAILABLE_SENTENCES.myReports);
        setRows(null);
        return;
      }
      setError(friendlyError(err).message);
    }
  }, [alive]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <SettingsPage
      title="Reports you sent"
      backTo="/settings/privacy"
      description="Every report you send, and where it has got to."
    >
      <SettingsGroup
        title="Your reports"
        description="We keep these so you can see what happened. We never show you who looked at a report."
      >
        {error ? (
          <p role="alert" data-testid="safety-reports-error" className="px-3 py-2 text-sm text-error">
            {error}
          </p>
        ) : null}

        {unavailable ? (
          <p role="status" data-testid="safety-reports-unavailable" className="px-3 py-2 text-sm text-on-surface-variant">
            {unavailable}
          </p>
        ) : null}

        {!error && !unavailable && rows === null ? (
          <p role="status" className="fb-settings-row-description">
            Loading your reports…
          </p>
        ) : null}

        {!error && !unavailable && rows !== null && rows.length === 0 ? (
          <p className="fb-settings-row-description">You haven’t sent any reports yet.</p>
        ) : null}

        {rows?.map((row) => (
          <SettingsRow
            key={row.id}
            title={REPORT_REASON_LABELS[row.reason]}
            description={`About a ${REPORT_TARGET_LABELS[row.targetType]} · sent ${formatSafetyDate(row.createdAt)}`}
            value={<StatusPill tone={row.status === "ACTIONED" ? "success" : "neutral"}>{REPORT_STATUS_LABELS[row.status]}</StatusPill>}
          />
        ))}
      </SettingsGroup>
    </SettingsPage>
  );
}
