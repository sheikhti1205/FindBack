/**
 * WS-C installer: verify-then-install, pause/resume, delete, and
 * side-by-side update-then-switch.
 *
 * Orchestrates `manifest.ts` pins, `transport.ts` journals, and
 * `storage.ts` atomic promotion through injected seams only:
 * - `FileSystemAdapter` for every filesystem touch,
 * - `HashComputer` for SHA-256 (platform provides the real one),
 * - `unload` hook so delete/update never pulls bytes from under a live
 *   runtime.
 */

import type { DownloadJournal } from "./transport";
import {
  atomicWriteBytes,
  buildModelPaths,
  promoteStagedFile,
  type FileSystemAdapter,
} from "./storage";

export type InstallState = "NOT_INSTALLED" | "INSTALLED";

/** Async SHA-256 seam. Tests inject a stub; production injects WebCrypto. */
export interface HashComputer {
  sha256Hex(data: Uint8Array): Promise<string>;
}

function normalizeHex(value: string): string {
  return value.trim().toLowerCase();
}

function isHex64(value: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(value.trim());
}

/**
 * Exact checksum comparison shared with `offlineModelManager` delegation.
 * Case-insensitive hex compare; anything malformed is a mismatch.
 */
export function verifyChecksumMatch(
  expectedHex: string,
  actualHex: string,
): boolean {
  if (!isHex64(expectedHex) || !isHex64(actualHex)) return false;
  return normalizeHex(expectedHex) === normalizeHex(actualHex);
}

export interface StagedModelPaths {
  readonly stagingPath: string;
  readonly installedPath: string;
}

export function stagedPathsFor(
  rootDir: string,
  modelId: string,
  revision: string,
  filePath: string,
): StagedModelPaths {
  return buildModelPaths(rootDir, modelId, revision, filePath);
}

export interface InstallOutcome {
  readonly ok: boolean;
  readonly state: InstallState;
  readonly actualHex: string;
}

/**
 * Verify-then-install: hash staged bytes, and only on an exact match
 * atomically promote to the installed path. On mismatch the staged file is
 * deleted and the model reports NOT_INSTALLED (never half-installed).
 */
export async function verifyThenInstall(
  fs: FileSystemAdapter,
  hasher: HashComputer,
  paths: StagedModelPaths,
  stagedBytes: Uint8Array,
  expectedHex: string,
): Promise<InstallOutcome> {
  const actualHex = normalizeHex(await hasher.sha256Hex(stagedBytes));
  if (!verifyChecksumMatch(expectedHex, actualHex)) {
    await silentUnlink(fs, paths.stagingPath);
    return { ok: false, state: "NOT_INSTALLED", actualHex };
  }
  await atomicWriteBytes(fs, paths.stagingPath, stagedBytes);
  await promoteStagedFile(fs, paths.stagingPath, paths.installedPath);
  return { ok: true, state: "INSTALLED", actualHex };
}

export interface PauseOutcome {
  readonly paused: true;
  /** Offset preserved for the resume fetch. */
  readonly resumeOffset: number;
}

/** Pause: freeze the journal offset so resume continues byte-exact. */
export function pauseDownload(journal: DownloadJournal): PauseOutcome {
  return { paused: true, resumeOffset: journal.offset };
}

/** Resume: the next Range fetch starts at the preserved offset. */
export function resumeOffset(journal: DownloadJournal): number {
  return journal.offset;
}

async function silentUnlink(fs: FileSystemAdapter, path: string): Promise<void> {
  try {
    await fs.unlink(path);
  } catch {
    // Missing files are the common case; delete is idempotent.
  }
}

export interface DeleteOutcome {
  readonly state: "NOT_INSTALLED";
  readonly removed: readonly string[];
}

/**
 * Delete: unload the runtime first, then remove installed files, staged
 * partials, and caches. Missing paths are skipped; unload always runs.
 */
export async function deleteModel(
  fs: FileSystemAdapter,
  candidates: readonly string[],
  options: { unload?: () => Promise<void> } = {},
): Promise<DeleteOutcome> {
  await options.unload?.();
  const removed: string[] = [];
  for (const path of candidates) {
    try {
      await fs.unlink(path);
      removed.push(path);
    } catch {
      // Idempotent delete: a missing file is already deleted.
    }
  }
  return { state: "NOT_INSTALLED", removed };
}

/**
 * List every path deleteModel should clear for one file: installed bytes,
 * staged partial, atomic tmp leftovers, and the sidecar journal.
 */
export function installedFileCandidates(paths: StagedModelPaths): string[] {
  return [
    paths.installedPath,
    paths.stagingPath,
    `${paths.installedPath}.tmp`,
    `${paths.stagingPath}.tmp`,
    `${paths.stagingPath}.journal.json`,
  ];
}

export interface UpdateStaging {
  readonly current: StagedModelPaths;
  readonly next: StagedModelPaths;
}

/**
 * Side-by-side staging: the new revision stages under its own directory so
 * the running revision is never clobbered mid-download.
 */
export function prepareUpdateStaging(
  rootDir: string,
  modelId: string,
  currentRevision: string,
  nextRevision: string,
  filePath: string,
): UpdateStaging {
  return {
    current: buildModelPaths(rootDir, modelId, currentRevision, filePath),
    next: buildModelPaths(rootDir, modelId, nextRevision, filePath),
  };
}

export interface SwitchOutcome {
  readonly switched: boolean;
  readonly activeRevision: string;
  readonly actualHex: string;
}

/**
 * Update-then-switch: verify the staged new-revision bytes FIRST; only on
 * an exact match promote them and report the new revision active. On
 * mismatch the staged next-revision bytes are deleted and the current
 * revision stays active untouched.
 */
export async function switchAfterVerify(
  fs: FileSystemAdapter,
  hasher: HashComputer,
  staging: UpdateStaging,
  stagedNextBytes: Uint8Array,
  expectedHex: string,
  currentRevision: string,
  nextRevision: string,
): Promise<SwitchOutcome> {
  const actualHex = normalizeHex(await hasher.sha256Hex(stagedNextBytes));
  if (!verifyChecksumMatch(expectedHex, actualHex)) {
    await silentUnlink(fs, staging.next.stagingPath);
    return { switched: false, activeRevision: currentRevision, actualHex };
  }
  await atomicWriteBytes(fs, staging.next.stagingPath, stagedNextBytes);
  await promoteStagedFile(
    fs,
    staging.next.stagingPath,
    staging.next.installedPath,
  );
  return { switched: true, activeRevision: nextRevision, actualHex };
}
