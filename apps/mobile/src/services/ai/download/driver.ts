/**
 * Managed model downloads: the TS orchestrator between `OfflineModelManager`
 * (gating + transitions), the manifest pin, and a `ModelDownloadDriver`
 * (production: the `FindbackModelDownload` native plugin; tests: a fake).
 *
 * Bytes never transit JS: the driver streams to staged app-private storage
 * natively and returns only counts + the running digest. Verify compares
 * the digest against the catalogue pin, promotes atomically, and only then
 * marks the model installed. Cancel keeps staged bytes (pause semantics);
 * only explicit remove discards them.
 */

import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import {
  OfflineModelManager,
  type OfflineAssetPin,
} from "../offlineModelManager";
import { installedFileCandidates } from "./installer";
import { journalPathFor, readJournal, resolveResumeOffset } from "./journal";
import { safeSourceUrl, retryableSourceFailure, nativeFailureCode } from "./sourcePolicy";

export class DriverError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DriverError";
    this.code = code;
  }
}

export interface DownloadAttempt {
  readonly modelId: string;
  readonly revision: string;
  readonly fileName: string;
  readonly url: string;
  readonly stagingPath: string;
  readonly resumeOffset: number;
  readonly expectedSha256: string;
  readonly maxBytes: number;
  readonly onProgress?: (receivedBytes: number, totalBytes: number | null) => void;
  readonly signal?: AbortSignal;
}

export interface DownloadAttemptResult {
  /** New bytes received this attempt (excludes the resumed prefix). */
  readonly receivedBytes: number;
  readonly totalBytes: number | null;
  /** Running SHA-256 over the whole staged file (prefix re-hash + new). */
  readonly actualHex: string;
  readonly finalUrl: string;
}

/** Platform seam behind every managed download. Faked in tests. */
export interface ModelDownloadDriver {
  pickAndStage?(args: { stagingPath: string; maxBytes: number; expectedBytes?: number; expectedSha256?: string; format: string }): Promise<{ actualHex: string; bytes: number }>;
  readMetadata?(path: string): Promise<string | null>;
  writeMetadata?(path: string, text: string): Promise<void>;
  rootDir(): Promise<string>;
  freeBytes(): Promise<number>;
  /** Staged bytes, or 0 when nothing is staged. Never negative. */
  stagedSize(stagingPath: string): Promise<number>;
  /** Raw journal text, or null when absent/unreadable. */
  readJournalText(stagingPath: string): Promise<string | null>;
  download(attempt: DownloadAttempt): Promise<DownloadAttemptResult>;
  cancelDownload(stagingPath: string): Promise<void>;
  hashFile(path: string): Promise<string>;
  promoteFile(from: string, to: string): Promise<void>;
  removeFile(path: string): Promise<void>;
}

export interface ManagedDownloadRequest {
  readonly modelId: string;
  readonly revision: string;
  readonly fileName: string;
  readonly url: string;
  /** Same artifact identity; bounded to four credential-free endpoints. */
  readonly sources?: readonly string[];
  readonly maxBytes: number;
  readonly userInitiated: boolean;
  readonly signal?: AbortSignal;
  readonly onProgress?: (receivedBytes: number, totalBytes: number | null) => void;
}

export type ManagedDownloadOutcome =
  | { readonly ok: true; readonly modelId: string }
  | { readonly ok: false; readonly modelId: string; readonly code: string; readonly reason: string };

function assetOf(manager: OfflineModelManager, modelId: string): OfflineAssetPin | undefined {
  return manager.assetPinOf(modelId);
}

/**
 * Run one managed download to installed-or-failed. Gate first (explicit
 * user initiation, catalogue pin, storage headroom); reconcile the journal
 * against staged bytes; stream; verify-against-pin; promote; mark
 * installed. Any driver failure lands in FAIL (bytes kept for resume);
 * cancel lands in CANCEL (paused, bytes kept).
 */
export async function runManagedDownload(
  manager: OfflineModelManager,
  driver: ModelDownloadDriver,
  request: ManagedDownloadRequest,
): Promise<ManagedDownloadOutcome> {
  const fail = (code: string, reason: string): ManagedDownloadOutcome => ({
    ok: false,
    modelId: request.modelId,
    code,
    reason,
  });

  const gate = await manager.checkDownloadGate(request.modelId, {
    userInitiated: request.userInitiated,
  });
  if (!gate.ok) return fail(gate.code, gate.reason);

  const asset = assetOf(manager, request.modelId);
  if (asset === undefined) return fail("UNKNOWN_MODEL", `unknown model ${request.modelId}`);
  const sources = [...new Set(request.sources ?? [request.url])];
  if (sources.length === 0 || sources.length > 4 || sources.some((url) => !safeSourceUrl(url))) {
    return fail("BAD_SOURCE", "Source must be a public credential-free HTTPS URL.");
  }

  let root: string;
  try {
    root = await driver.rootDir();
  } catch {
    return fail("DRIVER_UNAVAILABLE", "model storage is unavailable on this build");
  }
  const paths = manager.stagingPathsFor(root, request.modelId, request.revision, request.fileName);

  const status = manager.statusOf(request.modelId);
  if (status === undefined) return fail("UNKNOWN_MODEL", `unknown model ${request.modelId}`);
  if (status.download === "downloading" || status.download === "verifying") {
    return fail("ALREADY_RUNNING", `download already ${status.download}`);
  }

  let staged = 0;
  try {
    staged = await driver.stagedSize(paths.stagingPath);
  } catch {
    staged = 0;
  }
  let journalText: string | null = null;
  try {
    journalText = await driver.readJournalText(paths.stagingPath);
  } catch {
    journalText = null;
  }
  const journal =
    journalText !== null
      ? await readJournal(journalFsOverText(journalText), paths.stagingPath)
      : null;
  const matchesJournal = journal?.modelId === request.modelId && journal.revision === request.revision &&
    journal.filePath === request.fileName && journal.sha === asset.sha256 && sources.includes(journal.url);
  let sourceIndex = matchesJournal ? sources.indexOf(journal!.url) : 0;
  let offset = matchesJournal ? resolveResumeOffset(journal, staged > 0 ? staged : null).offset : 0;
  if (!matchesJournal && staged > 0) {
    await driver.removeFile(paths.stagingPath);
    await driver.removeFile(journalPathFor(paths.stagingPath));
  }

  try {
    if (status.download === "not-installed" || status.download === "failed") {
      manager.dispatch(request.modelId, { type: "QUEUE_DOWNLOAD", userInitiated: true });
    }
    manager.dispatch(request.modelId, { type: "START" });
  } catch (error) {
    return fail(
      "ILLEGAL_TRANSITION",
      error instanceof Error ? error.message : "cannot start download",
    );
  }

  let attempt: DownloadAttemptResult;
  try {
    for (;;) {
      if (request.signal?.aborted) throw new DriverError("ABORTED", "cancelled");
      try {
        attempt = await driver.download({
      modelId: request.modelId,
      revision: request.revision,
      fileName: request.fileName,
      url: sources[sourceIndex]!,
      stagingPath: paths.stagingPath,
      resumeOffset: offset,
      expectedSha256: asset.sha256,
      maxBytes: asset.downloadBytes,
      signal: request.signal,
      onProgress: (received, total) => {
        try {
          manager.dispatch(request.modelId, {
            type: "PROGRESS",
            downloadedBytes: offset + received,
          });
        } catch {
          // Monotonicity guard: ignore regressions, keep streaming.
        }
        request.onProgress?.(received, total);
      },
        });
        break;
      } catch (error) {
        const code = nativeFailureCode(error);
        if (request.signal?.aborted || !retryableSourceFailure(code) || sourceIndex + 1 >= sources.length) throw error;
        await driver.removeFile(paths.stagingPath);
        await driver.removeFile(journalPathFor(paths.stagingPath));
        offset = 0;
        sourceIndex++;
        manager.dispatch(request.modelId, { type: "FAIL", reason: "Trying another source." });
        manager.dispatch(request.modelId, { type: "QUEUE_DOWNLOAD", userInitiated: true });
        manager.dispatch(request.modelId, { type: "START" });
      }
    }
  } catch (error) {
    if (request.signal?.aborted === true) {
      try {
        manager.dispatch(request.modelId, { type: "CANCEL" });
      } catch {
        // Already settled; the pause stands.
      }
      return fail("CANCELLED", "download cancelled; staged bytes kept for resume");
    }
    const code = nativeFailureCode(error);
    if (["CHECKSUM_MISMATCH", "SIZE_MISMATCH", "BYTE_BOUND_EXCEEDED", "LICENSE_MISMATCH", "MANIFEST_MISMATCH", "BAD_MANIFEST"].includes(code)) {
      await driver.removeFile(paths.stagingPath).catch(() => {});
      await driver.removeFile(journalPathFor(paths.stagingPath)).catch(() => {});
    }
    const reason = `Download stopped (${code}).`;
    try {
      manager.dispatch(request.modelId, { type: "FAIL", reason: reason.slice(0, 400) });
    } catch {
      // Status already moved; keep the recorded state.
    }
    return fail(code, reason);
  }

  const cancelled = () => request.signal?.aborted === true || manager.statusOf(request.modelId)?.download !== "downloading";
  if (cancelled()) {
    if (manager.statusOf(request.modelId)?.download === "downloading") manager.dispatch(request.modelId, { type: "CANCEL" });
    return fail("CANCELLED", "download paused");
  }
  if (offset + attempt.receivedBytes !== asset.downloadBytes || (attempt.totalBytes !== null && attempt.totalBytes !== asset.downloadBytes)) {
    await driver.removeFile(paths.stagingPath);
    await driver.removeFile(journalPathFor(paths.stagingPath));
    manager.dispatch(request.modelId, { type: "FAIL", reason: "SIZE_MISMATCH" });
    return fail("SIZE_MISMATCH", "Download did not match the exact expected size.");
  }

  try {
    manager.dispatch(request.modelId, { type: "VERIFY_START" });
  } catch (error) {
    return fail("ILLEGAL_TRANSITION", error instanceof Error ? error.message : "cannot verify");
  }
  if (!manager.checksumsMatch(asset.sha256, attempt.actualHex)) {
    try {
      await driver.removeFile(paths.stagingPath);
      await driver.removeFile(journalPathFor(paths.stagingPath));
    } catch {
      // Delete is best-effort; the state below is authoritative.
    }
    try {
      manager.dispatch(request.modelId, {
        type: "VERIFY_FAIL",
        reason: "checksum mismatch against catalogue pin",
      });
    } catch {
      // Keep the recorded state.
    }
    return fail("CHECKSUM_MISMATCH", "staged bytes failed pin verification and were deleted");
  }
  try {
    const cancelVerification = () => {
      if (manager.statusOf(request.modelId)?.download === "verifying") manager.dispatch(request.modelId, { type: "CANCEL" });
      return fail("CANCELLED", "download paused");
    };
    if (request.signal?.aborted || manager.statusOf(request.modelId)?.download !== "verifying") return cancelVerification();
    await driver.promoteFile(paths.stagingPath, paths.installedPath);
    if (request.signal?.aborted || manager.statusOf(request.modelId)?.download !== "verifying") {
      await driver.removeFile(paths.installedPath);
      return cancelVerification();
    }
  } catch {
    try {
      manager.dispatch(request.modelId, { type: "FAIL", reason: "atomic promote failed" });
    } catch {
      // Keep the recorded state.
    }
    return fail("PROMOTE_FAILED", "verified bytes could not be promoted");
  }
  manager.dispatch(request.modelId, { type: "VERIFY_OK", actualSha256: attempt.actualHex });
  return { ok: true, modelId: request.modelId };
}

/** Pause an in-flight download; staged bytes are kept for resume. */
export async function pauseManagedDownload(
  manager: OfflineModelManager,
  driver: ModelDownloadDriver,
  modelId: string,
  stagingPath: string,
): Promise<void> {
  try {
    await driver.cancelDownload(stagingPath);
  } finally {
    try {
      manager.dispatch(modelId, { type: "CANCEL" });
    } catch {
      // Not downloading; nothing to pause.
    }
  }
}

/** Delete every on-disk trace after unloading the runtime (when loaded). */
export async function removeManagedModel(
  manager: OfflineModelManager,
  driver: ModelDownloadDriver,
  rootDir: string,
  modelId: string,
  revision: string,
  fileName: string,
  options: { unload?: () => Promise<void> } = {},
): Promise<void> {
  manager.dispatch(modelId, { type: "DELETE" });
  await driver.cancelDownload(manager.stagingPathsFor(rootDir, modelId, revision, fileName).stagingPath);
  await options.unload?.();
  const paths = manager.stagingPathsFor(rootDir, modelId, revision, fileName);
  for (const path of installedFileCandidates(paths)) {
    try {
      await driver.removeFile(path);
    } catch {
      // Idempotent delete: a missing file is already deleted.
    }
  }
  try {
    manager.dispatch(modelId, { type: "DELETE" });
  } catch {
    // Already removed; the disk state above is authoritative.
  }
}

function journalFsOverText(text: string | null): {
  writeFile: (path: string, data: Uint8Array) => Promise<void>;
  readFile: (path: string) => Promise<Uint8Array>;
  rename: (from: string, to: string) => Promise<void>;
  unlink: (path: string) => Promise<void>;
} {
  return {
    writeFile: async () => {
      throw new Error("read-only journal fs");
    },
    readFile: async () => {
      if (text === null) throw new Error("missing file");
      return new TextEncoder().encode(text);
    },
    rename: async () => {
      throw new Error("read-only journal fs");
    },
    unlink: async () => {},
  };
}

interface NativeDownloadPlugin {
  pickAndStage(args: { stagingPath: string; maxBytes: number; expectedBytes?: number; expectedSha256?: string; format: string }): Promise<{ actualHex: string; bytes: number }>;
  writeTextFile(args: { path: string; text: string }): Promise<unknown>;
  getRootDir(): Promise<{ rootDir: string }>;
  startDownload(args: {
    downloadId: string;
    url: string;
    stagingPath: string;
    journalPath: string;
    resumeOffset: number;
    expectedSha256: string;
    maxBytes: number;
    modelId: string;
    revision: string;
    fileName: string;
  }): Promise<{ received: number; total?: number; actualSha256: string; finalUrl: string }>;
  cancelDownload(args: { stagingPath: string }): Promise<unknown>;
  sha256File(args: { path: string }): Promise<{ sha256: string }>;
  fileSize(args: { path: string }): Promise<{ size: number }>;
  freeBytes(args?: { path?: string }): Promise<{ freeBytes: number }>;
  deleteFile(args: { path: string }): Promise<unknown>;
  promoteFile(args: { from: string; to: string }): Promise<unknown>;
  readTextFile(args: { path: string }): Promise<{ exists: boolean; text?: string }>;
  addListener(
    eventName: "downloadProgress",
    listener: (event: { downloadId: string; received: number; total?: number }) => void,
  ): Promise<PluginListenerHandle>;
}

/**
 * Production driver over the `FindbackModelDownload` native plugin.
 * Web builds never construct this (no native module) — callers gate on
 * `Capacitor.isNativePlatform()` and fail closed without it.
 */
export class CapacitorModelDownloadDriver implements ModelDownloadDriver {
  private plugin: NativeDownloadPlugin | null = null;

  private bridge(): NativeDownloadPlugin {
    if (this.plugin === null) {
      if (Capacitor.isNativePlatform() !== true) {
        throw new DriverError("DRIVER_UNAVAILABLE", "native download bridge is absent on web");
      }
      this.plugin = registerPlugin<NativeDownloadPlugin>("FindbackModelDownload");
    }
    return this.plugin;
  }

  async rootDir(): Promise<string> {
    const { rootDir } = await this.bridge().getRootDir();
    return rootDir;
  }

  async pickAndStage(args: { stagingPath: string; maxBytes: number; expectedBytes?: number; expectedSha256?: string; format: string }): Promise<{ actualHex: string; bytes: number }> {
    try { return await this.bridge().pickAndStage(args); }
    catch (error) { throw new DriverError(nativeFailureCode(error), "Import could not be completed."); }
  }
  async readMetadata(path: string): Promise<string | null> {
    const r = await this.bridge().readTextFile({ path }); return r.exists ? r.text ?? null : null;
  }
  async writeMetadata(path: string, text: string): Promise<void> { await this.bridge().writeTextFile({ path, text }); }

  async freeBytes(): Promise<number> {
    const { freeBytes } = await this.bridge().freeBytes();
    return freeBytes;
  }

  async stagedSize(stagingPath: string): Promise<number> {
    try {
      const { size } = await this.bridge().fileSize({ path: stagingPath });
      return Number.isInteger(size) && size > 0 ? size : 0;
    } catch {
      return 0;
    }
  }

  async readJournalText(stagingPath: string): Promise<string | null> {
    try {
      const result = await this.bridge().readTextFile({ path: journalPathFor(stagingPath) });
      return result.exists === true && typeof result.text === "string" ? result.text : null;
    } catch {
      return null;
    }
  }

  async download(attempt: DownloadAttempt): Promise<DownloadAttemptResult> {
    const plugin = this.bridge();
    const downloadId = `${attempt.modelId}@${attempt.revision}`;
    const handle = await plugin.addListener("downloadProgress", (event) => {
      if (event.downloadId !== downloadId) return;
      attempt.onProgress?.(event.received, event.total ?? null);
    });
    const cancel = () => { void plugin.cancelDownload({ stagingPath: attempt.stagingPath }).catch(() => undefined); };
    attempt.signal?.addEventListener("abort", cancel, { once: true });
    try {
      if (attempt.signal?.aborted) throw new DriverError("ABORTED", "download cancelled");
      const done = await plugin.startDownload({
        downloadId,
        url: attempt.url,
        stagingPath: attempt.stagingPath,
        journalPath: journalPathFor(attempt.stagingPath),
        resumeOffset: attempt.resumeOffset,
        expectedSha256: attempt.expectedSha256,
        maxBytes: attempt.maxBytes,
        modelId: attempt.modelId,
        revision: attempt.revision,
        fileName: attempt.fileName,
      });
      return {
        receivedBytes: done.received,
        totalBytes: done.total ?? null,
        actualHex: done.actualSha256,
        finalUrl: done.finalUrl,
      };
    } catch (error) {
      const code = nativeFailureCode(error);
      throw new DriverError(code, `Download stopped (${code}).`);
    } finally {
      attempt.signal?.removeEventListener("abort", cancel);
      await handle.remove().catch(() => undefined);
    }
  }

  async cancelDownload(stagingPath: string): Promise<void> {
    try {
      await this.bridge().cancelDownload({ stagingPath });
    } catch {
      // Cancel is best-effort; the state machine records the pause.
    }
  }

  async hashFile(path: string): Promise<string> {
    const { sha256 } = await this.bridge().sha256File({ path });
    return sha256;
  }

  async promoteFile(from: string, to: string): Promise<void> {
    await this.bridge().promoteFile({ from, to });
  }

  async removeFile(path: string): Promise<void> {
    await this.bridge().deleteFile({ path });
  }
}
