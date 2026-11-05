import { useEffect, useRef } from "react";
import { useAuth } from "../auth";
import { clearDriveBackup, startDriveBackup } from "../services/messaging/backupRuntime";
import { clearMessagingRuntime, setMessagingAccount } from "../services/messaging/runtime";

/**
 * One runtime lifetime for Chat and its optional Drive backup.
 *
 * Disposal follows a real owner transition, never effect cleanup alone: at boot
 * this effect legitimately re-runs when the restored session arrives, and that
 * must not revoke the stored Google Drive grant or discard a live backup owner.
 * The same Norfold account may also refresh its session without another consent,
 * so only a different account (or sign-out) disposes the previous owner.
 */
export function MessagingLifecycle() {
  const { user, authSessionId } = useAuth();
  const accountId = user?.id ?? null;
  const owner = useRef<string | null>(null);

  useEffect(() => {
    const departing = owner.current;
    if (departing !== null && departing !== accountId) {
      // Real transition: dispose the departing owner before installing the new
      // one, so its backups cannot be published into the next account's scope.
      clearDriveBackup();
      clearMessagingRuntime();
    }
    owner.current = accountId;
    setMessagingAccount(accountId, authSessionId ?? null);
    if (!accountId || !authSessionId) return;
    // Repeated mounts share the process-wide ticker; this stop only releases it.
    return startDriveBackup();
  }, [accountId, authSessionId]);

  return null;
}
