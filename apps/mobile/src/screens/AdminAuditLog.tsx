import { useEffect, useState } from "react";
import { readAuditLog, type AuditEntry } from "../services/roles";
import { SettingsGroup, SettingsPage } from "../components/settings";
import { adminErrorMessage, describeActivity } from "../components/adminConsole";
import { AdminAuditLine } from "../components/AdminConsoleParts";
import "../components/AdminConsole.css";

/**
 * The activity log (integrator: mount at `/settings/team/audit`).
 *
 * The append-only record of every change to a role or a permission, newest
 * first. Each row says what happened in words — who or what was affected and
 * when — because the log is for a person to read, not for a database to dump.
 *
 * Reading it needs the `audit_read` permission. The server decides; when it
 * refuses, the refusal is shown as a sentence.
 */
export function AdminAuditLog() {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void readAuditLog(100)
      .then((rows) => {
        if (cancelled) return;
        // The server returns newest first; the sort keeps that true even if a
        // future page of the log arrives in another order.
        setEntries([...rows].sort((left, right) => right.createdAt.localeCompare(left.createdAt)));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(
          adminErrorMessage(err, "You do not have permission to read the activity log."),
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <SettingsPage
      title="Activity log"
      description="Every change to a role or a permission, newest first. Entries cannot be edited or removed."
      backTo="/settings/team"
    >
      <SettingsGroup title="Recent activity">
        {loading && (
          <p role="status" className="fb-admin-note">
            Loading the activity log…
          </p>
        )}
        {error && (
          <p role="alert" className="fb-admin-error">
            {error}
          </p>
        )}
        {!loading && !error && (entries ?? []).length === 0 && (
          <p className="fb-admin-note">Nothing has happened yet.</p>
        )}
        {(entries ?? []).length > 0 && (
          <ol className="fb-admin-log">
            {(entries ?? []).map((entry) => {
              const line = describeActivity(entry);
              return (
                <AdminAuditLine
                  key={entry.id}
                  headline={line.headline}
                  detail={line.detail}
                  time={line.time}
                />
              );
            })}
          </ol>
        )}
      </SettingsGroup>
    </SettingsPage>
  );
}
