/**
 * Optional encrypted Drive backup: policy, scheduling and the restore path.
 *
 * Drive is durable backup, never foreground transport and never authority. A
 * pass uploads only when the user enabled backup and something changed (or a
 * daily compaction is due); failures back off exponentially with Google's own
 * retry delay respected. A restored snapshot is merged through the ordinary
 * local import, so suppressions still win and the caller must re-sync current
 * conversation heads before trusting stale bodies.
 */
import type { HistorySnapshot } from "./history";
import {
  downloadBackup, uploadBackup, BackupDriveError, type BackupDriveStore,
  type BackupManifest, isBackupName,
} from "./backupDrive";
import { importBackupKey, BackupCryptoError } from "./backupCrypto";
import { ApiError } from "../session";
import { DriveAuthError } from "./driveAuth";
import type { BackupKeyMaterial } from "./backupKey";
import { DriveRestStore, DriveStoreError } from "./driveStore";
import type { DriveAccess, DriveAuthUnavailable } from "./driveAuth";
import { isUuid } from "./validation";

export const BACKUP_STATE_KEY = "norfold.drive.backup.v1";
export function backupStateKey(accountId: string): string {
  if (!isUuid(accountId)) throw new Error("Backup account is not ready");
  return `norfold.drive.backup.v2:${accountId}`;
}
/** Batch changed history every 5–15 minutes; never one upload per message. */
export const BACKUP_MIN_DELAY_MS = 5 * 60_000;
export const BACKUP_MAX_DELAY_MS = 15 * 60_000;
/** Compaction/snapshot refresh even when nothing changed. */
export const BACKUP_COMPACT_MS = 24 * 60 * 60_000;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_CAP_MS = 30 * 60_000;
/** "Meaningful chat data worth protecting" before the one optional prompt. */
export const BACKUP_PROMPT_MESSAGES = 20;

export interface BackupState {
  version: 2;
  accountId: string | null;
  enabled: boolean;
  prompted: boolean;
  dirtyRevision: number;
  uploadedRevision: number;
  lastUploadAt: number | null;
  nextAttemptAt: number | null;
  failures: number;
  generation: string | null;
  lastError: "auth" | "account" | "throttled" | "offline" | "integrity" | "snapshot" | "storage" | "other" | null;
}

export const EMPTY_BACKUP_STATE: BackupState = Object.freeze({
  version: 2, accountId: null, enabled: false, prompted: false,
  dirtyRevision: 0, uploadedRevision: 0, lastUploadAt: null,
  nextAttemptAt: null, failures: 0, generation: null, lastError: null,
});

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function parseBackupState(raw: unknown): BackupState {
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw) as unknown; } catch { return { ...EMPTY_BACKUP_STATE }; }
  }
  const value = object(raw);
  // The installation-global v1 policy has no proven account owner. Never
  // migrate its opt-in or green status onto whoever happens to sign in next.
  if (!value || value.version !== 2 || !isUuid(value.accountId)) return { ...EMPTY_BACKUP_STATE };
  const bool = (key: keyof BackupState) => value[key] === true;
  const time = (key: keyof BackupState) => {
    const entry = value[key];
    return typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0 ? entry : null;
  };
  const failures = typeof value.failures === "number" && Number.isSafeInteger(value.failures)
    && value.failures >= 0 && value.failures <= 64 ? value.failures : 0;
  const error = value.lastError;
  const dirtyRevision = time("dirtyRevision") ?? 0;
  const uploadedRevision = Math.min(time("uploadedRevision") ?? 0, dirtyRevision);
  return {
    version: 2, accountId: value.accountId as string,
    enabled: bool("enabled"), prompted: bool("prompted"), dirtyRevision, uploadedRevision,
    lastUploadAt: time("lastUploadAt"), nextAttemptAt: time("nextAttemptAt"),
    failures,
    generation: typeof value.generation === "string" ? value.generation : null,
    lastError: error === "auth" || error === "account" || error === "throttled" || error === "offline"
      || error === "other" || error === "integrity" || error === "snapshot" || error === "storage"
      ? error : null,
  };
}

/** Healthy batching interval, jittered inside the packet's 5–15 minute band. */
export function healthyDelayMs(random: () => number = Math.random): number {
  return BACKUP_MIN_DELAY_MS + Math.floor(random() * (BACKUP_MAX_DELAY_MS - BACKUP_MIN_DELAY_MS));
}

/** Exponential backoff, never shorter than the provider's own retry delay. */
export function backoffDelayMs(failures: number, retryAfterMs = 0, random: () => number = Math.random): number {
  const exponent = Math.min(Math.max(failures, 1) - 1, 8);
  const base = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** exponent);
  return Math.max(retryAfterMs, base + Math.floor(random() * 0.25 * base));
}

type BackupReadiness =
  | { kind: "off" }
  | { kind: "unavailable"; reason: DriveAuthUnavailable }
  | { kind: "needs-connection" }
  | { kind: "running"; operation: "connect" | "upload" | "restore" }
  | { kind: "stopping" }
  | { kind: "waiting"; nextAttemptAt: number }
  | { kind: "up-to-date"; lastUploadAt: number }
  | { kind: "attention"; lastError: NonNullable<BackupState["lastError"]> };
export type BackupStatus = BackupReadiness & {
  lastUploadAt?: number;
  /** The durable opt-in. The surface must never infer this from an error kind. */
  enabled: boolean;
  /** Opt-out failed to persist; uploads stay vetoed for this process/account. */
  optOutPending?: true;
};

export interface BackupAuthPort {
  generation(): number;
  available(): boolean;
  unavailableReason(): DriveAuthUnavailable | null;
  current(): DriveAccess | null;
  authorize(signal?: AbortSignal): Promise<DriveAccess>;
  renew(signal?: AbortSignal): Promise<DriveAccess | null>;
  forget(): void;
}

export type BackupLease = Readonly<{
  accountId: string;
  sessionGeneration: number;
  deviceId: string;
  driveGeneration: number;
  operationGeneration: number;
}>;

export type BackupOperationResult =
  | { kind: "committed"; lastUploadAt: number; snapshotRevision: number }
  | { kind: "restored"; messages: number; manifest: BackupManifest }
  | { kind: "skipped"; reason: "off" | "not-ready" | "superseded" }
  | { kind: "needs-connection" }
  | { kind: "failed"; reason: "offline" | "throttled" | "integrity" | "snapshot" | "storage" | "account" | "other" };

export interface BackupDeps {
  auth: BackupAuthPort;
  captureLease(): BackupLease | null;
  isCurrent(lease: BackupLease): boolean;
  key(lease: BackupLease): Promise<BackupKeyMaterial>;
  snapshot(lease: BackupLease): Promise<HistorySnapshot>;
  importSnapshot(lease: BackupLease, snapshot: HistorySnapshot): Promise<void>;
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
  now?: () => number;
  random?: () => number;
  /** Store factory; production uses Drive REST over the live token. */
  store?(auth: BackupAuthPort, signal: AbortSignal): BackupDriveStore;
}

export interface BackupUploadOutcome {
  uploaded: number;
  reused: number;
  removed: number;
}

function productionStore(auth: BackupAuthPort, signal: AbortSignal): BackupDriveStore {
  return new DriveRestStore({
    async token(force) {
      const access = (force ? await auth.renew() : auth.current() ?? await auth.renew());
      if (!access) throw new DriveStoreError("unauthorized");
      return access.token;
    },
  }, { signal });
}

type Operation = {
  kind: "connect" | "upload" | "restore";
  lease: BackupLease;
  controller: AbortController;
  promise: Promise<BackupOperationResult>;
};
class SupersededBackup extends Error {}
class BackupPolicyUnavailable extends Error {}

export class DriveBackup {
  private readonly states = new Map<string, BackupState>();
  private readonly uploadVeto = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private operation: Operation | null = null;
  private operationGeneration = 0;
  private disposed = false;
  private recoveredLease: string | null = null;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly storage: Pick<Storage, "getItem" | "setItem"> | null;
  private readonly store: (auth: BackupAuthPort, signal: AbortSignal) => BackupDriveStore;

  constructor(private readonly deps: BackupDeps) {
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
    this.storage = deps.storage === undefined
      ? (typeof localStorage === "undefined" ? null : localStorage) : deps.storage;
    this.store = deps.store ?? productionStore;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private publish(): void {
    for (const listener of this.listeners) listener();
  }

  /** Runtime lifetime changes revoke transport immediately, then settle it. */
  reconcile(): void {
    if (this.operation && !this.current(this.operation)) this.operation.controller.abort();
    this.publish();
  }

  private capture(): BackupLease | null {
    if (this.disposed) return null;
    const lease = this.deps.captureLease();
    return lease && isUuid(lease.accountId) && isUuid(lease.deviceId)
      ? Object.freeze({ ...lease, operationGeneration: this.operationGeneration }) : null;
  }

  private current(op: Operation): boolean {
    return !this.disposed && !op.controller.signal.aborted
      && op.lease.operationGeneration === this.operationGeneration
      && op.lease.driveGeneration === this.deps.auth.generation()
      && this.deps.isCurrent(op.lease);
  }

  private assertCurrent(op: Operation): void {
    if (!this.current(op)) {
      op.controller.abort();
      throw new SupersededBackup();
    }
  }

  private state(accountId: string): BackupState {
    let state = this.states.get(accountId);
    if (!state) {
      try {
        const parsed = parseBackupState(this.storage?.getItem(backupStateKey(accountId)) ?? null);
        state = parsed.accountId === accountId ? parsed : { ...EMPTY_BACKUP_STATE, accountId };
        // A fresh process cannot know which changes happened before a crash.
        // Preserve the historical receipt but conservatively require a pass.
        if (state.enabled) state = { ...state, dirtyRevision: state.dirtyRevision + 1 };
      } catch {
        state = { ...EMPTY_BACKUP_STATE, accountId, lastError: "storage" };
      }
      this.states.set(accountId, state);
    }
    return state;
  }

  /** The persisted policy, safe to render (no tokens, keys or file ids). */
  status(): BackupStatus {
    const readiness = this.readiness();
    const lease = this.capture();
    const state = lease ? this.state(lease.accountId) : null;
    return { ...readiness, enabled: state?.enabled ?? false,
      ...(lease && this.uploadVeto.has(lease.accountId) ? { optOutPending: true as const } : {}),
      ...(state?.lastUploadAt == null ? {} : { lastUploadAt: state.lastUploadAt }) };
  }

  private readiness(): BackupReadiness {
    if (!this.deps.auth.available()) {
      return { kind: "unavailable", reason: this.deps.auth.unavailableReason() ?? "unconfigured" };
    }
    const lease = this.capture();
    if (!lease) return { kind: "off" };
    if (this.operation) return this.current(this.operation)
      ? { kind: "running", operation: this.operation.kind } : { kind: "stopping" };
    const state = this.state(lease.accountId);
    // A disabled policy is off regardless of any stale warning: a storage error
    // must never make a switch look enabled, nor resurrect the opt-in.
    if (!state.enabled) return { kind: "off" };
    if (this.uploadVeto.has(lease.accountId)) return { kind: "attention", lastError: "storage" };
    if (state.lastError === "storage") return { kind: "attention", lastError: "storage" };
    // Expiry is not revoked consent. The scheduled pass first asks the native
    // grant owner to renew; only a failed renewal earns a reconnect action.
    if (state.lastError === "auth") return { kind: "needs-connection" };
    if (state.lastError) return { kind: "attention", lastError: state.lastError };
    if (!this.deps.auth.current()) return { kind: "waiting", nextAttemptAt: state.nextAttemptAt ?? this.now() };
    if (state.lastUploadAt !== null && state.dirtyRevision === state.uploadedRevision) {
      return { kind: "up-to-date", lastUploadAt: state.lastUploadAt };
    }
    return state.nextAttemptAt !== null && state.nextAttemptAt > this.now()
      ? { kind: "waiting", nextAttemptAt: state.nextAttemptAt }
      : { kind: "waiting", nextAttemptAt: this.now() };
  }

  /** Show the one optional prompt only for a real, meaningful history. */
  promptDecision(messageCount: number): "show" | null {
    const lease = this.capture();
    if (!lease) return null;
    const state = this.state(lease.accountId);
    if (state.prompted || state.enabled || state.lastError === "storage") return null;
    if (!this.deps.auth.available()) return null;
    return messageCount >= BACKUP_PROMPT_MESSAGES ? "show" : null;
  }

  dismissPrompt(): void {
    const lease = this.capture();
    if (lease) this.persist(lease.accountId, { prompted: true });
  }

  /** Opt in: ask Google once, then run a full first pass. */
  connect(): Promise<BackupOperationResult> {
    return this.admit("connect");
  }

  disable(): boolean {
    // Keep the authorization: the user may turn backup back on without another
    // consent, and nothing is uploaded while disabled.
    const lease = this.capture();
    if (lease) this.uploadVeto.add(lease.accountId);
    this.revoke();
    if (!lease) return false;
    const saved = this.persist(lease.accountId, { enabled: false, nextAttemptAt: null, lastError: null, failures: 0 });
    if (saved) { this.uploadVeto.delete(lease.accountId); this.publish(); }
    return saved;
  }

  forget(): void {
    this.disable();
    this.deps.auth.forget();
  }

  /** Canonical sign-out/account-runtime disposal. Keep committed policy/history. */
  dispose(): void {
    this.revoke();
    this.disposed = true;
    this.publish();
  }

  /** End this runtime lease, but retain admission until dispatched work settles. */
  cancel(): void { this.revoke(); }

  private revoke(): void {
    this.operationGeneration++;
    this.operation?.controller.abort();
    this.publish();
  }

  /** Mark history changed; a later tick uploads it in one batch. */
  markDirty(): void {
    const lease = this.capture();
    if (!lease) return;
    const state = this.state(lease.accountId);
    if (!state.enabled) return;
    this.persist(lease.accountId, { dirtyRevision: state.dirtyRevision + 1 });
  }

  /** A scheduled pass. Never throws: the scheduler persists the next attempt. */
  tick(): Promise<BackupOperationResult> {
    const lease = this.capture();
    if (!lease) return Promise.resolve({ kind: "skipped", reason: "not-ready" });
    const state = this.state(lease.accountId);
    if (!state.enabled || this.uploadVeto.has(lease.accountId)) return Promise.resolve({ kind: "skipped", reason: "off" });
    if (state.nextAttemptAt !== null && state.nextAttemptAt > this.now()) {
      return Promise.resolve({ kind: "skipped", reason: "not-ready" });
    }
    const due = state.dirtyRevision > state.uploadedRevision || state.lastUploadAt === null
      || this.now() - state.lastUploadAt >= BACKUP_COMPACT_MS;
    if (!due && state.lastError === null) return Promise.resolve({ kind: "skipped", reason: "not-ready" });
    return this.admit("upload");
  }

  /** Upload now because the user asked, ignoring the batching delay. */
  uploadNow(): Promise<BackupOperationResult> {
    return this.admit("upload");
  }

  restore(): Promise<BackupOperationResult> {
    return this.admit("restore");
  }

  private admit(kind: Operation["kind"]): Promise<BackupOperationResult> {
    if (this.operation) {
      // Only equivalent current upload requests can join the admitted pass.
      return kind === "upload" && this.operation.kind !== "restore" && this.current(this.operation)
        ? this.operation.promise : Promise.resolve({ kind: "skipped", reason: "not-ready" });
    }
    const lease = this.capture();
    if (!lease) return Promise.resolve({ kind: "skipped", reason: "not-ready" });
    if (kind === "upload" && (!this.state(lease.accountId).enabled || this.uploadVeto.has(lease.accountId))) {
      return Promise.resolve({ kind: "skipped", reason: "off" });
    }
    const op: Operation = { kind, lease, controller: new AbortController(), promise: Promise.resolve({ kind: "skipped", reason: "not-ready" }) };
    this.operation = op;
    op.promise = Promise.resolve().then(() => this.execute(op)).finally(() => {
      if (this.operation === op) this.operation = null;
      this.publish();
    });
    this.publish();
    return op.promise;
  }

  private async execute(op: Operation): Promise<BackupOperationResult> {
    try {
      this.assertCurrent(op);
      if (op.kind === "connect") {
        const consent = this.deps.auth.current() ? Promise.resolve()
          : this.deps.auth.authorize(op.controller.signal);
        // Explicit consent may select a different Drive connection. Adopt only
        // the synchronous generation of this admitted request, never a late
        // generation after disconnect/another connection has revoked it.
        op.lease = Object.freeze({ ...op.lease, driveGeneration: this.deps.auth.generation() });
        await consent;
        this.assertCurrent(op);
        const state = this.state(op.lease.accountId);
        if (!this.persist(op.lease.accountId, { enabled: true, prompted: true,
          dirtyRevision: state.dirtyRevision + 1, failures: 0, lastError: null, nextAttemptAt: null })) {
          throw new BackupPolicyUnavailable();
        }
        this.uploadVeto.delete(op.lease.accountId);
      }
      const access = this.deps.auth.current() ?? await this.deps.auth.renew(op.controller.signal);
      this.assertCurrent(op);
      if (!access) throw new DriveStoreError("unauthorized");
      // Do not reach Drive with a dirty revision which cannot be persisted.
      // A successful retry can clear the storage warning, never the revisions.
      if (!this.persist(op.lease.accountId, { lastError: null })) throw new BackupPolicyUnavailable();
      const material = await this.deps.key(op.lease);
      this.assertCurrent(op);
      if (material.accountId !== op.lease.accountId) throw new BackupDriveError("backup: account mismatch");
      // A different key generation cannot open this account's committed objects.
      // Rebuilding automatically would overwrite or abandon a recoverable backup,
      // so this stays a visible repair-needed state until rotation is authorized.
      const knownGeneration = this.state(op.lease.accountId).generation;
      if (knownGeneration !== null && knownGeneration !== material.generation) {
        throw new BackupDriveError("backup: key generation changed");
      }
      const key = await importBackupKey(material.generation, material.keyHex);
      this.assertCurrent(op);
      const store = this.fencedStore(op);
      if (op.kind === "restore") {
        const restored = await downloadBackup({ store, key, scope: op.lease });
        this.assertCurrent(op);
        await this.deps.importSnapshot(op.lease, restored.snapshot);
        this.assertCurrent(op);
        const state = this.state(op.lease.accountId);
        if (!this.persist(op.lease.accountId, { dirtyRevision: state.dirtyRevision + 1,
          generation: material.generation })) throw new BackupPolicyUnavailable();
        return { kind: "restored", manifest: restored.manifest, messages: restored.snapshot.messages.length };
      }
      const recoveryLease = JSON.stringify([op.lease.accountId, op.lease.deviceId,
        op.lease.sessionGeneration, op.lease.driveGeneration]);
      // First pass after opening/reconnecting restores the union BEFORE upload.
      // Mailbox ACK removes temporary server bodies; Drive may now be the only
      // recoverable copy. Never replace it with a smaller fresh-install snapshot.
      if (op.kind === "connect" || this.recoveredLease !== recoveryLease) {
        const files = await store.list();
        this.assertCurrent(op);
        if (files.some(file => isBackupName(file.name, op.lease.accountId) && file.name.includes(".manifest."))) {
          const restored = await downloadBackup({ store, key, scope: op.lease });
          this.assertCurrent(op);
          await this.deps.importSnapshot(op.lease, restored.snapshot);
          this.assertCurrent(op);
        }
      }
      const snapshotRevision = this.state(op.lease.accountId).dirtyRevision;
      const snapshot = await this.deps.snapshot(op.lease);
      this.assertCurrent(op);
      await uploadBackup({ store, key, scope: op.lease, snapshot, now: this.now() });
      this.assertCurrent(op);
      const next = this.now() + healthyDelayMs(this.random);
      if (!this.persist(op.lease.accountId, { uploadedRevision: snapshotRevision,
        lastUploadAt: this.now(), nextAttemptAt: next,
        failures: 0, lastError: null, generation: material.generation })) throw new BackupPolicyUnavailable();
      this.recoveredLease = recoveryLease;
      return { kind: "committed", lastUploadAt: this.now(), snapshotRevision };
    } catch (error) {
      if (!this.current(op) || error instanceof SupersededBackup) return { kind: "skipped", reason: "superseded" };
      return this.recordFailure(op.lease.accountId, error);
    }
  }

  private fencedStore(op: Operation): BackupDriveStore {
    const auth: BackupAuthPort = { ...this.deps.auth,
      current: () => { this.assertCurrent(op); return this.deps.auth.current(); },
      renew: async () => {
        this.assertCurrent(op);
        const access = await this.deps.auth.renew(op.controller.signal);
        this.assertCurrent(op);
        return access;
      },
    };
    const store = this.store(auth, op.controller.signal);
    return {
      list: async () => { this.assertCurrent(op); const result = await store.list(); this.assertCurrent(op); return result; },
      read: async id => { this.assertCurrent(op); const result = await store.read(id); this.assertCurrent(op); return result; },
      write: async file => { this.assertCurrent(op); const result = await store.write(file); this.assertCurrent(op); return result; },
      remove: async id => { this.assertCurrent(op); await store.remove(id); this.assertCurrent(op); },
    };
  }

  private recordFailure(accountId: string, error: unknown): BackupOperationResult {
    const failures = Math.min(this.state(accountId).failures + 1, 64);
    let lastError: NonNullable<BackupState["lastError"]> = "other", retryAfter = 0;
    if (error instanceof DriveStoreError) {
      retryAfter = error.kind === "throttled" ? error.retryAfterMs : 0;
      lastError = error.kind === "throttled" ? "throttled"
        : error.kind === "unauthorized" ? "auth" : "offline";
    } else if (error instanceof BackupCryptoError) {
      lastError = "integrity";
    } else if (error instanceof BackupDriveError) {
      // An unreadable local history is not a broken backup: name it separately
      // so the surface can say the existing backup was left untouched.
      lastError = error.code === "backup: empty snapshot" || error.code === "backup: incomplete snapshot" ? "snapshot" : "integrity";
    } else if (error instanceof BackupPolicyUnavailable) {
      lastError = "storage";
    } else if (error instanceof DriveAuthError) {
      // A refused or unavailable Google consent cannot be fixed by retrying the
      // pass; the user has to reconnect (or this build cannot consent at all).
      lastError = "auth";
    } else if (error instanceof ApiError) {
      // The backup key is admission-gated. A removed/rebound installation or a
      // signed-out session needs Norfold sign-in, not another connection retry.
      lastError = error.status === 401 || error.status === 403 ? "account" : "other";
    }
    if (!this.persist(accountId, { failures, lastError,
      nextAttemptAt: this.now() + backoffDelayMs(failures, retryAfter, this.random) })) lastError = "storage";
    return lastError === "auth" ? { kind: "needs-connection" } : { kind: "failed", reason: lastError };
  }

  private persist(accountId: string, patch: Partial<BackupState>): boolean {
    const previous = this.state(accountId), next = { ...previous, ...patch };
    try {
      if (!this.storage) throw new BackupPolicyUnavailable();
      {
        const raw = JSON.stringify(next), key = backupStateKey(accountId);
        this.storage.setItem(key, raw);
        if (this.storage.getItem(key) !== raw) throw new BackupPolicyUnavailable();
      }
      this.states.set(accountId, next);
      this.publish();
      return true;
    } catch {
      // Keep uncertain changes retryable; neither an opt-in, a disable nor a
      // clean receipt is accepted after a denied/quota/ignored policy write.
      this.states.set(accountId, { ...previous,
        dirtyRevision: Math.max(previous.dirtyRevision, next.dirtyRevision), lastError: "storage" });
      this.publish();
      return false;
    }
  }
}
