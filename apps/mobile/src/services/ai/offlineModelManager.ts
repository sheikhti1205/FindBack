/**
 * Offline model manager (AI-023): download-lifecycle types + state machine.
 *
 * Pure TypeScript ownership of *which* on-device model is in *what* state.
 * There is deliberately NO network code here: no fetch, no endpoint strings,
 * no range requests, no ZIP framing. Chunk transport, SHA-256 computation,
 * and file storage arrive later through the injected `ChecksumVerifier` /
 * `StorageProbe` seams (and a follow-up transport worker); this module only
 * decides gating and records transitions.
 *
 * Archive lineage (tag `local-ai-final-2026-09-25`, study only):
 * - `services/models/modelTransfers.ts` -> the gate/verify/commit shape:
 *   explicit user gating, resume-by-offset (`downloadedBytes`), incremental
 *   hash verification against a catalogue pin, partial bytes staged for
 *   resume and never reported as installed.
 * - `services/models/shippedCatalogue.ts` -> fail closed while unpublished:
 *   an asset without a SHA-256 pin or distribution record never downloads.
 * - `android/.../vlm/VlmTypes.kt` (`VlmState`) -> the state vocabulary, here
 *   collapsed to the stable subset (see DISCARDED below).
 * - `android/.../vlm/GenerativeResidencyArbiter.kt` -> single-resident
 *   invariant: residency is runtime-only state, recorded separately from
 *   install state, and never persisted across process death.
 * - `services/models/qwenLifecycle.ts` -> `installed` means
 *   transfer-verified + checksum-pinned, never mere file presence (mirrored
 *   by `checksumVerified`).
 *
 * DELIBERATELY DISCARDED from the archive:
 * - The ~20-state `VlmState` machine (WAITING_FOR_NETWORK/WIFI,
 *   VERIFYING_CHUNK/FILE, REPAIR_NEEDED/REPAIRING, GPU_SELF_TESTING,
 *   READY_GPU/GPU_UNAVAILABLE, ...): network-gated and GPU-probe states
 *   belong to a native runtime worker with real hardware, not to this
 *   transport-agnostic ledger.
 * - ZIP/`.fbmodel` import/export framing and per-file manifests
 *   (`modelTransfers.ts` import/export paths): a later packet if ever.
 * - Multi-entry catalogue wiring and HF/release URL pins: assets are
 *   injected data (`OfflineAssetPin`), so this module cannot leak origins.
 * - Silent/auto-download and WiFi-gated auto-resume: downloads start only
 *   on an explicit `userInitiated` event (see `QUEUE_DOWNLOAD`).
 */

import { verifyChecksumMatch } from "./download/installer";
import {
  buildModelPaths,
  preflightCheck,
  type PreflightResult,
} from "./download/storage";
import {
  journalResumeOffset,
  type DownloadJournal,
} from "./download/transport";

/** Schema version for `OfflineManagerSnapshot`. Bump on shape change. */
export const OFFLINE_MANAGER_SNAPSHOT_VERSION = 1 as const;

/** Stable download lifecycle. No network-wait states: offline is the norm. */
export type OfflineDownloadState =
  | "not-installed"
  | "queued"
  | "downloading"
  | "paused"
  | "verifying"
  | "installed"
  | "failed";

/** Runtime-only residency. Never persisted as resident (see `snapshot`). */
export type OfflineResidencyState =
  | "unloaded"
  | "loading"
  | "resident"
  | "unloading";

/** Static, injectable asset facts. Pins come from lab records, not network. */
export interface OfflineAssetPin {
  readonly modelId: string;
  /** Expected SHA-256 hex of the installed weights. Empty means unpinned. */
  readonly sha256: string;
  /** Exact download size in bytes (resume math + storage gate). */
  readonly downloadBytes: number;
  /** Advisory minimum free RAM in MiB for a load attempt. */
  readonly minFreeRamMb: number;
}

export interface OfflineModelStatus {
  readonly modelId: string;
  readonly download: OfflineDownloadState;
  readonly residency: OfflineResidencyState;
  /** Bytes staged so far; the resume offset for a future transport. */
  readonly downloadedBytes: number;
  /** True only after VERIFY_OK matched the pin. Never file presence. */
  readonly checksumVerified: boolean;
  readonly lastError?: string;
  readonly updatedAt: string;
}

export type OfflineModelEvent =
  | { readonly type: "QUEUE_DOWNLOAD"; readonly userInitiated: boolean }
  | { readonly type: "START" }
  | { readonly type: "PROGRESS"; readonly downloadedBytes: number }
  | { readonly type: "PAUSE" }
  | { readonly type: "RESUME" }
  | { readonly type: "CANCEL" }
  | { readonly type: "VERIFY_START" }
  | { readonly type: "VERIFY_OK"; readonly actualSha256: string }
  | { readonly type: "VERIFY_FAIL"; readonly reason: string }
  | { readonly type: "FAIL"; readonly reason: string }
  | { readonly type: "DELETE" }
  | { readonly type: "LOAD" }
  | { readonly type: "LOADED" }
  | { readonly type: "UNLOAD" }
  | { readonly type: "UNLOADED" };

export class OfflineTransitionError extends Error {
  readonly code = "illegal_transition" as const;
}

/** Async SHA-256 seam. Implemented by platform code; never by this module. */
export interface ChecksumVerifier {
  verifySha256(
    modelId: string,
    expectedHex: string,
    signal?: AbortSignal,
  ): Promise<{ readonly match: boolean; readonly actualHex: string }>;
}

/** Async free-space seam. Implemented by platform code. */
export interface StorageProbe {
  freeBytes(): Promise<number>;
}

export type DownloadGateResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code:
        | "UNKNOWN_MODEL"
        | "NOT_USER_INITIATED"
        | "MISSING_PIN"
        | "INSUFFICIENT_STORAGE"
        | "ALREADY_INSTALLED";
      readonly reason: string;
    };

export interface OfflineManagerOptions {
  readonly checksumVerifier?: ChecksumVerifier;
  readonly storageProbe?: StorageProbe;
  /** Keep at least this many free bytes after install (default 0). */
  readonly storageHeadroomBytes?: number;
  readonly now?: () => string;
}

export interface OfflineManagerSnapshot {
  readonly version: typeof OFFLINE_MANAGER_SNAPSHOT_VERSION;
  readonly models: Readonly<Record<string, PersistedModelState>>;
}

export interface PersistedModelState {
  readonly download: OfflineDownloadState;
  readonly downloadedBytes: number;
  readonly checksumVerified: boolean;
  readonly lastError?: string;
  readonly updatedAt: string;
}

function isHex64(value: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(value);
}

export function createInitialStatus(asset: OfflineAssetPin): OfflineModelStatus {
  return {
    modelId: asset.modelId,
    download: "not-installed",
    residency: "unloaded",
    downloadedBytes: 0,
    checksumVerified: false,
    updatedAt: new Date().toISOString(),
  };
}

function stamp(
  status: OfflineModelStatus,
  patch: Partial<OfflineModelStatus>,
): OfflineModelStatus {
  return {
    ...status,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
}

function fail(message: string): never {
  throw new OfflineTransitionError(message);
}

/**
 * Pure download/residency transition. Throws `OfflineTransitionError` on any
 * illegal move (fail closed: the caller keeps the previous status).
 *
 * Rules carried over from the archive transfer model:
 * - `QUEUE_DOWNLOAD` requires `userInitiated: true` (no silent downloads).
 * - `VERIFY_OK` requires an exact pin match (case-insensitive hex).
 * - `LOAD` requires `installed` + verified checksum.
 * - `CANCEL` keeps staged bytes (resumable pause); only `DELETE` discards.
 * - Install state never implies residency and vice versa.
 */
export function transitionOfflineModel(
  status: OfflineModelStatus,
  event: OfflineModelEvent,
): OfflineModelStatus {
  switch (event.type) {
    case "QUEUE_DOWNLOAD": {
      if (event.userInitiated !== true) {
        fail("refusing download that is not user-initiated");
      }
      if (status.download !== "not-installed" && status.download !== "failed") {
        fail(`cannot queue download from ${status.download}`);
      }
      return stamp(status, {
        download: "queued",
        lastError: undefined,
      });
    }
    case "START": {
      if (status.download !== "queued" && status.download !== "paused") {
        fail(`cannot start download from ${status.download}`);
      }
      return stamp(status, { download: "downloading", lastError: undefined });
    }
    case "PROGRESS": {
      if (status.download !== "downloading") {
        fail(`cannot record progress from ${status.download}`);
      }
      if (
        !Number.isFinite(event.downloadedBytes) ||
        event.downloadedBytes < status.downloadedBytes
      ) {
        fail("download progress must be finite and monotonic");
      }
      return stamp(status, { downloadedBytes: Math.floor(event.downloadedBytes) });
    }
    case "PAUSE": {
      if (status.download !== "downloading" && status.download !== "queued") {
        fail(`cannot pause from ${status.download}`);
      }
      return stamp(status, { download: "paused" });
    }
    case "RESUME": {
      if (status.download !== "paused") {
        fail(`cannot resume from ${status.download}`);
      }
      return stamp(status, { download: "downloading", lastError: undefined });
    }
    case "CANCEL": {
      if (status.download !== "downloading" && status.download !== "queued") {
        fail(`cannot cancel from ${status.download}`);
      }
      // Staged bytes stay for resume; see DELETE for discarding.
      return stamp(status, { download: "paused" });
    }
    case "VERIFY_START": {
      if (status.download !== "downloading" && status.download !== "paused") {
        fail(`cannot verify from ${status.download}`);
      }
      return stamp(status, { download: "verifying" });
    }
    case "VERIFY_OK": {
      if (status.download !== "verifying") {
        fail(`cannot accept verification from ${status.download}`);
      }
      return stamp(status, {
        download: "installed",
        checksumVerified: true,
        lastError: undefined,
      });
    }
    case "VERIFY_FAIL": {
      if (status.download !== "verifying") {
        fail(`cannot fail verification from ${status.download}`);
      }
      const reason =
        event.reason.trim() === "" ? "checksum verification failed" : event.reason;
      return stamp(status, {
        download: "failed",
        checksumVerified: false,
        lastError: reason.slice(0, 400),
      });
    }
    case "FAIL": {
      if (status.download === "installed") {
        fail("cannot fail an installed model; delete it first");
      }
      const reason =
        event.reason.trim() === "" ? "transfer failed" : event.reason;
      return stamp(status, {
        download: "failed",
        lastError: reason.slice(0, 400),
      });
    }
    case "DELETE": {
      return stamp(status, {
        download: "not-installed",
        residency: "unloaded",
        downloadedBytes: 0,
        checksumVerified: false,
        lastError: undefined,
      });
    }
    case "LOAD": {
      if (status.download !== "installed" || status.checksumVerified !== true) {
        fail("cannot load a model that is not installed and verified");
      }
      if (status.residency !== "unloaded") {
        fail(`cannot load from residency ${status.residency}`);
      }
      return stamp(status, { residency: "loading" });
    }
    case "LOADED": {
      if (status.residency !== "loading") {
        fail(`cannot mark loaded from residency ${status.residency}`);
      }
      return stamp(status, { residency: "resident" });
    }
    case "UNLOAD": {
      if (status.residency !== "resident" && status.residency !== "loading") {
        fail(`cannot unload from residency ${status.residency}`);
      }
      return stamp(status, { residency: "unloading" });
    }
    case "UNLOADED": {
      if (status.residency !== "unloading") {
        fail(`cannot mark unloaded from residency ${status.residency}`);
      }
      return stamp(status, { residency: "unloaded" });
    }
  }
}

/**
 * Small owned ledger over the pure transition function: asset registry,
 * storage/user gate, and snapshot persistence for process-death recovery.
 */
export class OfflineModelManager {
  private readonly assets = new Map<string, OfflineAssetPin>();
  private readonly statuses = new Map<string, OfflineModelStatus>();
  private readonly verifier?: ChecksumVerifier;
  private readonly probe?: StorageProbe;
  private readonly headroomBytes: number;

  constructor(assets: readonly OfflineAssetPin[], options?: OfflineManagerOptions) {
    for (const asset of assets) {
      if (this.assets.has(asset.modelId)) {
        throw new OfflineTransitionError(`duplicate asset ${asset.modelId}`);
      }
      this.assets.set(asset.modelId, asset);
      this.statuses.set(asset.modelId, createInitialStatus(asset));
    }
    this.verifier = options?.checksumVerifier;
    this.probe = options?.storageProbe;
    this.headroomBytes = options?.storageHeadroomBytes ?? 0;
  }

  assetIds(): readonly string[] {
    return [...this.assets.keys()];
  }

  /** Catalogue pin for one model, or undefined when unknown. */
  assetPinOf(modelId: string): OfflineAssetPin | undefined {
    return this.assets.get(modelId);
  }

  statusOf(modelId: string): OfflineModelStatus | undefined {
    return this.statuses.get(modelId);
  }

  /** Apply one event to one model's status (throws on illegal moves). */
  dispatch(modelId: string, event: OfflineModelEvent): OfflineModelStatus {
    const current = this.statuses.get(modelId);
    if (current === undefined) {
      throw new OfflineTransitionError(`unknown model ${modelId}`);
    }
    if (event.type === "VERIFY_OK") {
      const asset = this.assets.get(modelId) as OfflineAssetPin;
      const expected = asset.sha256.trim().toLowerCase();
      const actual = event.actualSha256.trim().toLowerCase();
      if (!isHex64(expected) || expected !== actual) {
        const mismatch = transitionOfflineModel(current, {
          type: "VERIFY_FAIL",
          reason: "checksum mismatch against catalogue pin",
        });
        this.statuses.set(modelId, mismatch);
        return mismatch;
      }
    }
    const next = transitionOfflineModel(current, event);
    this.statuses.set(modelId, next);
    return next;
  }

  /**
   * Pre-download gate: explicit user initiation + catalogue pin + free
   * space. Returns a failure (never throws for advisory states) so the UI
   * can explain; callers must not start a transport on `ok: false`.
   */
  async checkDownloadGate(
    modelId: string,
    options: { userInitiated: boolean },
  ): Promise<DownloadGateResult> {
    const asset = this.assets.get(modelId);
    if (asset === undefined) {
      return { ok: false, code: "UNKNOWN_MODEL", reason: `unknown model ${modelId}` };
    }
    if (options.userInitiated !== true) {
      return {
        ok: false,
        code: "NOT_USER_INITIATED",
        reason: "downloads start only on explicit user action",
      };
    }
    if (!isHex64(asset.sha256.trim())) {
      // Mirrors the archive fail-closed rule for unpublished/unpinned
      // distribution: no pin, no download, no probing.
      return {
        ok: false,
        code: "MISSING_PIN",
        reason: "no catalogue checksum pin for this model",
      };
    }
    const status = this.statuses.get(modelId) as OfflineModelStatus;
    if (status.download === "installed") {
      return { ok: false, code: "ALREADY_INSTALLED", reason: "model installed" };
    }
    if (this.probe !== undefined) {
      const free = await this.probe.freeBytes();
      const remaining = asset.downloadBytes - status.downloadedBytes;
      if (!Number.isFinite(free) || free < remaining + this.headroomBytes) {
        return {
          ok: false,
          code: "INSUFFICIENT_STORAGE",
          reason: "not enough free storage for this download",
        };
      }
    }
    return { ok: true };
  }

  /**
   * WS-C delegation: download/verify/install steps live in
   * `download/*`; the manager only owns gating + transitions.
   */

  /** Checksum compare delegated to `download/installer`. */
  checksumsMatch(expectedHex: string, actualHex: string): boolean {
    return verifyChecksumMatch(expectedHex, actualHex);
  }

  /** Storage headroom gate delegated to `download/storage`. */
  preflightForDownload(
    requiredBytes: number,
    freeBytes: number,
    headroomBytes = this.headroomBytes,
  ): PreflightResult {
    return preflightCheck({ requiredBytes, freeBytes, headroomBytes });
  }

  /** App-private staging/installed paths delegated to `download/storage`. */
  stagingPathsFor(
    rootDir: string,
    modelId: string,
    revision: string,
    filePath: string,
  ): { readonly stagingPath: string; readonly installedPath: string } {
    return buildModelPaths(rootDir, modelId, revision, filePath);
  }

  /** Resume offset delegated to the `download/transport` journal. */
  resumeOffsetFrom(journal: DownloadJournal): number {
    return journalResumeOffset(journal);
  }

  /**
   * Record transport progress from a sidecar journal: the journal offset
   * becomes the staged-byte count (the resume offset for a future fetch).
   */
  recordJournalProgress(
    modelId: string,
    journal: DownloadJournal,
  ): OfflineModelStatus {
    const current = this.statuses.get(modelId);
    if (current === undefined) {
      throw new OfflineTransitionError(`unknown model ${modelId}`);
    }
    const next = transitionOfflineModel(current, {
      type: "PROGRESS",
      downloadedBytes: journalResumeOffset(journal),
    });
    this.statuses.set(modelId, next);
    return next;
  }

  /** Verify staged weights through the injected verifier (no-op if absent). */
  async verifyNow(
    modelId: string,
    signal?: AbortSignal,
  ): Promise<{ readonly match: boolean; readonly actualHex: string } | null> {
    const asset = this.assets.get(modelId);
    if (asset === undefined) {
      throw new OfflineTransitionError(`unknown model ${modelId}`);
    }
    if (this.verifier === undefined) return null;
    return this.verifier.verifySha256(modelId, asset.sha256, signal);
  }

  /**
   * Persistable snapshot. Residency is runtime-only: any in-flight
   * loading/unloading collapses to `unloaded`, and an interrupted download
   * collapses to `paused` with its resume offset kept.
   */
  snapshot(): OfflineManagerSnapshot {
    const models: Record<string, PersistedModelState> = {};
    for (const [modelId, status] of this.statuses) {
      const download =
        status.download === "downloading" ||
        status.download === "queued" ||
        status.download === "verifying"
          ? "paused"
          : status.download;
      models[modelId] = {
        download,
        downloadedBytes: status.downloadedBytes,
        checksumVerified:
          download === "installed" ? status.checksumVerified : false,
        ...(status.lastError !== undefined ? { lastError: status.lastError } : {}),
        updatedAt: status.updatedAt,
      };
    }
    return { version: OFFLINE_MANAGER_SNAPSHOT_VERSION, models };
  }

  /** Restore a snapshot; transient states collapse per `snapshot`. */
  restore(snapshot: OfflineManagerSnapshot): void {
    if (
      typeof snapshot !== "object" ||
      snapshot === null ||
      (snapshot as { version?: unknown }).version !==
        OFFLINE_MANAGER_SNAPSHOT_VERSION
    ) {
      throw new OfflineTransitionError(
        `unsupported offline snapshot version ${String((snapshot as { version?: unknown } | null)?.version)}`,
      );
    }
    for (const [modelId, persisted] of Object.entries(snapshot.models)) {
      const current = this.statuses.get(modelId);
      if (current === undefined) continue; // Unknown id: ignore, never invent.
      const download: OfflineDownloadState =
        persisted.download === "downloading" ||
        persisted.download === "queued" ||
        persisted.download === "verifying"
          ? "paused"
          : persisted.download;
      const downloadedBytes =
        Number.isFinite(persisted.downloadedBytes) && persisted.downloadedBytes > 0
          ? Math.floor(persisted.downloadedBytes)
          : 0;
      this.statuses.set(modelId, {
        modelId,
        download,
        residency: "unloaded",
        downloadedBytes: download === "not-installed" ? 0 : downloadedBytes,
        checksumVerified:
          download === "installed" && persisted.checksumVerified === true,
        ...(persisted.lastError !== undefined
          ? { lastError: persisted.lastError }
          : {}),
        updatedAt: new Date().toISOString(),
      });
    }
  }
}
