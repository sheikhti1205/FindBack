/**
 * Curated Model Library transfers: gated download, package import, package export.
 *
 * Pure orchestration + validation over injected platform seams — no fetching,
 * no ZIP framing, no storage side effects, no UI. The platform layer supplies
 * a `DownloadTransport` (HTTP Range) and a `PackageArchive` (ZIP entries);
 * this module decides gating, verifies hashes against the shipped catalogue
 * pins, and enforces the data-only package invariants from
 * `docs/specs/model-library/fbmodel-package.md` and the threat constraints
 * from `docs/specs/model-library/threat-surface.md`.
 *
 * Download: advisory RAM-envelope gate via `ramPolicy` (never auto-downloads;
 * a triggered gate blocks unless the caller passes an explicitly recorded
 * `advancedConfirmed`), resumable via byte offset, hash-verified against the
 * shipped `sha256` pin. A failed download returns an error — partial bytes
 * are never reported as installed.
 *
 * Import: validates a `.fbmodel` interior against the catalogue entry —
 * manifest allow-list, exact file set, per-file SHA-256, declared-vs-actual
 * sizes, expanded-size cap, safe paths, symlink rejection, and the
 * executable ban (suffix AND content sniff).
 *
 * Export: assembles a shareable offline package interior (manifest +
 * checksums + files) from installed files, applying the same validation so
 * only data-only packages can be produced.
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

/** Machine-readable transfer failure codes (advisory data, never UI). */
export type TransferErrorCode =
  | "NOT_INSTALLABLE"
  | "NEEDS_ADVANCED_CONFIRM"
  | "MISSING_PIN"
  | "TRANSPORT_ERROR"
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
  | "NO_FILES";

export interface TransferFailure {
  readonly ok: false;
  readonly code: TransferErrorCode;
  /** Human-readable advisory note (presentation layer decides display). */
  readonly reason: string;
}

/**
 * Synchronous SHA-256 hex over bytes. Pure TypeScript (WebView-safe: no
 * `node:crypto`, no async subtle-crypto); byte-input twin of the string
 * hash in `services/diag.ts`.
 */
export function sha256BytesHex(input: Uint8Array): string {
  const bitLenHi = Math.floor((input.length * 8) / 2 ** 32);
  const bitLenLo = (input.length * 8) >>> 0;
  const paddedLen = (((input.length + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(paddedLen);
  padded.set(input);
  padded[input.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLen - 8, bitLenHi, false);
  view.setUint32(paddedLen - 4, bitLenLo, false);

  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Array<number>(64);
  const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < paddedLen; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 =
        rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 =
        rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i]! + w[i]!) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
    h5 = (h5 + f) | 0;
    h6 = (h6 + g) | 0;
    h7 = (h7 + h) | 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((x) => (x >>> 0).toString(16).padStart(8, "0"))
    .join("");
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
 * detect a changed artifact mid-flight.
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

export interface DownloadInput extends DownloadGateInput {
  /** Previously received prefix for resume (byte-exact continuation). */
  resumeFrom?: { received: Uint8Array; totalBytes: number };
  onProgress?: (progress: DownloadProgress) => void;
}

export type DownloadResult =
  | { readonly ok: true; readonly bytes: Uint8Array; readonly totalBytes: number }
  | (TransferFailure & { readonly receivedBytes: number });

function concatBytes(parts: Uint8Array[], totalLength: number): Uint8Array {
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Gated, resumable, hash-verified download. Returns the complete verified
 * bytes; any failure (gate, transport, size, hash) returns an error and the
 * bytes must be discarded — never treated as installed.
 */
export async function downloadModel(
  entry: ModelCatalogueEntry,
  url: string,
  transport: DownloadTransport,
  input: DownloadInput,
): Promise<DownloadResult> {
  const gate = checkDownloadGate(entry, input);
  if (!gate.allowed) {
    return { ok: false, code: gate.code, reason: gate.reason, receivedBytes: 0 };
  }

  const prefix = input.resumeFrom?.received ?? new Uint8Array(0);
  const resumedTotal = input.resumeFrom?.totalBytes ?? null;
  const parts: Uint8Array[] = prefix.length > 0 ? [prefix] : [];
  let receivedBytes = prefix.length;
  let totalBytes: number | null = resumedTotal;
  const report = (): void => {
    input.onProgress?.({ receivedBytes, totalBytes });
  };
  report();

  try {
    // NOTE: the authoritative total is only known once the transport
    // resolves, so progress during streaming carries the resumed total (or
    // null); a final report follows with the authoritative count.
    const { totalBytes: authoritativeTotal } = await transport.download(
      url,
      prefix.length,
      (chunk) => {
        parts.push(chunk);
        receivedBytes += chunk.length;
        report();
      },
    );
    totalBytes = authoritativeTotal;
    report();
  } catch (error) {
    return {
      ok: false,
      code: "TRANSPORT_ERROR",
      reason: `Download interrupted: ${error instanceof Error ? error.message : "transport failed"}.`,
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
  if (resumedTotal != null && resumedTotal !== totalBytes) {
    return {
      ok: false,
      code: "SIZE_MISMATCH",
      reason:
        "Artifact changed during resume: the total byte count no longer matches the earlier attempt. Discard the prefix and restart.",
      receivedBytes,
    };
  }
  if (receivedBytes !== totalBytes) {
    return {
      ok: false,
      code: "SIZE_MISMATCH",
      reason: `Truncated download: received ${receivedBytes} of ${totalBytes} bytes.`,
      receivedBytes,
    };
  }
  if (entry.downloadBytes != null && totalBytes !== entry.downloadBytes) {
    return {
      ok: false,
      code: "SIZE_MISMATCH",
      reason: `Byte-count mismatch: received ${totalBytes} bytes but the catalogue pins ${entry.downloadBytes}.`,
      receivedBytes,
    };
  }

  const bytes = concatBytes(parts, receivedBytes);
  if (sha256BytesHex(bytes) !== entry.sha256) {
    return {
      ok: false,
      code: "HASH_MISMATCH",
      reason:
        "Hash mismatch: downloaded bytes do not match the shipped catalogue pin. Discard the bytes; no partial install.",
      receivedBytes,
    };
  }
  return { ok: true, bytes, totalBytes };
}

/** One entry visible in a package container (ZIP central directory, …). */
export interface ArchiveEntry {
  readonly path: string;
  readonly size: number;
  readonly isSymlink?: boolean;
}

/** Platform archive seam (ZIP framing in production). */
export interface PackageArchive {
  readonly entries: readonly ArchiveEntry[];
  readEntry(path: string): Promise<Uint8Array> | Uint8Array;
}

export type ImportResult =
  | { readonly ok: true; readonly manifest: FbmodelManifest }
  | TransferFailure;

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

/**
 * Validates a `.fbmodel` package against a catalogue entry. Checks the
 * manifest allow-list, the exact interior file set (anything unlisted is
 * rejected), safe confined paths, the executable ban (suffix + magic
 * sniff), declared-vs-actual sizes with an expanded-size cap, and per-file
 * SHA-256 against the manifest. When `rawPackageBytes` is supplied and the
 * entry carries a shipped pin, the whole package hash is additionally
 * verified against the catalogue pin (never against values from inside the
 * package under test).
 */
export async function importPackage(
  entry: ModelCatalogueEntry,
  archive: PackageArchive,
  options?: { rawPackageBytes?: Uint8Array },
): Promise<ImportResult> {
  const manifestEntry = archive.entries.find(
    (candidate) => candidate.path === FBMODEL_MANIFEST_NAME,
  );
  if (manifestEntry == null) {
    return fail("MANIFEST_MISSING", "Package has no manifest.json.");
  }
  const manifest = parseManifest(await archive.readEntry(FBMODEL_MANIFEST_NAME));
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

  const declaredTotal = manifest.files.reduce((sum, file) => sum + file.bytes, 0);
  if (declaredTotal > MAX_PACKAGE_EXPANDED_BYTES) {
    return fail(
      "PACKAGE_TOO_LARGE",
      `Declared package size ${declaredTotal} bytes exceeds the ${MAX_PACKAGE_EXPANDED_BYTES}-byte cap.`,
    );
  }

  let expandedTotal = 0;
  for (const file of manifest.files) {
    const bytes = await archive.readEntry(file.path);
    if (bytes.length !== file.bytes) {
      return fail(
        "SIZE_MISMATCH",
        `Declared-vs-actual size mismatch for ${file.path}: manifest says ${file.bytes}, read ${bytes.length}.`,
      );
    }
    expandedTotal += bytes.length;
    if (expandedTotal > MAX_PACKAGE_EXPANDED_BYTES) {
      return fail(
        "PACKAGE_TOO_LARGE",
        `Expanded package size exceeds the ${MAX_PACKAGE_EXPANDED_BYTES}-byte cap.`,
      );
    }
    if (isFbmodelDeniedSuffix(file.path) || hasDeniedMagic(bytes)) {
      return fail(
        "DENIED_FILE",
        `Executable content rejected: ${file.path}.`,
      );
    }
    if (sha256BytesHex(bytes) !== file.sha256) {
      return fail(
        "HASH_MISMATCH",
        `Checksum mismatch for ${file.path}: does not match the manifest pin.`,
      );
    }
  }

  if (options?.rawPackageBytes != null && entry.sha256 != null) {
    if (sha256BytesHex(options.rawPackageBytes) !== entry.sha256) {
      return fail(
        "WHOLE_HASH_MISMATCH",
        "Whole-package hash does not match the shipped catalogue pin.",
      );
    }
  }

  return { ok: true, manifest };
}

/** One installed file offered for export (interior path + exact bytes). */
export interface InstalledFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

/** One file of the assembled package interior handed to the ZIP writer. */
export interface PackageFile {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly method: FbmodelCompressionMethod;
}

export type ExportResult =
  | {
      readonly ok: true;
      readonly manifest: FbmodelManifest;
      /** Serialized checksums.json content (DEFLATE per compression policy). */
      readonly checksumsJson: string;
      /** Full interior set: manifest + checksums + supplied files. */
      readonly packageFiles: readonly PackageFile[];
    }
  | TransferFailure;

function compressionMethodFor(path: string): FbmodelCompressionMethod {
  if (path.startsWith("weights/") || path.startsWith("projector/")) {
    return "STORE";
  }
  return "DEFLATE";
}

/**
 * Packages installed files into a shareable offline `.fbmodel` interior for
 * a catalogue entry. Applies the import-side validation up front so only
 * data-only packages can be produced; requires at least one `weights/`
 * runtime artifact per the package layout.
 */
export function exportPackage(
  entry: ModelCatalogueEntry,
  files: readonly InstalledFile[],
  options?: { createdAt?: string },
): ExportResult {
  if (entry.catalogOnly === true) {
    return fail(
      "NOT_INSTALLABLE",
      "Catalog reference only: reference listings are never packaged.",
    );
  }
  if (files.length === 0) {
    return fail("NO_FILES", "Nothing to package: no installed files supplied.");
  }
  if (!files.some((file) => file.path.startsWith("weights/"))) {
    return fail(
      "MISSING_WEIGHTS",
      "Package requires at least one weights/ runtime artifact.",
    );
  }
  for (const file of files) {
    const unsafe = findUnsafePathReason(file.path);
    if (unsafe != null) {
      return fail("UNSAFE_PATH", `Unsafe installed path: ${unsafe}.`);
    }
    if (isFbmodelDeniedSuffix(file.path) || hasDeniedMagic(file.bytes)) {
      return fail("DENIED_FILE", `Executable content rejected: ${file.path}.`);
    }
  }

  const encoder = new TextEncoder();
  const manifestFiles: FbmodelManifestFile[] = files.map((file) => ({
    path: file.path,
    bytes: file.bytes.length,
    sha256: sha256BytesHex(file.bytes),
    method: compressionMethodFor(file.path),
  }));
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
  const packageFiles: PackageFile[] = [
    {
      path: FBMODEL_MANIFEST_NAME,
      bytes: encoder.encode(JSON.stringify(manifest, null, 2)),
      method: "DEFLATE",
    },
    {
      path: FBMODEL_CHECKSUMS_NAME,
      bytes: encoder.encode(checksumsJson),
      method: "DEFLATE",
    },
    ...files.map((file) => ({
      path: file.path,
      bytes: file.bytes,
      method: compressionMethodFor(file.path),
    })),
  ];
  return { ok: true, manifest, checksumsJson, packageFiles };
}
