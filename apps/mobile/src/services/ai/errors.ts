/**
 * Guard error taxonomy.
 *
 * The error-class taxonomy is defined in `services/ai/types.ts`.
 * This module does NOT define a competing
 * taxonomy: it reuses `AiErrorClass` from the stable simulator
 * mapping and only attaches guard diagnostics + user-facing recovery copy.
 */
import type { AiErrorClass } from "./testing/FakeAiProvider";
import { diagnosticCodeForMode } from "./testing/FakeAiProvider";
import type { FaultMode } from "./testing/FakeAiProvider";

/** All stable guard error classes, re-exported for guard callers. */
export type { AiErrorClass };

/** User-facing recovery actions the UI may offer for a guard failure. */
export type RecoveryAction =
  | "Retry"
  | "Use another model"
  | "Continue manually"
  | "Choose a smaller model"
  | "Repair model"
  | "Delete model";

/** Recovery copy + actions for one error class. */
export interface RecoveryPlan {
  message: string;
  actions: RecoveryAction[];
}

/**
 * Exact user-facing recovery copy (stable wording fragments preserved
 * verbatim: loop "This model got stuck generating a response.",
 * low-memory "There isn't enough free memory...",
 * invalid "couldn't produce a usable answer",
 * corrupt offers Repair/Delete model).
 */
export const RECOVERY_COPY: Record<AiErrorClass, RecoveryPlan> = {
  LOOP_DETECTED: {
    message:
      "This model got stuck generating a response. Try again, use another model, or continue manually.",
    actions: ["Retry", "Use another model", "Continue manually"],
  },
  TIMEOUT: {
    message:
      "Generation timed out before the model finished. Try again, use another model, or continue manually.",
    actions: ["Retry", "Use another model", "Continue manually"],
  },
  LOW_MEMORY: {
    message:
      "There isn't enough free memory... Choose a smaller model, or continue manually.",
    actions: ["Choose a smaller model", "Continue manually"],
  },
  INVALID_OUTPUT: {
    message:
      "The model couldn't produce a usable answer. Try again, use another model, or continue manually.",
    actions: ["Retry", "Use another model", "Continue manually"],
  },
  UNSUPPORTED_REQUEST: {
    message:
      "This model declined the request. Rephrase it, use another model, or continue manually.",
    actions: ["Use another model", "Continue manually"],
  },
  UNSUPPORTED_ACTION: {
    message: "The model asked for an action this app doesn't support. Nothing was changed.",
    actions: ["Continue manually"],
  },
  MODEL_UNAVAILABLE: {
    message: "This model isn't installed. Install it, or use another model.",
    actions: ["Use another model", "Continue manually"],
  },
  MODEL_CORRUPT: {
    message: "This model file looks corrupt and can't generate. Repair it or delete it, then try again.",
    actions: ["Repair model", "Delete model"],
  },
  RUNTIME_ERROR: {
    message: "The model runtime crashed during generation. Try again or use another model.",
    actions: ["Retry", "Use another model", "Continue manually"],
  },
  CANCELLED: {
    message: "Generation cancelled.",
    actions: [],
  },
};

/**
 * Only these classes get one automatic repair/retry; everything else
 * surfaces immediately with recovery copy. CANCELLED is never retried.
 */
export function isRetryableClass(errorClass: AiErrorClass): boolean {
  return (
    errorClass === "LOOP_DETECTED" ||
    errorClass === "TIMEOUT" ||
    errorClass === "INVALID_OUTPUT" ||
    errorClass === "RUNTIME_ERROR"
  );
}

/** Guard failure carrying the stable class plus session-scoped diagnostics. */
export class GuardError extends Error {
  readonly errorClass: AiErrorClass;
  /** Simulator/root cause preserved verbatim (e.g. OOM_RUNTIME vs PRECHECK_INSUFFICIENT_MEMORY). */
  readonly diagnosticCode: string;
  readonly modelId?: string;
  readonly attempts: number;
  readonly recovery: RecoveryPlan;

  constructor(options: {
    errorClass: AiErrorClass;
    diagnosticCode: string;
    message?: string;
    modelId?: string;
    attempts?: number;
  }) {
    super(options.message ?? `${options.errorClass}: ${options.diagnosticCode}`);
    this.name = "GuardError";
    this.errorClass = options.errorClass;
    this.diagnosticCode = options.diagnosticCode;
    this.modelId = options.modelId;
    this.attempts = options.attempts ?? 1;
    this.recovery = RECOVERY_COPY[options.errorClass];
  }

  get retryable(): boolean {
    return isRetryableClass(this.errorClass);
  }
}

/** Normalize a simulator fault mode to its stable public error class. */
export function errorClassForMode(mode: FaultMode): AiErrorClass | null {
  switch (mode) {
    case "GOOD":
    case "SLOW":
    case "FENCED_JSON":
    case "PROSE_PLUS_JSON":
      return null;
    case "TIMEOUT":
      return "TIMEOUT";
    case "LOOP_SENTENCE":
    case "LOOP_PARAGRAPH":
      return "LOOP_DETECTED";
    case "EMPTY":
    case "INVALID_JSON":
    case "TRUNCATED_JSON":
      return "INVALID_OUTPUT";
    case "WRONG_ACTION":
    case "UNKNOWN_ACTION":
      return "UNSUPPORTED_ACTION";
    case "REFUSAL":
      return "UNSUPPORTED_REQUEST";
    case "OOM":
    case "LOW_MEMORY":
      return "LOW_MEMORY";
    case "RUNTIME_CRASH":
      return "RUNTIME_ERROR";
    case "MODEL_MISSING":
      return "MODEL_UNAVAILABLE";
    case "MODEL_CORRUPT":
      return "MODEL_CORRUPT";
    case "CANCELLED":
      return "CANCELLED";
    // WS-F mirror of PROPOSED_MODE_ERROR_MAP (testing/FakeAiProvider.ts):
    // delivery/integrity faults normalize to the model-health classes,
    // DISK_FULL joins resource-exhaustion LOW_MEMORY, accelerator and
    // concurrency faults are RUNTIME_ERROR, offline/unsafe requests are
    // rejected as UNSUPPORTED_REQUEST, and non-well-formed output is
    // INVALID_OUTPUT.
    case "HTTP_DROP":
      return "MODEL_UNAVAILABLE";
    case "WRONG_CONTENT_RANGE":
    case "HASH_MISMATCH":
      return "MODEL_CORRUPT";
    case "DISK_FULL":
      return "LOW_MEMORY";
    case "GPU_INIT_ERROR":
    case "NPU_ABSENT":
    case "PROCESS_DEATH":
    case "TWO_VLM_RACE":
    case "MODEL_UPDATE_DURING_INFERENCE":
      return "RUNTIME_ERROR";
    case "INVALID_UTF8":
      return "INVALID_OUTPUT";
    case "CLOUD_OFFLINE":
    case "PATH_TRAVERSAL":
      return "UNSUPPORTED_REQUEST";
  }
}

/** Build a GuardError for a simulator mode, preserving its diagnostic code. */
export function guardErrorForMode(mode: FaultMode, options?: { modelId?: string }): GuardError | null {
  const errorClass = errorClassForMode(mode);
  if (errorClass === null) return null;
  return new GuardError({ errorClass, diagnosticCode: diagnosticCodeForMode(mode), modelId: options?.modelId });
}
