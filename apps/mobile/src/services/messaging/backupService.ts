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
  type BackupManifest,
} from "./backupDrive";
import { importBackupKey, BackupCryptoError } from "./backupCrypto";
import type { BackupKeyMaterial } from "./backupKey";
import { DriveRestStore, DriveStoreError } from "./driveStore";
import type { DriveAccess, DriveAuthUnavailable } from "./driveAuth";

export const BACKUP_STATE_KEY = "norfold.drive.backup.v1";
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
  enabled: boolean;
  prompted: boolean;
  dirty: boolean;
  lastUploadAt: number | null;
  nextAttemptAt: number | null;
  failures: number;
  generation: string | null;
  repair: boolean;
  lastError: "auth" | "throttled" | "offline" | "other" | null;
}

export const EMPTY_BACKUP_STATE: BackupState = Object.freeze({
  enabled: false, prompted: false, dirty: false, lastUploadAt: null,
  nextAttemptAt: null, failures: 0, generation: null, repair: false, lastError: null,
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
  if (!value) return { ...EMPTY_BACKUP_STATE };
  const bool = (key: keyof BackupState) => value[key] === true;
  const time = (key: keyof BackupState) => {
    const entry = value[key];
    return typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0 ? entry : null;
  };
  const failures = typeof value.failures === "number" && Number.isSafeInteger(value.failures)
    && value.failures >= 0 && value.failures <= 64 ? value.failures : 0;
  const error = value.lastError;
  return {
    enabled: bool("enabled"), prompted: bool("prompted"), dirty: bool("dirty"),
    lastUploadAt: time("lastUploadAt"), nextAttemptAt: time("nextAttemptAt"),
    failures,
    generation: typeof value.generation === "string" ? value.generation : null,
    repair: bool("repair"),
    lastError: error === "auth" || error === "throttled" || error === "offline" || error === "other"
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

export type BackupStatus =
  | { kind: "off" }
  | { kind: "unavailable"; reason: DriveAuthUnavailable }
  | { kind: "needs-connection" }
  | { kind: "waiting"; nextAttemptAt: number }
  | { kind: "up-to-date"; lastUploadAt: number }
  | { kind: "attention"; lastError: NonNullable<BackupState["lastError"]> };

export interface BackupAuthPort {
  available(): boolean;
  unavailableReason(): DriveAuthUnavailable | null;
  current(): DriveAccess | null;
  authorize(): Promise<DriveAccess>;
  renew(): Promise<DriveAccess | null>;
  forget(): void;
}

export interface BackupDeps {
  auth: BackupAuthPort;
  key(): Promise<BackupKeyMaterial>;
  snapshot(): Promise<HistorySnapshot>;
  importSnapshot(snapshot: HistorySnapshot): Promise<void>;
  accountId(): string | null;
  deviceId(): string;
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
  now?: () => number;
  random?: () => number;
  /** Store factory; production uses Drive REST over the live token. */
  store?(auth: BackupAuthPort): BackupDriveStore;
}

export interface BackupUploadOutcome {
  uploaded: number;
  reused: number;
  removed: number;
}

function productionStore(auth: BackupAuthPort): BackupDriveStore {
  return new DriveRestStore({
    async token(force) {
      const access = (force ? await auth.renew() : auth.current() ?? await auth.renew());
      if (!access) throw new DriveStoreError("unauthorized");
      return access.token;
    },
  });
}

export class DriveBackup {
  private state: BackupState;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly storage: Pick<Storage, "getItem" | "setItem"> | null;
  private readonly store: (auth: BackupAuthPort) => BackupDriveStore;

  constructor(private readonly deps: BackupDeps) {
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
    this.storage = deps.storage === undefined
      ? (typeof localStorage === "undefined" ? null : localStorage) : deps.storage;
    this.store = deps.store ?? productionStore;
    this.state = parseBackupState(this.storage?.getItem(BACKUP_STATE_KEY) ?? null);
  }

  /** The persisted policy, safe to render (no tokens, keys or file ids). */
  status(): BackupStatus {
    if (!this.deps.auth.available()) {
      return { kind: "unavailable", reason: this.deps.auth.unavailableReason() ?? "unconfigured" };
    }
    if (!this.state.enabled) return { kind: "off" };
    if (this.state.lastError === "auth") return { kind: "attention", lastError: "auth" };
    if (this.state.lastError) return { kind: "attention", lastError: this.state.lastError };
    if (this.state.lastUploadAt !== null && !this.state.dirty) {
      return { kind: "up-to-date", lastUploadAt: this.state.lastUploadAt };
    }
    if (!this.deps.auth.current()) return { kind: "needs-connection" };
    return this.state.nextAttemptAt !== null && this.state.nextAttemptAt > this.now()
      ? { kind: "waiting", nextAttemptAt: this.state.nextAttemptAt }
      : { kind: "waiting", nextAttemptAt: this.now() };
  }

  /** Show the one optional prompt only for a real, meaningful history. */
  promptDecision(messageCount: number): "show" | null {
    if (this.state.prompted || this.state.enabled) return null;
    if (!this.deps.auth.available()) return null;
    return messageCount >= BACKUP_PROMPT_MESSAGES ? "show" : null;
  }

  dismissPrompt(): void {
    this.persist({ prompted: true });
  }

  /** Opt in: ask Google once, then run a full first pass. */
  async connect(): Promise<BackupStatus> {
    await this.deps.auth.authorize();
    this.persist({ enabled: true, prompted: true, dirty: true, failures: 0,
      lastError: null, nextAttemptAt: null });
    return this.uploadNow();
  }

  disable(): void {
    // Keep the authorization: the user may turn backup back on without another
    // consent, and nothing is uploaded while disabled.
    this.persist({ enabled: false, dirty: false, nextAttemptAt: null, lastError: null, failures: 0 });
  }

  forget(): void {
    this.deps.auth.forget();
    this.persist({ enabled: false, dirty: false, nextAttemptAt: null, lastError: null, failures: 0 });
  }

  /** Mark history changed; a later tick uploads it in one batch. */
  markDirty(): void {
    if (!this.state.enabled) return;
    this.persist({ dirty: true });
  }

  /** A scheduled pass. Never throws: the scheduler persists the next attempt. */
  async tick(): Promise<BackupStatus> {
    if (!this.state.enabled) return this.status();
    if (this.state.nextAttemptAt !== null && this.state.nextAttemptAt > this.now()) return this.status();
    const due = this.state.dirty || this.state.lastUploadAt === null
      || this.now() - this.state.lastUploadAt >= BACKUP_COMPACT_MS;
    if (!due && this.state.lastError === null) return this.status();
    return this.pass();
  }

  /** Upload now because the user asked, ignoring the batching delay. */
  async uploadNow(): Promise<BackupStatus> {
    return this.pass();
  }

  private async pass(): Promise<BackupStatus> {
    if (!this.state.enabled) return this.status();
    const accountId = this.deps.accountId();
    if (!accountId) return this.status();
    const access = this.deps.auth.current() ?? await this.deps.auth.renew();
    if (!access) {
      this.persist({ lastError: "auth", nextAttemptAt: this.now() + backoffDelayMs(1, 0, this.random) });
      return this.status();
    }
    try {
      const material = await this.deps.key();
      const key = await importBackupKey(material.generation, material.keyHex);
      const snapshot = await this.deps.snapshot();
      // A changed generation means every old object fails its AAD: rebuild.
      const repair = this.state.repair || (this.state.generation !== null
        && this.state.generation !== material.generation);
      await uploadBackup({
        store: this.store(this.deps.auth), key,
        scope: { accountId, deviceId: this.deps.deviceId() },
        snapshot, now: this.now(), repair,
      });
      const next = this.now() + healthyDelayMs(this.random);
      this.persist({ dirty: false, lastUploadAt: this.now(), nextAttemptAt: next,
        failures: 0, lastError: null, generation: material.generation, repair: false });
      return { kind: "up-to-date", lastUploadAt: this.now() };
    } catch (error) {
      this.recordFailure(error);
      return this.status();
    }
  }

  /** Restore into local history. The caller re-syncs heads afterwards. */
  async restore(): Promise<{ manifest: BackupManifest; messages: number }> {
    const accountId = this.deps.accountId();
    if (!accountId) throw new DriveStoreError("unauthorized");
    const access = this.deps.auth.current() ?? await this.deps.auth.renew();
    if (!access) throw new DriveStoreError("unauthorized");
    const material = await this.deps.key();
    const key = await importBackupKey(material.generation, material.keyHex);
    const restored = await downloadBackup({
      store: this.store(this.deps.auth), key,
      scope: { accountId, deviceId: this.deps.deviceId() },
    });
    await this.deps.importSnapshot(restored.snapshot);
    // The merged local state should be protected on the next pass.
    this.persist({ dirty: this.state.enabled, repair: false, generation: material.generation });
    return { manifest: restored.manifest, messages: restored.snapshot.messages.length };
  }

  private recordFailure(error: unknown): void {
    const failures = this.state.failures + 1;
    if (error instanceof DriveStoreError) {
      const retryAfter = error.kind === "throttled" ? error.retryAfterMs : 0;
      const lastError = error.kind === "throttled" ? "throttled"
        : error.kind === "unauthorized" ? "auth" : "offline";
      if (error.kind === "unauthorized") this.deps.auth.forget();
      this.persist({ failures, lastError,
        nextAttemptAt: this.now() + backoffDelayMs(failures, retryAfter, this.random) });
      return;
    }
    if (error instanceof BackupCryptoError && error.code === "backup: decryption failed") {
      // The manifest cannot be opened with this key; rebuilding is the only
      // honest recovery, and the old objects are unreadable anyway.
      this.persist({ failures, lastError: "other", repair: true,
        nextAttemptAt: this.now() + backoffDelayMs(failures, 0, this.random) });
      return;
    }
    if (error instanceof BackupDriveError) {
      this.persist({ failures, lastError: "other",
        nextAttemptAt: this.now() + backoffDelayMs(failures, 0, this.random) });
      return;
    }
    this.persist({ failures, lastError: "other",
      nextAttemptAt: this.now() + backoffDelayMs(failures, 0, this.random) });
  }

  private persist(patch: Partial<BackupState>): void {
    this.state = { ...this.state, ...patch };
    try {
      this.storage?.setItem(BACKUP_STATE_KEY, JSON.stringify(this.state));
    } catch {
      // A full or blocked store must not break the caller; the in-memory state
      // still prevents a storm of repeated passes in this session.
    }
  }
}
