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
import { DriveBackup, type BackupLease } from "./backupService";
import { driveAuth } from "./driveAuth";
import { reportLogToMonitoring } from "../monitoring/sentry";
import {
  exportMessagingSnapshot, getMessagingRuntimeSnapshot, importMessagingSnapshot,
  subscribeMessagingRuntime, webInstallationId, getMessagingRuntimeGeneration,
} from "./runtime";

let instance: DriveBackup | null = null;
let detachDirty: (() => void) | null = null;
let scheduling: { timer: ReturnType<typeof setInterval>; subscribers: number } | null = null;

/** Only the canonical durable installation identity is eligible for backup. */
function backupDeviceId(): string {
  return webInstallationId();
}

function captureLease(): BackupLease | null {
  const state = getMessagingRuntimeSnapshot();
  if (!state.accountId || (state.status !== "ready" && state.status !== "offline")) return null;
  try {
    return Object.freeze({ accountId: state.accountId, deviceId: backupDeviceId(),
      sessionGeneration: getMessagingRuntimeGeneration(), driveGeneration: driveAuth().generation(), operationGeneration: 0 });
  } catch { return null; }
}

function isCurrent(lease: BackupLease): boolean {
  const state = getMessagingRuntimeSnapshot();
  return state.accountId === lease.accountId && getMessagingRuntimeGeneration() === lease.sessionGeneration
    && driveAuth().generation() === lease.driveGeneration
    && (state.status === "ready" || state.status === "offline");
}
function assertCurrent(lease: BackupLease): void {
  if (!isCurrent(lease)) throw new Error("Chat is not ready");
}

export function driveBackup(): DriveBackup {
  const backup = instance ??= new DriveBackup({
    auth: driveAuth(),
    captureLease, isCurrent,
    key: async lease => { assertCurrent(lease); const key = await readBackupKey(); assertCurrent(lease); return key; },
    snapshot: async lease => {
      assertCurrent(lease);
      const snapshot = await exportMessagingSnapshot(lease.accountId);
      assertCurrent(lease); return snapshot;
    },
    importSnapshot: async (lease, snapshot) => {
      assertCurrent(lease);
      await importMessagingSnapshot(lease.accountId, snapshot);
      assertCurrent(lease);
    },
  });
  if (detachDirty) return backup;
  let previous = getMessagingRuntimeSnapshot();
  detachDirty = subscribeMessagingRuntime(() => {
    const state = getMessagingRuntimeSnapshot();
    if (state.accountId === previous.accountId && state.revision !== previous.revision) backup.markDirty();
    previous = state;
    backup.reconcile();
  });
  return backup;
}

/** Called by canonical Auth/session cleanup. Never purges history or Drive. */
export function clearDriveBackup(): void {
  if (scheduling) clearInterval(scheduling.timer);
  scheduling = null;
  detachDirty?.(); detachDirty = null;
  // Retain one stable process-wide admission owner. A replacement instance
  // would admit a second writer while an aborted native/fetch request settles.
  // It holds only account policy, never keys, history or provider tokens.
  instance?.cancel();
  // Another Norfold account must explicitly choose its own Drive connection.
  // Optional provider cleanup must not veto Auth's private-state boundary.
  try {
    const outcome = driveAuth().forget();
    if (outcome?.durable === false) reportLogToMonitoring("warn", "Drive grant storage cleanup unverified");
  } catch { reportLogToMonitoring("warn", "Drive authorization cleanup unverified"); }
}

/**
 * Foreground app scheduling only; dirty ownership does not depend on a screen.
 * Repeated mounts share one ticker; no Android background guarantee.
 */
export function startDriveBackup(intervalMs = 60_000): () => void {
  const backup = driveBackup();
  scheduling ??= { subscribers: 0, timer: setInterval(() => {
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    void backup.tick();
  }, intervalMs) };
  const owner = scheduling;
  owner.subscribers++;
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    if (--owner.subscribers === 0) {
      clearInterval(owner.timer);
      if (scheduling === owner) scheduling = null;
    }
  };
}
