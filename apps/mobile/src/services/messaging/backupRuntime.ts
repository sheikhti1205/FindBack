/**
 * Wiring between the encrypted Drive backup policy and the live Chat runtime.
 *
 * One process-wide backup owner: history snapshots and restores only ever touch
 * the account whose messaging runtime is open, so a switch mid-read rejects
 * instead of crossing accounts. A single subscription marks the backup dirty as
 * history changes; a one-minute ticker batches the actual upload (the policy
 * itself only uploads after the 5–15 minute delay or a daily compaction).
 */
import { readBackupKey } from "./backupKey";
import { DriveBackup } from "./backupService";
import { driveAuth } from "./driveAuth";
import {
  exportMessagingSnapshot, getMessagingRuntimeSnapshot, importMessagingSnapshot,
  subscribeMessagingRuntime, webInstallationId,
} from "./runtime";

let instance: DriveBackup | null = null;

/** A stable installation label for the manifest; bootstrapping failures keep it unique. */
function backupDeviceId(): string {
  try {
    return webInstallationId();
  } catch {
    return crypto.randomUUID();
  }
}

function openAccount(): string {
  const accountId = getMessagingRuntimeSnapshot().accountId;
  if (!accountId) throw new Error("Chat is not ready");
  return accountId;
}

export function driveBackup(): DriveBackup {
  instance ??= new DriveBackup({
    auth: driveAuth(),
    key: readBackupKey,
    accountId: () => getMessagingRuntimeSnapshot().accountId,
    deviceId: backupDeviceId,
    snapshot: () => exportMessagingSnapshot(openAccount()),
    importSnapshot: async (snapshot) => {
      await importMessagingSnapshot(openAccount(), snapshot);
    },
  });
  return instance;
}

let subscribers = 0;
let detachDirty: (() => void) | null = null;

/**
 * Keep the dirty flag and the ticker alive while at least one screen is open.
 * Returns an idempotent stop function; the last stop clears both.
 */
export function startDriveBackup(intervalMs = 60_000): () => void {
  const backup = driveBackup();
  if (subscribers++ === 0) {
    detachDirty = subscribeMessagingRuntime(() => backup.markDirty());
  }
  const timer = setInterval(() => { void backup.tick(); }, intervalMs);
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    if (--subscribers === 0 && detachDirty) {
      detachDirty();
      detachDirty = null;
    }
  };
}
