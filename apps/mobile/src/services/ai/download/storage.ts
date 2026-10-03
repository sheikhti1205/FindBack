/**
 * WS-C on-device storage lifecycle: preflight, path building, atomic
 * promote, and the low-storage bounded-partial policy.
 *
 * Every filesystem touch goes through the injected `FileSystemAdapter`
 * (in-memory fake in tests, platform adapter in production). This module
 * never imports `node:fs` so the mobile bundle stays portable.
 */

/** Minimal filesystem surface the storage lifecycle needs. */
export interface FileSystemAdapter {
  mkdir(path: string): Promise<void>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  /** Best-effort durability sync; optional on platforms without fsync. */
  fsync?(path: string): Promise<void>;
  /** Free bytes available to the app. */
  freeBytes(): Promise<number>;
}

export type StorageErrorCode =
  | "LOW_STORAGE"
  | "TRAVERSAL_BLOCKED"
  | "PARTIAL_KEPT";

export class StorageError extends Error {
  readonly code: StorageErrorCode;

  constructor(code: StorageErrorCode, message: string) {
    super(message);
    this.name = "StorageError";
    this.code = code;
  }
}

export interface PreflightInput {
  readonly requiredBytes: number;
  readonly freeBytes: number;
  readonly headroomBytes?: number;
}

export type PreflightResult =
  | { readonly ok: true; readonly remainingAfter: number }
  | {
      readonly ok: false;
      readonly code: "LOW_STORAGE";
      readonly reason: string;
      readonly shortfall: number;
    };

/**
 * Headroom-aware free-space gate. `headroomBytes` is the minimum free space
 * that must remain AFTER the write; callers refuse the download on `ok:
 * false` and keep any existing partial for resume.
 */
export function preflightCheck(input: PreflightInput): PreflightResult {
  const headroom = input.headroomBytes ?? 0;
  const remainingAfter = input.freeBytes - input.requiredBytes;
  if (
    !Number.isFinite(input.requiredBytes) ||
    !Number.isFinite(input.freeBytes) ||
    input.requiredBytes < 0 ||
    remainingAfter < headroom
  ) {
    const shortfall = Math.max(
      0,
      input.requiredBytes + headroom - input.freeBytes,
    );
    return {
      ok: false,
      code: "LOW_STORAGE",
      reason: "not enough free storage for this download",
      shortfall,
    };
  }
  return { ok: true, remainingAfter };
}

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

function assertSafeSegment(value: string, field: string): void {
  if (value.trim() === "" || value === "." || value === ".." || !SAFE_SEGMENT.test(value)) {
    throw new StorageError(
      "TRAVERSAL_BLOCKED",
      `rejected unsafe ${field} ${value}`,
    );
  }
}

function assertSafeRelativePath(filePath: string): string[] {
  if (filePath === "" || filePath.includes("\\") || filePath.startsWith("/")) {
    throw new StorageError(
      "TRAVERSAL_BLOCKED",
      `rejected unsafe file path ${filePath}`,
    );
  }
  const segments = filePath.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new StorageError(
        "TRAVERSAL_BLOCKED",
        `rejected unsafe file path ${filePath}`,
      );
    }
  }
  return segments;
}

function joinPosix(parts: readonly string[]): string {
  return parts.join("/").replace(/\/+/g, "/");
}

export interface ModelPaths {
  /** App-private staging area for partials + sidecar journals. */
  readonly stagingPath: string;
  /** Final installed location for verified bytes. */
  readonly installedPath: string;
}

/**
 * App-private path builder with traversal guard. `rootDir` is the
 * app-private files dir supplied by the platform; `modelId`/`revision` are
 * restricted to `[A-Za-z0-9._-]` and `filePath` must be a safe relative
 * path — anything else throws `TRAVERSAL_BLOCKED`.
 */
export function buildModelPaths(
  rootDir: string,
  modelId: string,
  revision: string,
  filePath: string,
): ModelPaths {
  if (rootDir === "" || rootDir.includes("\\")) {
    throw new StorageError("TRAVERSAL_BLOCKED", "rejected unsafe root dir");
  }
  assertSafeSegment(modelId, "modelId");
  assertSafeSegment(revision, "revision");
  const segments = assertSafeRelativePath(filePath);
  const base = rootDir.replace(/\/+$/, "");
  const tail = joinPosix(segments);
  return {
    stagingPath: `${base}/staging/${modelId}/${revision}/${tail}`,
    installedPath: `${base}/models/${modelId}/${revision}/${tail}`,
  };
}

/** Suffix for the crash-safe intermediate used by atomic writes. */
export const ATOMIC_TMP_SUFFIX = ".tmp";

function parentDir(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "" : path.slice(0, index);
}

/**
 * Atomic write: bytes land in `<final>.tmp`, are fsynced when the adapter
 * supports it, then renamed over the final path. A crash can only leave the
 * tmp behind — never a torn final file.
 */
export async function atomicWriteBytes(
  fs: FileSystemAdapter,
  finalPath: string,
  data: Uint8Array,
): Promise<void> {
  const parent = parentDir(finalPath);
  if (parent !== "") await fs.mkdir(parent);
  const tmp = `${finalPath}${ATOMIC_TMP_SUFFIX}`;
  await fs.writeFile(tmp, data);
  if (fs.fsync !== undefined) await fs.fsync(tmp);
  await fs.rename(tmp, finalPath);
}

/**
 * Atomic promote of an already-staged file: stage → tmp-in-final-dir →
 * fsync → final. The staged file is consumed; the final path is untouched
 * until the last rename.
 */
export async function promoteStagedFile(
  fs: FileSystemAdapter,
  from: string,
  to: string,
): Promise<void> {
  const parent = parentDir(to);
  if (parent !== "") await fs.mkdir(parent);
  const tmp = `${to}${ATOMIC_TMP_SUFFIX}`;
  await fs.rename(from, tmp);
  if (fs.fsync !== undefined) await fs.fsync(tmp);
  await fs.rename(tmp, to);
}

export interface BoundedPartialInput {
  /** Bytes already staged (kept, never deleted by this policy). */
  readonly stagedBytes: number;
  /** Bytes the next chunk wants to add. */
  readonly incomingBytes: number;
  readonly freeBytes: number;
  readonly headroomBytes?: number;
  /** Cap on how much new data may land when storage is tight. */
  readonly maxPartialBytes?: number;
}

export type BoundedPartialResult =
  | { readonly decision: "allow"; readonly allowedBytes: number }
  | {
      readonly decision: "truncate";
      readonly allowedBytes: number;
      readonly keptBytes: number;
    }
  | {
      readonly decision: "reject-partial-kept";
      readonly allowedBytes: 0;
      readonly keptBytes: number;
    };

export const DEFAULT_MAX_PARTIAL_BYTES = 64 * 1024 * 1024;

/**
 * Low-storage bounded-partial policy. The existing partial is ALWAYS kept
 * for resume; only the new intake is bounded. Full fit → allow; tight fit
 * → truncate to the cap/headroom; no fit → reject the intake and keep the
 * partial untouched.
 */
export function boundedPartialPolicy(
  input: BoundedPartialInput,
): BoundedPartialResult {
  const headroom = input.headroomBytes ?? 0;
  const cap = input.maxPartialBytes ?? DEFAULT_MAX_PARTIAL_BYTES;
  const usable = input.freeBytes - headroom;
  if (!Number.isFinite(usable) || usable <= 0) {
    return {
      decision: "reject-partial-kept",
      allowedBytes: 0,
      keptBytes: input.stagedBytes,
    };
  }
  if (input.incomingBytes <= usable) {
    return { decision: "allow", allowedBytes: input.incomingBytes };
  }
  const allowed = Math.min(usable, cap);
  if (allowed <= 0) {
    return {
      decision: "reject-partial-kept",
      allowedBytes: 0,
      keptBytes: input.stagedBytes,
    };
  }
  return {
    decision: "truncate",
    allowedBytes: Math.floor(allowed),
    keptBytes: input.stagedBytes,
  };
}
