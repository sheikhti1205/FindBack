/**
 * Curated Model Library transfers: gated download, package import, package export.
 *
 * Streaming orchestration + validation over injected platform seams — no
 * fetching, no ZIP framing, no storage side effects, no UI. Chunks flow from
 * a `DownloadTransport` (HTTP Range) or a `StreamingArchive` (ZIP entries)
 * through a fixed-size block buffer into the app-private `ModelTransferStore`
 * (temp file) or a `PackageWriter` (archive writer). Hashing is incremental
 * (`IncrementalSha256`): no full-model `Uint8Array` is ever assembled, at any
 * size. The platform layer supplies transport, archive iteration, the file
 * store, and the archive writer; this module decides gating, verifies hashes
 * against the shipped catalogue pins, and enforces the data-only package
 * invariants from `docs/specs/model-library/fbmodel-package.md` and the
 * threat constraints from `docs/specs/model-library/threat-surface.md`.
 *
 * Download: advisory RAM-envelope gate via `ramPolicy` (never auto-downloads;
 * a triggered gate blocks unless the caller passes an explicitly recorded
 * `advancedConfirmed`), resumable by byte offset from the staged temp prefix,
 * hash-verified against the shipped `sha256` pin, committed via atomic
 * rename. A failed download returns an error — partial bytes stay staged for
 * resume (transport/cancel) or are discarded (corrupt prefix), and are never
 * reported as installed.
 *
 * Import: validates a `.fbmodel` interior against the catalogue entry —
 * manifest allow-list, exact file set, per-file SHA-256, declared-vs-actual
 * sizes, expanded-size cap, safe paths, symlink rejection, and the
 * executable ban (suffix AND content sniff on the stream head).
 *
 * Export: streams installed files into a shareable offline package through
 * the archive-writer seam, building the manifest from observed sizes and
 * incremental hashes, applying the same validation so only data-only
 * packages can be produced.
 */

import type { ModelCatalogueEntry } from "./catalogueTypes";
import {
  FBMODEL_PACKAGE_VERSION,
  isFbmodelDeniedSuffix,
  type FbmodelCompressionMethod,
  type FbmodelManifest,
  type FbmodelManifestFile,
} from "./fbmodelSeam";
import { isInstallable } from "./modelCatalogue";
import { needsAdvancedConfirm, type AvailableFreeRamMb } from "./ramPolicy";
import { IncrementalSha256, sha256HexOfBytes } from "./streamingHash";
import {
  TransferCancelledError,
  throwIfCancelled,
  type ModelTransferStore,
  type TransferControl,
} from "./transferStore";

/** Interior path of the package manifest (source of truth for extraction). */
export const FBMODEL_MANIFEST_NAME = "manifest.json" as const;

/** Interior path of the per-file checksum sidecar. */
export const FBMODEL_CHECKSUMS_NAME = "checksums.json" as const;

/**
 * Absolute expanded-size cap for one imported package (v1 choice: 2 GiB,
 * aligned with the per-asset distribution limit; the threat-surface note
 * asks for single-digit GiB sized above the largest catalogued entry plus
 * margin — the largest v1 entry is ~361 MB).
 */
export const MAX_PACKAGE_EXPANDED_BYTES = 2 * 1024 * 1024 * 1024;

/** Upper bound for the manifest document itself (small by construction). */
export const MAX_MANIFEST_BYTES = 256 * 1024;

/** Machine-readable transfer failure codes (advisory data, never UI). */
export type TransferErrorCode =
  | "NOT_INSTALLABLE"
  | "NEEDS_ADVANCED_CONFIRM"
  | "MISSING_PIN"
  | "TRANSPORT_ERROR"
  | "CANCELLED"
  | "SIZE_MISMATCH"
  | "HASH_MISMATCH"
  | "WHOLE_HASH_MISMATCH"
  | "MANIFEST_MISSING"
  | "MANIFEST_INVALID"
  | "ENTRY_MISMATCH"
  | "MISSING_FILE"
  | "EXTRA_FILE"
  | "UNSAFE_PATH"
  | "DENIED_FILE"
  | "PACKAGE_TOO_LARGE"
  | "MISSING_WEIGHTS"
  | "NO_FILES"
  | "INSUFFICIENT_STORAGE"
  | "CORRUPT_ARCHIVE";

export interface TransferFailure {
  readonly ok: false;
  readonly code: TransferErrorCode;
  /** Human-readable advisory note (presentation layer decides display). */
  readonly reason: string;
}

/**
 * Synchronous SHA-256 hex over bytes. One-shot convenience for small
 * buffers (manifests, fixtures) over the streaming core — never a transfer
 * path. Pure TypeScript (WebView-safe: no `node:crypto`, no async
 * subtle-crypto); byte-input twin of the string hash in `services/diag.ts`.
 */
export function sha256BytesHex(input: Uint8Array): string {
  return sha256HexOfBytes(input);
}

/**
 * Incremental SHA-256 over a chunk stream without buffering the whole
 * input. The web import entry point feeds `File.stream()` chunks here so
 * no multi-GB JS buffer is ever assembled; the memory store stays reserved
 * for tests and small fixtures.
 */
export async function hashByteStream(
  chunks: AsyncIterable<Uint8Array>,
  control?: TransferControl,
): Promise<string> {
  const hasher = new IncrementalSha256();
  for await (const chunk of chunks) {
    throwIfCancelled(control);
    hasher.update(chunk);
  }
  throwIfCancelled(control);
  return hasher.digestHex();
}

/**
 * Streaming SHA-256 over a picked web file via `File.stream()`, chunk by
 * chunk — the production web import path. Never assembles the whole file;
 * the Android production path uses `NativePackageHost` instead.
 */
export async function hashWebFile(
  file: { stream(): ReadableStream<Uint8Array> },
  control?: TransferControl,
): Promise<string> {
  const reader = file.stream().getReader();
  const hasher = new IncrementalSha256();
  try {
    for (;;) {
      throwIfCancelled(control);
      const { done, value } = await reader.read();
      if (done) break;
      if (value != null) hasher.update(value);
    }
  } finally {
    reader.releaseLock();
  }
  throwIfCancelled(control);
  return hasher.digestHex();
}

/**
 * Native package host contract (Android: SAF content URI → native stream
 * → incremental package hash → archive entry validation → streaming
 * extraction → per-entry incremental hash → temp sandbox → atomic
 * install; export reverses installed files through a streaming writer to
 * a SAF output URI). Declared here; implemented in the platform layer —
 * no ZIP framing runs in the web UI.
 */
export interface NativePackageHost {
  importPackageFromUri(args: {
    entryId: string;
    sourceUri: string;
    expectedSha256: string;
    control?: TransferControl;
  }): Promise<ImportResult>;
  exportPackageToUri(args: {
    entryId: string;
    destUri: string;
    control?: TransferControl;
  }): Promise<ExportStreamResult>;
}

/**
 * Why an interior path is unsafe, or null when it is confined to the
 * per-model sandbox. Rejects empty paths, absolute paths, drive-letter
 * paths, `..` segments (either separator), backslashes (a separator on
 * some extractors), and symlink entries are rejected by the caller via
 * the `isSymlink` flag.
 */
export function findUnsafePathReason(path: string): string | null {
  if (path.length === 0) return "empty interior path";
  if (path.startsWith("/") || path.startsWith("\\")) {
    return `absolute path: ${path}`;
  }
  if (/^[A-Za-z]:/.test(path)) return `drive-letter path: ${path}`;
  if (path.includes("\\")) return `backslash separator: ${path}`;
  const segments = path.split("/");
  if (segments.some((segment) => segment === "..")) {
    return `parent traversal: ${path}`;
  }
  if (segments.some((segment) => segment.length === 0)) {
    return `empty segment: ${path}`;
  }
  return null;
}

/** True when the leading bytes match a denied executable magic (ELF/MZ/dex). */
export function hasDeniedMagic(bytes: Uint8Array): boolean {
  const elf =
    bytes.length >= 4 &&
    bytes[0] === 0x7f &&
    bytes[1] === 0x45 &&
    bytes[2] === 0x4c &&
    bytes[3] === 0x46;
  const mz = bytes.length >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a;
  const dex =
    bytes.length >= 4 &&
    bytes[0] === 0x64 &&
    bytes[1] === 0x65 &&
    bytes[2] === 0x78 &&
    bytes[3] === 0x0a;
  return elf || mz || dex;
}

export type DownloadGate =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: TransferErrorCode; readonly reason: string };

export interface DownloadGateInput {
  /** Passively observed free RAM (never an allocation probe). */
  availableFreeRamMb: AvailableFreeRamMb;
  /** Whether the advanced-confirmation gate was explicitly accepted. */
  advancedConfirmed: boolean;
}

/**
 * Advisory download gate. Never fetches; never auto-downloads. Reference
 * listings, experimental eval-only slots, and entries without a shipped
 * hash pin are never downloadable; a triggered RAM-envelope gate blocks
 * unless `advancedConfirmed` was explicitly recorded.
 */
export function checkDownloadGate(
  entry: ModelCatalogueEntry,
  input: DownloadGateInput,
): DownloadGate {
  if (!isInstallable(entry)) {
    return {
      allowed: false,
      code: "NOT_INSTALLABLE",
      reason:
        "Catalog reference or unverifiable entry: this entry is not distributed as a downloadable package.",
    };
  }
  if (entry.sha256 == null) {
    return {
      allowed: false,
      code: "MISSING_PIN",
      reason:
        "No shipped hash pin: the package cannot be verified, so download is refused.",
    };
  }
  if (needsAdvancedConfirm(entry, input.availableFreeRamMb) && !input.advancedConfirmed) {
    return {
      allowed: false,
      code: "NEEDS_ADVANCED_CONFIRM",
      reason:
        "Advanced confirmation required: available memory is below the entry minimum and no explicit acknowledgement was recorded.",
    };
  }
  return { allowed: true };
}

/**
 * Platform download seam (HTTP Range in production). Reports each received
 * chunk; resolves with the authoritative total byte count so the caller can
 * detect a changed artifact mid-flight. The seam streams — accumulation, if
 * any, is the caller's choice, and the store path below never accumulates.
 */
export interface DownloadTransport {
  download(
    url: string,
    offset: number,
    onChunk: (chunk: Uint8Array) => void,
  ): Promise<{ totalBytes: number }>;
}

export interface DownloadProgress {
  readonly receivedBytes: number;
  readonly totalBytes: number | null;
}

export interface DownloadToStoreInput extends DownloadGateInput {
  /** Discard the staged temp prefix and restart from byte zero. */
  restart?: boolean;
  /** Previously observed total for resume-drift detection (else unknown). */
  expectedTotalBytes?: number | null;
  /** Cooperative cancellation; the staged prefix is kept for resume. */
  control?: TransferControl;
  onProgress?: (progress: DownloadProgress) => void;
}

export type DownloadToStoreResult =
  | { readonly ok: true; readonly installedBytes: number; readonly totalBytes: number }
  | (TransferFailure & { readonly receivedBytes: number });

/**
 * Gated, resumable, hash-verified streaming download. Chunks append to the
 * app-private temp prefix while an incremental hash absorbs them; on success
 * the prefix commits atomically to installed. Returns sizes only — never
 * the bytes. Transport interruptions and cancellation keep the staged prefix
 * for byte-offset resume; corrupt prefixes (size/hash mismatch) are
 * discarded and must be restarted.
 */
export async function downloadModelToStore(
  entry: ModelCatalogueEntry,
  url: string,
  transport: DownloadTransport,
  store: ModelTransferStore,
  input: DownloadToStoreInput,
): Promise<DownloadToStoreResult> {
  const gate = checkDownloadGate(entry, input);
  if (!gate.allowed) {
    return { ok: false, code: gate.code, reason: gate.reason, receivedBytes: 0 };
  }

  if (input.restart === true) store.discardTemp(entry.id);
  const offset = store.tempBytes(entry.id);
  const hasher = new IncrementalSha256();
  if (offset > 0) {
    store.readTemp(entry.id, (chunk) => hasher.update(chunk));
  }
  let receivedBytes = offset;
  let totalBytes: number | null = input.expectedTotalBytes ?? null;
  const report = (): void => {
    input.onProgress?.({ receivedBytes, totalBytes });
  };
  report();

  try {
    // NOTE: the authoritative total is only known once the transport
    // resolves, so progress during streaming carries the earlier total (or
    // null); a final report follows with the authoritative count.
    const { totalBytes: authoritativeTotal } = await transport.download(
      url,
      offset,
      (chunk) => {
        throwIfCancelled(input.control);
        store.appendTemp(entry.id, chunk);
        hasher.update(chunk);
        receivedBytes += chunk.length;
        report();
      },
    );
    totalBytes = authoritativeTotal;
    report();
  } catch (error) {
    if (error instanceof TransferCancelledError) {
      return {
        ok: false,
        code: "CANCELLED",
        reason: "Download cancelled. The staged prefix is kept — resume to continue.",
        receivedBytes,
      };
    }
    return {
      ok: false,
      code: "TRANSPORT_ERROR",
      reason: `Download interrupted: ${error instanceof Error ? error.message : "transport failed"}. The staged prefix is kept — resume to continue.`,
      receivedBytes,
    };
  }

  if (totalBytes == null) {
    return {
      ok: false,
      code: "TRANSPORT_ERROR",
      reason: "Download interrupted: transport reported no total byte count.",
      receivedBytes,
    };
  }
  const discardCorrupt = (code: TransferErrorCode, reason: string): TransferFailure & { readonly receivedBytes: number } => {
    store.discardTemp(entry.id);
    return { ok: false, code, reason, receivedBytes };
  };
  if (input.expectedTotalBytes != null && input.expectedTotalBytes !== totalBytes) {
    return discardCorrupt(
      "SIZE_MISMATCH",
      "Artifact changed during resume: the total byte count no longer matches the earlier attempt. The staged prefix was discarded; restart.",
    );
  }
  if (receivedBytes !== totalBytes) {
    return discardCorrupt(
      "SIZE_MISMATCH",
      `Truncated download: received ${receivedBytes} of ${totalBytes} bytes. The staged prefix was discarded; restart.`,
    );
  }
  if (entry.downloadBytes != null && totalBytes !== entry.downloadBytes) {
    return discardCorrupt(
      "SIZE_MISMATCH",
      `Byte-count mismatch: received ${totalBytes} bytes but the catalogue pins ${entry.downloadBytes}. The staged prefix was discarded; restart.`,
    );
  }

  if (hasher.digestHex() !== entry.sha256) {
    return discardCorrupt(
      "HASH_MISMATCH",
      "Hash mismatch: downloaded bytes do not match the shipped catalogue pin. The staged prefix was discarded; no partial install.",
    );
  }
  store.commitTemp(entry.id);
  const installed = store.installedBytes(entry.id) ?? totalBytes;
  return { ok: true, installedBytes: installed, totalBytes };
}

/** One entry visible in a package container (ZIP central directory, …). */
export interface ArchiveEntry {
  readonly path: string;
  readonly size: number;
  readonly isSymlink?: boolean;
}

/**
 * Streaming platform archive seam (ZIP framing in production). Entry bytes
 * are consumed as a single-pass chunk stream — never buffered whole.
 */
export interface StreamingArchive {
  readonly entries: readonly ArchiveEntry[];
  openEntry(path: string): AsyncIterable<Uint8Array>;
}

export type ImportResult =
  | { readonly ok: true; readonly manifest: FbmodelManifest }
  | TransferFailure;

export interface ImportStreamOptions {
  /**
   * Whole-package SHA-256 hex computed incrementally by the caller during
   * download (never a buffered copy). Verified against the shipped catalogue
   * pin — never against values from inside the package under test.
   */
  rawPackageSha256?: string;
  /** Cooperative cancellation; partial validation state is discarded. */
  control?: TransferControl;
  /** Passively observed free bytes, or null when unknown (never gating alone). */
  freeBytes?: number | null;
  /** Bytes the install needs when known (declared total, else null). */
  requiredBytes?: number | null;
  /** Test-only override for the expanded-size cap (small-fixture bombs). */
  maxExpandedBytes?: number | null;
}

function fail(code: TransferErrorCode, reason: string): TransferFailure {
  return { ok: false, code, reason };
}

function isManifestFile(value: unknown): value is FbmodelManifestFile {
  if (typeof value !== "object" || value === null) return false;
  const file = value as Record<string, unknown>;
  return (
    typeof file["path"] === "string" &&
    typeof file["bytes"] === "number" &&
    typeof file["sha256"] === "string" &&
    (file["method"] === "STORE" || file["method"] === "DEFLATE")
  );
}

function parseManifest(raw: Uint8Array): FbmodelManifest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const manifest = parsed as Record<string, unknown>;
  if (manifest["packageVersion"] !== FBMODEL_PACKAGE_VERSION) return null;
  if (typeof manifest["entryId"] !== "string") return null;
  const upstream = manifest["upstream"] as Record<string, unknown> | undefined;
  if (
    typeof upstream !== "object" ||
    upstream === null ||
    typeof upstream["repo"] !== "string" ||
    typeof upstream["rev"] !== "string" ||
    typeof upstream["file"] !== "string"
  ) {
    return null;
  }
  if (typeof manifest["createdAt"] !== "string") return null;
  if (!Array.isArray(manifest["files"]) || manifest["files"].length === 0) {
    return null;
  }
  if (!manifest["files"].every(isManifestFile)) return null;
  return parsed as FbmodelManifest;
}

async function readBounded(
  chunks: AsyncIterable<Uint8Array>,
  cap: number,
): Promise<Uint8Array | null> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of chunks) {
    total += chunk.length;
    if (total > cap) return null;
    parts.push(chunk);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Validates a `.fbmodel` package against a catalogue entry, streaming every
 * file. Checks the manifest allow-list, the exact interior file set
 * (anything unlisted is rejected), safe confined paths, the executable ban
 * (suffix + magic sniff on the stream head), declared-vs-actual sizes with
 * an expanded-size cap enforced incrementally, and per-file SHA-256 via an
 * incremental hash. When `rawPackageSha256` is supplied and the entry
 * carries a shipped pin, the whole package hash is additionally verified
 * against the catalogue pin (never against values from inside the package
 * under test).
 */
export async function importPackageStream(
  entry: ModelCatalogueEntry,
  archive: StreamingArchive,
  options?: ImportStreamOptions,
): Promise<ImportResult> {
  const manifestEntry = archive.entries.find(
    (candidate) => candidate.path === FBMODEL_MANIFEST_NAME,
  );
  if (manifestEntry == null) {
    return fail("MANIFEST_MISSING", "Package has no manifest.json.");
  }
  if (manifestEntry.isSymlink === true) {
    return fail("UNSAFE_PATH", "Symlink entry rejected: manifest.json.");
  }
  try {
    throwIfCancelled(options?.control);
  } catch {
    return fail(
      "CANCELLED",
      "Import cancelled before validation. Nothing installed.",
    );
  }
  let manifestRaw: Uint8Array | null;
  try {
    manifestRaw = await readBounded(
      archive.openEntry(FBMODEL_MANIFEST_NAME),
      MAX_MANIFEST_BYTES,
    );
  } catch (error) {
    if (error instanceof TransferCancelledError) {
      return fail(
        "CANCELLED",
        "Import cancelled. Nothing installed.",
      );
    }
    return fail(
      "CORRUPT_ARCHIVE",
      "Package container is unreadable: the manifest entry cannot be opened.",
    );
  }
  if (manifestRaw == null) {
    return fail(
      "MANIFEST_INVALID",
      "manifest.json exceeds the manifest size bound.",
    );
  }
  const manifest = parseManifest(manifestRaw);
  if (manifest == null) {
    return fail(
      "MANIFEST_INVALID",
      "manifest.json is malformed or not package schema v1.",
    );
  }
  if (manifest.entryId !== entry.id) {
    return fail(
      "ENTRY_MISMATCH",
      `Package entry ${manifest.entryId} does not match catalogue entry ${entry.id}.`,
    );
  }

  for (const file of manifest.files) {
    const unsafe = findUnsafePathReason(file.path);
    if (unsafe != null) {
      return fail("UNSAFE_PATH", `Manifest lists an unsafe path: ${unsafe}.`);
    }
    if (isFbmodelDeniedSuffix(file.path)) {
      return fail(
        "DENIED_FILE",
        `Package lists a denied executable path: ${file.path}.`,
      );
    }
  }

  const manifestPaths = new Set(manifest.files.map((file) => file.path));
  for (const listed of manifest.files) {
    const present = archive.entries.find(
      (candidate) => candidate.path === listed.path,
    );
    if (present == null) {
      return fail("MISSING_FILE", `Manifest-listed file missing: ${listed.path}.`);
    }
    if (present.isSymlink === true) {
      return fail("UNSAFE_PATH", `Symlink entry rejected: ${listed.path}.`);
    }
  }
  for (const candidate of archive.entries) {
    if (candidate.path === FBMODEL_MANIFEST_NAME) continue;
    if (!manifestPaths.has(candidate.path)) {
      return fail(
        "EXTRA_FILE",
        `Unlisted interior file rejected: ${candidate.path}.`,
      );
    }
    if (candidate.isSymlink === true) {
      return fail("UNSAFE_PATH", `Symlink entry rejected: ${candidate.path}.`);
    }
    const unsafe = findUnsafePathReason(candidate.path);
    if (unsafe != null) {
      return fail("UNSAFE_PATH", `Unsafe interior path: ${unsafe}.`);
    }
  }

  const cap = options?.maxExpandedBytes ?? MAX_PACKAGE_EXPANDED_BYTES;
  const declaredTotal = manifest.files.reduce((sum, file) => sum + file.bytes, 0);
  if (declaredTotal > cap) {
    return fail(
      "PACKAGE_TOO_LARGE",
      `Declared package size ${declaredTotal} bytes exceeds the ${cap}-byte cap.`,
    );
  }
  const requiredBytes = options?.requiredBytes ?? declaredTotal;
  if (
    options?.freeBytes != null &&
    requiredBytes != null &&
    requiredBytes > options.freeBytes
  ) {
    return fail(
      "INSUFFICIENT_STORAGE",
      `Not enough free storage: the install needs ${requiredBytes} bytes but only ${options.freeBytes} are free. Nothing installed.`,
    );
  }

  let expandedTotal = 0;
  for (const file of manifest.files) {
    const hasher = new IncrementalSha256();
    const head: number[] = [];
    let headChecked = false;
    let actualBytes = 0;
    try {
      throwIfCancelled(options?.control);
      for await (const chunk of archive.openEntry(file.path)) {
        throwIfCancelled(options?.control);
        actualBytes += chunk.length;
        if (actualBytes > file.bytes) {
          return fail(
            "SIZE_MISMATCH",
            `Declared-vs-actual size mismatch for ${file.path}: exceeds manifest-declared ${file.bytes} bytes.`,
          );
        }
        expandedTotal += chunk.length;
        if (expandedTotal > cap) {
          return fail(
            "PACKAGE_TOO_LARGE",
            `Expanded package size exceeds the ${cap}-byte cap.`,
          );
        }
        hasher.update(chunk);
        if (!headChecked) {
          for (const byte of chunk) {
            if (head.length < 4) head.push(byte);
            else break;
          }
          if (head.length === 4) {
            headChecked = true;
            if (hasDeniedMagic(new Uint8Array(head))) {
              return fail(
                "DENIED_FILE",
                `Executable content rejected: ${file.path}.`,
              );
            }
          }
        }
      }
    } catch (error) {
      if (error instanceof TransferCancelledError) {
        return fail("CANCELLED", "Import cancelled. Nothing installed.");
      }
      return fail(
        "CORRUPT_ARCHIVE",
        `Package container is unreadable: interior entry ${file.path} cannot be streamed (truncated or corrupted container). Nothing installed.`,
      );
    }
    if (actualBytes !== file.bytes) {
      return fail(
        "SIZE_MISMATCH",
        `Declared-vs-actual size mismatch for ${file.path}: manifest says ${file.bytes}, read ${actualBytes}.`,
      );
    }
    if (!headChecked && hasDeniedMagic(new Uint8Array(head))) {
      return fail("DENIED_FILE", `Executable content rejected: ${file.path}.`);
    }
    if (hasher.digestHex() !== file.sha256) {
      return fail(
        "HASH_MISMATCH",
        `Checksum mismatch for ${file.path}: does not match the manifest pin.`,
      );
    }
  }

  if (options?.rawPackageSha256 != null && entry.sha256 != null) {
    if (options.rawPackageSha256 !== entry.sha256) {
      return fail(
        "WHOLE_HASH_MISMATCH",
        "Whole-package hash does not match the shipped catalogue pin.",
      );
    }
  }

  return { ok: true, manifest };
}

/** One installed file offered for export (interior path + declared size). */
export interface InstalledFileRef {
  readonly path: string;
  readonly size: number;
}

/**
 * Streaming source of installed bytes (platform file store in production).
 * Reads are single-pass chunk streams — never buffered whole.
 */
export interface InstalledFileReader {
  readonly files: readonly InstalledFileRef[];
  openRead(path: string): AsyncIterable<Uint8Array>;
}

/**
 * Streaming archive writer seam (ZIP framing in production). The writer
 * persists each file's chunks; the exporter observes sizes and hashes
 * while streaming and builds the manifest afterwards.
 */
export interface PackageWriter {
  writeFile(
    file: { path: string; method: FbmodelCompressionMethod },
    chunks: AsyncIterable<Uint8Array>,
  ): Promise<void>;
  /** Discards a partially written file after a failed export, if supported. */
  discardFile?(path: string): Promise<void>;
}

export type ExportStreamResult =
  | {
      readonly ok: true;
      readonly manifest: FbmodelManifest;
      /** Serialized checksums.json content (DEFLATE per compression policy). */
      readonly checksumsJson: string;
    }
  | TransferFailure;

function compressionMethodFor(path: string): FbmodelCompressionMethod {
  if (path.startsWith("weights/") || path.startsWith("projector/")) {
    return "STORE";
  }
  return "DEFLATE";
}

export interface ExportStreamOptions {
  createdAt?: string;
  /** Cooperative cancellation; a partially written file is discarded. */
  control?: TransferControl;
  /** Passively observed free bytes, or null when unknown (never gating alone). */
  freeBytes?: number | null;
  /** Bytes the package needs when known (declared total, else null). */
  requiredBytes?: number | null;
  /** Test-only override for the expanded-size cap (small-fixture bombs). */
  maxExpandedBytes?: number | null;
}

/**
 * Packages installed files into a shareable offline `.fbmodel` interior for
 * a catalogue entry, streaming every file through the archive writer.
 * Applies the import-side validation up front so only data-only packages
 * can be produced; requires at least one `weights/` runtime artifact per
 * the package layout. Returns the manifest + checksums — the file bytes
 * live with the writer, never in the result.
 */
export async function exportPackageStream(
  entry: ModelCatalogueEntry,
  reader: InstalledFileReader,
  writer: PackageWriter,
  options?: ExportStreamOptions,
): Promise<ExportStreamResult> {
  if (entry.catalogOnly === true) {
    return fail(
      "NOT_INSTALLABLE",
      "Catalog reference only: reference listings are never packaged.",
    );
  }
  if (reader.files.length === 0) {
    return fail("NO_FILES", "Nothing to package: no installed files supplied.");
  }
  if (!reader.files.some((file) => file.path.startsWith("weights/"))) {
    return fail(
      "MISSING_WEIGHTS",
      "Package requires at least one weights/ runtime artifact.",
    );
  }
  for (const file of reader.files) {
    const unsafe = findUnsafePathReason(file.path);
    if (unsafe != null) {
      return fail("UNSAFE_PATH", `Unsafe installed path: ${unsafe}.`);
    }
    if (isFbmodelDeniedSuffix(file.path)) {
      return fail("DENIED_FILE", `Executable content rejected: ${file.path}.`);
    }
  }

  const exportCap = options?.maxExpandedBytes ?? MAX_PACKAGE_EXPANDED_BYTES;
  const exportRequired = options?.requiredBytes ?? reader.files.reduce((sum, file) => sum + file.size, 0);
  if (
    options?.freeBytes != null &&
    exportRequired != null &&
    exportRequired > options.freeBytes
  ) {
    return fail(
      "INSUFFICIENT_STORAGE",
      `Not enough free storage: packaging needs ${exportRequired} bytes but only ${options.freeBytes} are free. Nothing written.`,
    );
  }

  const manifestFiles: FbmodelManifestFile[] = [];
  let expandedTotal = 0;
  for (const file of reader.files) {
    const method = compressionMethodFor(file.path);
    const hasher = new IncrementalSha256();
    const head: number[] = [];
    let headChecked = false;
    let observedBytes = 0;
    let denied = false;
    async function* tapped(): AsyncGenerator<Uint8Array> {
      for await (const chunk of reader.openRead(file.path)) {
        throwIfCancelled(options?.control);
        observedBytes += chunk.length;
        hasher.update(chunk);
        if (!headChecked) {
          for (const byte of chunk) {
            if (head.length < 4) head.push(byte);
            else break;
          }
          if (head.length === 4) {
            headChecked = true;
            if (hasDeniedMagic(new Uint8Array(head))) denied = true;
          }
        }
        yield chunk;
      }
    }
    try {
      throwIfCancelled(options?.control);
      await writer.writeFile({ path: file.path, method }, tapped());
    } catch (error) {
      await writer.discardFile?.(file.path);
      if (error instanceof TransferCancelledError) {
        return fail("CANCELLED", "Export cancelled. Partial output discarded.");
      }
      return fail(
        "CORRUPT_ARCHIVE",
        `Export interrupted for ${file.path}: the package writer failed. Partial output discarded.`,
      );
    }
    if (denied || (!headChecked && hasDeniedMagic(new Uint8Array(head)))) {
      await writer.discardFile?.(file.path);
      return fail("DENIED_FILE", `Executable content rejected: ${file.path}.`);
    }
    if (observedBytes !== file.size) {
      await writer.discardFile?.(file.path);
      return fail(
        "SIZE_MISMATCH",
        `Installed size changed during export for ${file.path}: listed ${file.size}, read ${observedBytes}.`,
      );
    }
    expandedTotal += observedBytes;
    if (expandedTotal > exportCap) {
      await writer.discardFile?.(file.path);
      return fail(
        "PACKAGE_TOO_LARGE",
        `Expanded package size exceeds the ${exportCap}-byte cap.`,
      );
    }
    manifestFiles.push({
      path: file.path,
      bytes: observedBytes,
      sha256: hasher.digestHex(),
      method,
    });
  }

  const manifest: FbmodelManifest = {
    packageVersion: FBMODEL_PACKAGE_VERSION,
    entryId: entry.id,
    upstream: {
      repo: entry.upstreamRepo,
      rev: entry.revision,
      file: entry.upstreamFile ?? "",
    },
    createdAt: options?.createdAt ?? new Date().toISOString(),
    files: manifestFiles,
  };
  const checksumsJson = JSON.stringify(
    {
      entryId: entry.id,
      files: manifestFiles.map((file) => ({
        path: file.path,
        sha256: file.sha256,
      })),
    },
    null,
    2,
  );
  const encoder = new TextEncoder();
  const checksumsBytes = encoder.encode(checksumsJson);
  // The checksum sidecar is itself a manifest-listed interior file (the
  // manifest alone is the envelope exception: it cannot list itself).
  // Anything unlisted is rejected on import, so the sidecar must be pinned.
  manifestFiles.push({
    path: FBMODEL_CHECKSUMS_NAME,
    bytes: checksumsBytes.length,
    sha256: sha256HexOfBytes(checksumsBytes),
    method: "DEFLATE",
  });
  async function* single(chunk: Uint8Array): AsyncGenerator<Uint8Array> {
    yield chunk;
  }
  try {
    await writer.writeFile(
      { path: FBMODEL_CHECKSUMS_NAME, method: "DEFLATE" },
      single(checksumsBytes),
    );
    await writer.writeFile(
      { path: FBMODEL_MANIFEST_NAME, method: "DEFLATE" },
      single(encoder.encode(JSON.stringify(manifest, null, 2))),
    );
  } catch (error) {
    await writer.discardFile?.(FBMODEL_MANIFEST_NAME);
    if (error instanceof TransferCancelledError) {
      return fail("CANCELLED", "Export cancelled. Partial output discarded.");
    }
    return fail(
      "CORRUPT_ARCHIVE",
      "Export interrupted while writing the package envelope. Partial output discarded.",
    );
  }
  return { ok: true, manifest, checksumsJson };
}
