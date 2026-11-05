/**
 * First-failing-boundary receipts for the local search helper.
 *
 * S6: a local failure has to name WHERE it stopped — helper availability,
 * plugin/ABI, storage, source/redirect/resume, hash, promotion, runtime load,
 * structured output — so the reader gets a recovery that can actually work and
 * the app never reports "no confident filters" for an engine that never ran.
 *
 * This module is the single mapping from internal error identity to a bounded,
 * consumer-safe receipt. It carries an allowlisted code token and a stage; raw
 * messages, paths, model ids and signed URLs never leave the service layer.
 */

export type LocalSearchStage =
  /** Helper not installed/verified, or boot reconciliation never completed. */
  | "helper"
  /** Native plugin registration, platform or ABI. */
  | "plugin"
  /** Model root unreadable, or not enough free space. */
  | "storage"
  /** HTTPS source, redirect or resume. */
  | "source"
  /** Checksum, size or manifest pin. */
  | "hash"
  /** Atomic promote or journal commit. */
  | "promotion"
  /** Native/JNI load or inference. */
  | "runtime"
  /** Structured-output validation. */
  | "output"
  /** Another operation owns the helper right now. */
  | "busy";

export interface LocalSearchFailure {
  readonly stage: LocalSearchStage;
  readonly code: string;
}

/** Only these tokens are ever shown/derived; a new one must be mapped here. */
const STAGE_BY_CODE: Readonly<Record<string, LocalSearchStage>> = {
  // Readiness / gate
  UNKNOWN_MODEL: "helper",
  ALREADY_INSTALLED: "helper",
  NOT_USER_INITIATED: "helper",
  MODEL_NOT_READY: "helper",
  MODEL_UNAVAILABLE: "helper",
  NO_RUNTIME: "helper",
  // Platform
  DRIVER_UNAVAILABLE: "plugin",
  UNSUPPORTED_REQUEST: "plugin",
  // Storage
  INSUFFICIENT_STORAGE: "storage",
  LOW_MEMORY: "storage",
  // Transfer
  BAD_SOURCE: "source",
  TIMEOUT: "source",
  NETWORK_ERROR: "source",
  DOWNLOAD_FAILED: "source",
  HTTP_ERROR: "source",
  OFFSET_MISMATCH: "source",
  REDIRECT_NON_HTTPS: "source",
  TOO_MANY_REDIRECTS: "source",
  // Pin / integrity
  MISSING_PIN: "hash",
  MANIFEST_MISMATCH: "hash",
  BAD_MANIFEST: "hash",
  LICENSE_MISMATCH: "hash",
  CHECKSUM_MISMATCH: "hash",
  SIZE_MISMATCH: "hash",
  BYTE_BOUND_EXCEEDED: "hash",
  MODEL_CORRUPT: "hash",
  // Install
  PROMOTE_FAILED: "promotion",
  ILLEGAL_TRANSITION: "promotion",
  // Runtime
  ALREADY_RUNNING: "busy",
  RUNTIME_ERROR: "runtime",
  // Output
  INVALID_OUTPUT: "output",
  LOCAL_TASK_INVALID: "output",
  NO_TASK_CONTRACT: "output",
  UNSUPPORTED_ACTION: "output",
};

/**
 * Un-coded throws (service-level `new Error(...)`) are matched by their
 * consumer-safe message. Ordered: the first match wins, so the more specific
 * truth is checked before the generic one.
 */
const STAGE_BY_MESSAGE: readonly (readonly [RegExp, LocalSearchStage])[] = [
  [/requires the Android app|native download bridge/i, "plugin"],
  [/unavailable on this device|incompatible/i, "plugin"],
  [/not installed|not resident|needs the local search helper|no qualified on-device/i, "helper"],
  [/busy|in use|already running|already downloading/i, "busy"],
  [/not enough free storage|free space|free_bytes|out of space/i, "storage"],
  [/storage could not be verified|could not be read|model storage is unavailable/i, "storage"],
  [/promot/i, "promotion"],
  [/checksum|verification|did not match the exact expected size|size mismatch/i, "hash"],
  [/\bhttps?\b|http_|network|source|interrupted|transfer/i, "source"],
  [/confident|invalid|structured|could not produce/i, "output"],
];

function recordOf(error: unknown): Record<string, unknown> {
  return typeof error === "object" && error !== null ? error as Record<string, unknown> : {};
}

function tokenOf(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{1,60}$/.test(value) ? value : undefined;
}

const ABORT_NAMES = new Set(["AbortError"]);
const ABORT_CODES = new Set(["CANCELLED", "ABORTED"]);

/** A cancelled attempt is not a failure receipt: callers drop it silently. */
export function isLocalSearchAbort(error: unknown): boolean {
  const record = recordOf(error);
  if (typeof record.name === "string" && ABORT_NAMES.has(record.name)) return true;
  return tokenOf(record, "denialReason") !== undefined
    ? ABORT_CODES.has(tokenOf(record, "denialReason")!)
    : ABORT_CODES.has(tokenOf(record, "code") ?? "");
}

/**
 * Umbrella codes that a specific message can refine. `RUNTIME_ERROR` covers
 * native load AND our own structured-output validation; `DOWNLOAD_FAILED` is
 * the driver's fallback for an unclassified native throw. A recognised cause
 * keeps the same code but earns the narrower stage.
 */
const GENERIC_TOKENS = new Set(["RUNTIME_ERROR", "DOWNLOAD_FAILED"]);

/** Map any service/driver/route error to one bounded receipt. Never throws. */
export function localSearchFailureOf(error: unknown): LocalSearchFailure {
  const record = recordOf(error);
  const message = typeof record.message === "string"
    ? record.message
    : typeof record.error === "string"
      ? record.error
      : typeof error === "string" ? error : "";
  const token =
    tokenOf(record, "denialReason") ??
    tokenOf(record, "errorClass") ??
    tokenOf(record, "code");

  if (token !== undefined) {
    const stage = stageForToken(token);
    // A valid token with no stage mapping is an unexpected path: keep the
    // code so it is diagnosable, and fail toward the honest generic stage.
    if (stage === undefined) return { stage: "runtime", code: token };
    if (GENERIC_TOKENS.has(token)) {
      const refined = stageByMessage(message);
      if (refined !== undefined && refined !== "runtime") return { stage: refined, code: token };
    }
    return { stage, code: token };
  }
  const byMessage = stageByMessage(message);
  if (byMessage !== undefined) return { stage: byMessage, code: byMessage.toUpperCase() };
  return { stage: "runtime", code: "UNKNOWN" };
}

function stageForToken(token: string): LocalSearchStage | undefined {
  const exact = STAGE_BY_CODE[token];
  if (exact !== undefined) return exact;
  // Native transport emits the status itself: `HTTP_404`, `HTTP_503`, …
  return /^HTTP_\d{3}$/.test(token) ? "source" : undefined;
}

function stageByMessage(message: string): LocalSearchStage | undefined {
  return STAGE_BY_MESSAGE.find(([pattern]) => pattern.test(message))?.[1];
}

/**
 * Download-row problem text → the same stage vocabulary.
 *
 * The manager stores the driver's reason (already credential-free) as
 * `lastError`; this maps it back to the boundary that produced it so the row
 * and the notice agree on what went wrong. `removal failed` keeps its own
 * dedicated state and is deliberately not a stage here.
 */
export function downloadProblemStage(problem: string | null | undefined): LocalSearchStage | null {
  if (problem === null || problem === undefined || problem === "") return null;
  if (/removal failed/i.test(problem)) return null;
  if (/checksum|verification|installed file.*missing|file is missing/i.test(problem)) return "hash";
  if (/size mismatch|did not match the exact expected size/i.test(problem)) return "hash";
  if (/promot/i.test(problem)) return "promotion";
  if (/not enough free storage|free space|free_bytes|out of space/i.test(problem)) return "storage";
  if (/storage could not be verified/i.test(problem)) return "storage";
  if (/http_|network|timeout|source|interrupted|transfer/i.test(problem)) return "source";
  if (/unavailable on this device|incompatible|native download bridge/i.test(problem)) return "plugin";
  return null;
}
