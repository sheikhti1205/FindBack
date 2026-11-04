import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { Button } from "./Button";
import { announce } from "./LiveRegion";
import { DriveAuthError } from "../services/messaging/driveAuth";
import { driveBackup } from "../services/messaging/backupRuntime";

/**
 * The one optional backup prompt.
 *
 * It appears once, only after a real history exists, and only while the user has
 * not decided. "Not now" is remembered; the feature stays reachable from
 * Settings. Connecting here authorizes Google Drive for backup only — never a
 * Norfold sign-in — so the Google account may differ from the Norfold account.
 */
export function BackupPrompt({ sequences }: { sequences: number }) {
  const backup = useMemo(() => driveBackup(), []);
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setShow(backup.promptDecision(sequences) === "show");
  }, [backup, sequences]);

  if (!show) return null;

  const connect = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await backup.connect();
      setShow(false);
      announce("Backup is on. Your chats are saved to your Google Drive.");
    } catch (err) {
      setError(err instanceof DriveAuthError ? err.message
        : "Google Drive could not be connected. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const notNow = () => {
    backup.dismissPrompt();
    setShow(false);
  };

  return (
    <section className="fb-chat-backup-prompt" aria-labelledby="backup-prompt-title">
      <div>
        <h2 id="backup-prompt-title">Keep your conversations with you</h2>
        <p>
          Connect a Google account to automatically back up your Norfold chats and restore them on
          another device. Only your account can open them.
        </p>
        {error ? <p role="alert" className="fb-chat-backup-error">{error}</p> : null}
      </div>
      <div className="fb-chat-backup-actions">
        <Button loading={busy} onClick={() => void connect()}>Connect Google Drive</Button>
        <Button variant="text" disabled={busy} onClick={notNow}>Not now</Button>
        <Link to="/settings/backup" className="fb-chat-backup-settings">Backup settings</Link>
      </div>
    </section>
  );
}
