import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../components/Button";
import { announce } from "../components/LiveRegion";
import { PreferenceSwitchRow, SettingsGroup, SettingsPage, StatusPill } from "../components/settings";
import { useAuth } from "../auth";
import { ApiError } from "../services/session";
import { DriveAuthError } from "../services/messaging/driveAuth";
import type { BackupOperationResult, BackupStatus } from "../services/messaging/backupService";
import { driveBackup } from "../services/messaging/backupRuntime";
import { refreshMessaging } from "../services/messaging/runtime";
import { friendlyError } from "../utils/friendlyErrors";

/** One human sentence for a backup action; never raw transport or provider text. */
function backupError(err: unknown): string {
  if (err instanceof BackupActionError) return err.message;
  if (err instanceof DriveAuthError) return err.message;
  if (err instanceof ApiError && err.message) return err.message;
  return friendlyError(err).message;
}
class BackupActionError extends Error {}
function requireOutcome(result: BackupOperationResult, kind: "committed" | "restored"): void {
  if (result.kind === kind) return;
  if (result.kind === "needs-connection") throw new BackupActionError("Reconnect Google Drive, then try again.");
  if (result.kind === "skipped") throw new BackupActionError(result.reason === "superseded"
    ? "Backup stopped. Check its status before trying again."
    : "Backup didn't start. Wait for Chat to connect, then try again.");
  if (result.kind === "failed") throw new BackupActionError(result.reason === "integrity"
    ? "This backup couldn't be opened safely. Your chats and existing backup have not been replaced."
    : result.reason === "storage" ? "Backup didn't finish. Check available storage, then try again."
      : result.reason === "throttled" ? "Google Drive asked us to wait. Try again later."
        : "Backup didn't finish. Check your connection, then try again.");
  throw new BackupActionError("This action didn't finish. Try again.");
}

/** Relative recency without an exact timestamp or implementation term. */
export function describeBackupTime(ms: number, now = Date.now()): string {
  const elapsed = Math.max(0, now - ms);
  if (elapsed < 2 * 60_000) return "just now";
  if (elapsed < 60 * 60_000) return `${Math.floor(elapsed / 60_000)} minutes ago`;
  if (elapsed < 24 * 60 * 60_000) {
    const hours = Math.floor(elapsed / (60 * 60_000));
    return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  }
  const days = Math.floor(elapsed / (24 * 60 * 60_000));
  return days === 1 ? "yesterday" : `${days} days ago`;
}

function statusCopy(status: BackupStatus): { title: string; description: string;
  tone: "neutral" | "success" | "warning" | "error"; label: string } {
  switch (status.kind) {
    case "unavailable":
      return status.reason === "native"
        ? { title: "Google Drive backup", label: "Not available", tone: "neutral",
          description: "This build can't reach Google Drive. Your chats stay on this device." }
        : { title: "Google Drive backup", label: "Not set up", tone: "neutral",
          description: "Drive backup isn't configured for this build." };
    case "off":
      return { title: "Google Drive backup", label: "Off", tone: "neutral",
        description: "Back up your chats and restore them on another device." };
    case "needs-connection":
      return { title: "Google Drive backup", label: "Needs reconnecting", tone: "warning",
          description: "Reconnect Google Drive to keep backing up." };
    case "running":
      return { title: "Google Drive backup", label: "In progress", tone: "neutral",
        description: status.operation === "restore" ? "Restoring saved chats…" : "Saving your chats to Google Drive…" };
    case "stopping":
      return { title: "Google Drive backup", label: "Stopping", tone: "neutral",
        description: "Waiting for the current request to finish. New backup writes have stopped." };
    case "attention":
      return status.lastError === "auth"
        ? { title: "Google Drive backup", label: "Needs reconnecting", tone: "warning",
          description: "Reconnect Google Drive to keep backing up." }
        : status.lastError === "throttled"
          ? { title: "Google Drive backup", label: "Waiting on Google Drive", tone: "warning",
            description: "Google Drive asked us to slow down. We'll try again automatically." }
           : { title: "Google Drive backup", label: "Needs attention", tone: "warning",
             description: status.lastError === "integrity" ? "Your existing backup couldn't be opened safely. It has not been replaced."
               : status.lastError === "storage" ? "Check available storage, then retry the backup."
                 : "The last backup didn't finish. We'll retry while Norfold is open." };
    case "waiting":
      return { title: "Google Drive backup", label: "On", tone: "success",
        description: "Changes are backed up while Norfold is open. Keep it open until the backup finishes." };
    case "up-to-date":
      return { title: "Google Drive backup", label: "Up to date", tone: "success",
        description: `Last backed up ${describeBackupTime(status.lastUploadAt)}.` };
  }
}

/**
 * Optional encrypted backup to the user's own Google Drive.
 *
 * The Google account is chosen here and only for backup: connecting it never
 * becomes a Norfold sign-in. The screen shows friendly status, one connect or
 * reconnect action, a manual pass, restore, and an explicit disconnect. Key
 * replacement is not offered: it needs the acceptance-gated rotation protocol.
 * Encryption happens before upload, so Google stores bytes it cannot open.
 */
export function BackupSettings() {
  const { user, authSessionId } = useAuth();
  const backup = useMemo(() => driveBackup(), [user?.id, authSessionId]);
  const actionGeneration = useRef(0);
  const [status, setStatus] = useState<BackupStatus>(() => backup.status());
  const [busy, setBusy] = useState<null | "connect" | "upload" | "restore">(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | "disconnect">(null);

  const refresh = useCallback(() => setStatus(backup.status()), [backup]);
  useEffect(() => {
    actionGeneration.current++;
    setBusy(null); setError(null); setNotice(null); setConfirm(null);
    const stop = backup.subscribe(refresh);
    refresh();
    return () => { actionGeneration.current++; stop(); };
  }, [backup, refresh, user?.id, authSessionId]);

  const run = async (kind: NonNullable<typeof busy>, action: (current: () => boolean) => Promise<string | null>) => {
    if (busy) return;
    const ticket = actionGeneration.current;
    setBusy(kind);
    setError(null);
    setNotice(null);
    try {
      const sentence = await action(() => ticket === actionGeneration.current);
      if (ticket !== actionGeneration.current) return;
      refresh();
      if (sentence) {
        setNotice(sentence);
        announce(sentence);
      }
    } catch (err) {
      if (ticket === actionGeneration.current) setError(backupError(err));
    } finally {
      if (ticket === actionGeneration.current) { setBusy(null); refresh(); }
    }
  };

  const connect = () => run("connect", async () => {
    const next = await backup.connect();
    requireOutcome(next, "committed");
    return "Backup is on. Your chats are saved to your Google Drive.";
  });

  const upload = () => run("upload", async () => {
    const next = await backup.uploadNow();
    requireOutcome(next, "committed");
    return "Your chats are backed up.";
  });

  const restore = () => run("restore", async current => {
    const result = await backup.restore();
    if (!current()) return null;
    requireOutcome(result, "restored");
    if (result.kind !== "restored") return null;
    if (user) {
      try { await refreshMessaging(user.id); } catch {
        throw new BackupActionError("Your saved chats were restored, but Chat couldn't catch up. Open Chat and retry sync before relying on older messages.");
      }
    }
    const count = result.messages;
    return count === 0 ? "There was nothing to restore yet."
      : `Restored ${count} message${count === 1 ? "" : "s"}. Chat is catching up.`;
  });

  const disconnect = () => run("connect", async () => {
    backup.forget();
    setConfirm(null);
    return "Google Drive was disconnected. Existing backups stay in your Drive.";
  });

  const copy = statusCopy(status);
  const available = status.kind !== "unavailable";
  // Usable = connected and nothing needs a fresh consent. A Google refusal
  // hides restore until the user reconnects, because it cannot succeed without
  // a token. Key replacement is deliberately absent: it is uncontained scope.
  const enabled = status.kind === "waiting" || status.kind === "up-to-date"
    || status.kind === "running"
    || (status.kind === "attention" && status.lastError !== "auth");
  const connected = enabled;
  const running = status.kind === "running" || status.kind === "stopping";
  const needsConnect = status.kind === "off" || status.kind === "needs-connection"
    || (status.kind === "attention" && status.lastError === "auth");

  return (
    <SettingsPage
      title="Chat backup"
      description="Keep your conversations with you."
      backTo="/settings"
    >
      <SettingsGroup
        title="Google Drive"
        description="Backups are encrypted on this device before they reach Drive, so Google can't read them. The key stays with your Norfold account and is re-issued to your signed-in devices so a reinstall can restore."
      >
        <div className="flex items-start justify-between gap-3 px-3 py-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-on-surface">{copy.title}</p>
            <p className="mt-1 text-sm text-on-surface-variant">{copy.description}</p>
            {status.lastUploadAt !== undefined && status.kind !== "up-to-date" ? (
              <p className="mt-1 text-sm text-on-surface-variant">Last backed up {describeBackupTime(status.lastUploadAt)}.</p>
            ) : null}
          </div>
          <StatusPill tone={copy.tone}>{copy.label}</StatusPill>
        </div>

        {notice ? (
          <p role="status" data-testid="backup-notice" className="px-3 pb-3 text-sm text-on-surface-variant">
            {notice}
          </p>
        ) : null}
        {error ? (
          <p role="alert" data-testid="backup-error" className="px-3 pb-3 text-sm text-error">
            {error}
          </p>
        ) : null}

        {available && needsConnect ? (
          <div className="flex flex-wrap items-center gap-2 px-3 pb-4">
            <Button loading={busy === "connect"} disabled={running || busy !== null} onClick={() => void connect()}>
              {status.kind === "needs-connection" || status.kind === "attention" ? "Reconnect Google Drive" : "Connect Google Drive"}
            </Button>
          </div>
        ) : null}

        {available && enabled ? (
          <div className="flex flex-wrap items-center gap-2 px-3 pb-4">
            <Button variant="outline" loading={busy === "upload"} disabled={running || busy !== null}
              onClick={() => void upload()}>
              Back up now
            </Button>
            <Button variant="text" disabled={busy !== null} onClick={() => { setConfirm("disconnect"); setError(null); }}>
              Disconnect Google Drive…
            </Button>
          </div>
        ) : null}

        {available && connected ? (
          <PreferenceSwitchRow
            title="Back up automatically"
            description="Batches changes every few minutes while Norfold is open."
            checked={enabled}
            disabled={busy !== null}
            onChange={(next) => {
              if (next) { void connect(); return; }
              backup.disable();
              refresh();
              const sentence = "Automatic backup is off.";
              setNotice(sentence);
              announce(sentence);
            }}
          />
        ) : null}

        {confirm === "disconnect" ? (
          <div className="flex flex-col gap-2 px-3 pb-4">
            <p className="text-sm text-on-surface">
              Disconnect Google Drive? Automatic backup stops, and this device forgets the connection.
              Existing backups stay in your Drive.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="error" loading={busy === "connect"} onClick={() => void disconnect()}>
                Disconnect
              </Button>
              <Button variant="text" disabled={busy !== null} onClick={() => setConfirm(null)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : null}
      </SettingsGroup>

      {available && connected ? (
        <SettingsGroup
          title="Restore"
          description="On a new device, restore adds what Drive has to what is already here. Deleted and unsent messages stay deleted."
        >
          <div className="flex flex-wrap items-center gap-2 px-3 py-3">
            <Button variant="outline" loading={busy === "restore"} disabled={running || busy !== null}
              onClick={() => void restore()}>
              Restore from Drive
            </Button>
          </div>
        </SettingsGroup>
      ) : null}
    </SettingsPage>
  );
}
