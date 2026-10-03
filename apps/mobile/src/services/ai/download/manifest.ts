/**
 * WS-C model manifest validation (AI-0xx download/install transport).
 *
 * Pure TypeScript: no I/O, no network, no filesystem. Validates an
 * untrusted manifest record against 9 fail-closed rejection rules and
 * returns a normalized manifest. Every rejection is a typed
 * `ManifestValidationError` carrying a stable `code`.
 */

export const KNOWN_MODEL_RUNTIMES = ["llama-cpp", "litert-lm"] as const;
export type KnownModelRuntime = (typeof KNOWN_MODEL_RUNTIMES)[number];

/** Quantizations observed in the lab corpus (see `modelProfiles.ts`). */
export const KNOWN_MODEL_QUANTS = [
  "INT4",
  "dynamic INT4 (wi4b32_afp32)",
  "Q4_0",
  "Q8_0",
  "F16",
] as const;
export type KnownModelQuant = (typeof KNOWN_MODEL_QUANTS)[number];

export type ManifestRejectionCode =
  | "HASH_MISSING"
  | "BAD_URL_SCHEME"
  | "UNKNOWN_RUNTIME"
  | "SIZE_MISMATCH"
  | "LICENSE_MISSING"
  | "PATH_TRAVERSAL"
  | "DUPLICATE_FILE"
  | "QUANT_MISMATCH"
  | "REVISION_MISSING";

export class ManifestValidationError extends Error {
  readonly code: ManifestRejectionCode;
  readonly field?: string;

  constructor(code: ManifestRejectionCode, message: string, field?: string) {
    super(message);
    this.name = "ManifestValidationError";
    this.code = code;
    if (field !== undefined) this.field = field;
  }
}

export interface ManifestFileEntry {
  readonly path: string;
  readonly url: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  /** Optional per-file quant pin; must equal the manifest quant when set. */
  readonly quant?: string;
}

export interface ModelManifestInput {
  readonly modelId?: unknown;
  readonly revision?: unknown;
  readonly runtime?: unknown;
  readonly quant?: unknown;
  readonly license?: unknown;
  readonly files?: unknown;
  readonly totalBytes?: unknown;
}

export interface ValidatedModelManifest {
  readonly modelId: string;
  readonly revision: string;
  readonly runtime: KnownModelRuntime;
  readonly quant: string;
  readonly license: string;
  readonly files: readonly ManifestFileEntry[];
  readonly totalBytes: number;
}

function isHex64(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-fA-F]{64}$/.test(value);
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function hasTraversal(path: string): boolean {
  if (path === "") return true;
  if (path.includes("\\")) return true;
  if (path.startsWith("/")) return true;
  // Reject drive-letter / scheme-looking prefixes explicitly.
  if (/^[A-Za-z]:/.test(path)) return true;
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") return true;
  }
  return false;
}

function fail(
  code: ManifestRejectionCode,
  message: string,
  field?: string,
): never {
  throw new ManifestValidationError(code, message, field);
}

function readString(record: Record<string, unknown>, key: string): unknown {
  return record[key];
}

/**
 * Validate one manifest, throwing the first `ManifestValidationError`.
 * Field-level checks run in stable rule order so callers (and tests) see
 * deterministic codes.
 */
export function validateManifest(input: unknown): ValidatedModelManifest {
  if (typeof input !== "object" || input === null) {
    fail("REVISION_MISSING", "manifest must be an object", "manifest");
  }
  const record = input as Record<string, unknown>;

  const modelId = readString(record, "modelId");
  if (typeof modelId !== "string" || modelId.trim() === "") {
    fail("REVISION_MISSING", "manifest modelId is missing", "modelId");
  }

  const revision = readString(record, "revision");
  if (typeof revision !== "string" || revision.trim() === "") {
    fail("REVISION_MISSING", "manifest revision is missing", "revision");
  }

  const runtime = readString(record, "runtime");
  if (
    typeof runtime !== "string" ||
    !(KNOWN_MODEL_RUNTIMES as readonly string[]).includes(runtime)
  ) {
    fail(
      "UNKNOWN_RUNTIME",
      `unknown model runtime ${String(runtime)}`,
      "runtime",
    );
  }

  const quant = readString(record, "quant");
  if (
    typeof quant !== "string" ||
    quant.trim() === "" ||
    !(KNOWN_MODEL_QUANTS as readonly string[]).includes(quant)
  ) {
    fail("QUANT_MISMATCH", `unknown model quant ${String(quant)}`, "quant");
  }

  const license = readString(record, "license");
  if (typeof license !== "string" || license.trim() === "") {
    fail("LICENSE_MISSING", "manifest license is missing", "license");
  }

  const files = record["files"];
  if (!Array.isArray(files) || files.length === 0) {
    fail("SIZE_MISMATCH", "manifest must list at least one file", "files");
  }

  const seen = new Set<string>();
  const entries: ManifestFileEntry[] = [];
  for (const raw of files) {
    if (typeof raw !== "object" || raw === null) {
      fail("PATH_TRAVERSAL", "manifest file entry must be an object", "files");
    }
    const entry = raw as Record<string, unknown>;
    const path = entry["path"];
    if (typeof path !== "string" || hasTraversal(path)) {
      fail(
        "PATH_TRAVERSAL",
        `rejected unsafe file path ${String(path)}`,
        "files.path",
      );
    }
    const normalized = (path as string).toLowerCase();
    if (seen.has(normalized)) {
      fail(
        "DUPLICATE_FILE",
        `duplicate manifest file path ${path as string}`,
        "files.path",
      );
    }
    seen.add(normalized);

    const url = entry["url"];
    if (!isHttpsUrl(url)) {
      fail(
        "BAD_URL_SCHEME",
        `file ${(path as string)} must use an https URL`,
        "files.url",
      );
    }

    const sha256 = entry["sha256"];
    if (!isHex64(sha256)) {
      fail(
        "HASH_MISSING",
        `file ${(path as string)} is missing a sha256 hex pin`,
        "files.sha256",
      );
    }

    const sizeBytes = entry["sizeBytes"];
    if (
      typeof sizeBytes !== "number" ||
      !Number.isInteger(sizeBytes) ||
      sizeBytes <= 0
    ) {
      fail(
        "SIZE_MISMATCH",
        `file ${(path as string)} has an invalid sizeBytes`,
        "files.sizeBytes",
      );
    }

    const fileQuant = entry["quant"];
    if (fileQuant !== undefined && fileQuant !== quant) {
      fail(
        "QUANT_MISMATCH",
        `file ${(path as string)} quant ${String(fileQuant)} mismatches manifest quant ${quant as string}`,
        "files.quant",
      );
    }

    entries.push({
      path: path as string,
      url: url as string,
      sha256: (sha256 as string).toLowerCase(),
      sizeBytes: sizeBytes as number,
      ...(typeof fileQuant === "string" ? { quant: fileQuant } : {}),
    });
  }

  const sum = entries.reduce((acc, entry) => acc + entry.sizeBytes, 0);
  const totalBytes = record["totalBytes"];
  if (totalBytes !== undefined) {
    if (
      typeof totalBytes !== "number" ||
      !Number.isInteger(totalBytes) ||
      totalBytes !== sum
    ) {
      fail(
        "SIZE_MISMATCH",
        `manifest totalBytes ${String(totalBytes)} mismatches file sum ${sum}`,
        "totalBytes",
      );
    }
  }

  return {
    modelId: (modelId as string).trim(),
    revision: (revision as string).trim(),
    runtime: runtime as KnownModelRuntime,
    quant: (quant as string).trim(),
    license: (license as string).trim(),
    files: entries,
    totalBytes: sum,
  };
}

/**
 * Collect every rejection instead of throwing the first. Returns the
 * normalized manifest when clean, otherwise the full error list.
 */
export function collectManifestErrors(input: unknown): {
  readonly manifest: ValidatedModelManifest | null;
  readonly errors: readonly ManifestValidationError[];
} {
  try {
    return { manifest: validateManifest(input), errors: [] };
  } catch (error) {
    if (error instanceof ManifestValidationError) {
      return { manifest: null, errors: [error] };
    }
    throw error;
  }
}
