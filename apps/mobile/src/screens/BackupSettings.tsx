import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "../components/Button";
import { announce } from "../components/LiveRegion";
import { PreferenceSwitchRow, SettingsGroup, SettingsPage, StatusPill } from "../components/settings";
import { useAuth } from "../auth";
import { ApiError } from "../services/session";
import { DriveAuthError } from "../services/messaging/driveAuth";
import { rotateBackupKey } from "../services/messaging/backupKey";
import type { BackupStatus } from "../services/messaging/backupService";
import { driveBackup } from "../services/messaging/backupRuntime";
import { refreshMessaging } from "../services/messaging/runtime";
import { friendlyError } from "../utils/friendlyErrors";

/** One human sentence for a backup action; never raw transport or provider text. */
function backupError(err: unknown): string {
  if (err instanceof DriveAuthError) return err.message;
  if (err instanceof ApiError && err.message) return err.message;
  return friendlyError(err).message;
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
        ? { title: "Google Drive backup", label: "Not available here", tone: "neutral",
          description: "Drive backup isn't available in the Android app yet. Your chats stay on this device." }
        : { title: "Google Drive backup", label: "Not set up", tone: "neutral",
          description: "Drive backup isn't configured for this build." };
    case "off":
      return { title: "Google Drive backup", label: "Off", tone: "neutral",
        description: "Back up your chats and restore them on another device." };
    case "needs-connection":
      return { title: "Google Drive backup", label: "Needs reconnecting", tone: "warning",
        description: "Reconnect Google Drive to keep backing up." };
    case "attention":
      return status.lastError === "auth"
        ? { title: "Google Drive backup", label: "Needs reconnecting", tone: "warning",
          description: "Reconnect Google Drive to keep backing up." }
        : status.lastError === "throttled"
          ? { title: "Google Drive backup", label: "Waiting on Google Drive", tone: "warning",
            description: "Google Drive asked us to slow down. We'll try again automatically." }
          : { title: "Google Drive backup", label: "Needs attention", tone: "warning",
            description: "The last backup didn't finish. We'll try again automatically." };
    case "waiting":
      return { title: "Google Drive backup", label: "On", tone: "success",
        description: "Changes are backed up automatically while you use Chat." };
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
 * reconnect action, a manual pass, restore, and an advanced way to disconnect
 * or replace the key. Encryption happens before upload, so Google stores bytes
 * it cannot open.
 */
export function BackupSettings() {
  const { user } = useAuth();
  const backup = useMemo(() => driveBackup(), []);
  const [status, setStatus] = useState<BackupStatus>(() => backup.status());
  const [busy, setBusy] = useState<null | "connect" | "upload" | "restore" | "rotate">(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | "disconnect" | "rotate">(null);

  const refresh = useCallback(() => setStatus(backup.status()), [backup]);
  useEffect(() => { refresh(); }, [refresh]);

  const run = async (kind: NonNullable<typeof busy>, action: () => Promise<string | null>) => {
    if (busy) return;
    setBusy(kind);
    setError(null);
    setNotice(null);
    try {
      const sentence = await action();
      refresh();
      if (sentence) {
        setNotice(sentence);
        announce(sentence);
      }
    } catch (err) {
      setError(backupError(err));
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const connect = () => run("connect", async () => {
    const next = await backup.connect();
    return next.kind === "up-to-date" ? "Backup is on. Your chats are saved to your Google Drive."
      : "Backup is on. The first backup will finish shortly.";
  });

  const upload = () => run("upload", async () => {
    const next = await backup.uploadNow();
    return next.kind === "up-to-date" ? "Your chats are backed up."
      : "Backup didn't finish. We'll try again automatically.";
  });

  const restore = () => run("restore", async () => {
    const result = await backup.restore();
    if (user) await refreshMessaging(user.id).catch(() => undefined);
    const count = result.messages;
    return count === 0 ? "There was nothing to restore yet."
      : `Restored ${count} message${count === 1 ? "" : "s"}. Chat is catching up.`;
  });

  const disconnect = () => run("connect", async () => {
    backup.forget();
    setConfirm(null);
    return "Google Drive was disconnected. Existing backups stay in your Drive.";
  });

  const rotate = () => run("rotate", async () => {
    await rotateBackupKey();
    backup.markDirty();
    await backup.uploadNow();
    setConfirm(null);
    return "A new backup key was created. Older backups can no longer be opened.";
  });

  const copy = statusCopy(status);
  const available = status.kind !== "unavailable";
  // Usable = connected and nothing needs a fresh consent. A Google refusal
  // hides restore/advanced until the user reconnects, because those actions
  // cannot succeed without a token.
  const enabled = status.kind === "waiting" || status.kind === "up-to-date"
    || (status.kind === "attention" && status.lastError !== "auth");
  const connected = enabled;
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
        description="Backups are locked on this device before they reach Drive. Only your account can open them — Google can't read them."
      >
        <div className="flex items-start justify-between gap-3 px-3 py-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-on-surface">{copy.title}</p>
            <p className="mt-1 text-sm text-on-surface-variant">{copy.description}</p>
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
            <Button loading={busy === "connect"} onClick={() => void connect()}>
              {status.kind === "needs-connection" || status.kind === "attention" ? "Reconnect Google Drive" : "Connect Google Drive"}
            </Button>
          </div>
        ) : null}

        {available && enabled ? (
          <div className="flex flex-wrap items-center gap-2 px-3 pb-4">
            <Button variant="outline" loading={busy === "upload"} disabled={busy !== null}
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
            description="Batches changes every few minutes while you use Chat."
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
            <Button variant="outline" loading={busy === "restore"} disabled={busy !== null}
              onClick={() => void restore()}>
              Restore from Drive
            </Button>
          </div>
        </SettingsGroup>
      ) : null}

      {available && connected ? (
        <SettingsGroup
          title="Advanced"
          description="Only needed if someone else may have had access to your backup."
        >
          {confirm === "rotate" ? (
            <div className="flex flex-col gap-2 px-3 py-3">
              <p className="text-sm text-on-surface">
                Replace the backup key? Older backups can no longer be opened, and a fresh full backup
                will be uploaded.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="error" loading={busy === "rotate"} onClick={() => void rotate()}>
                  Replace key
                </Button>
                <Button variant="text" disabled={busy !== null} onClick={() => setConfirm(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2 px-3 py-3">
              <Button variant="text" disabled={busy !== null} onClick={() => { setConfirm("rotate"); setError(null); }}>
                Replace backup key…
              </Button>
            </div>
          )}
        </SettingsGroup>
      ) : null}
    </SettingsPage>
  );
}
