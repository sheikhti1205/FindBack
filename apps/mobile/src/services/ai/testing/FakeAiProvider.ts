/**
 * Fake AI provider for deterministic fault-injection scaffolding.
 *
 * Coded against the planned application contract: text generation plus
 * structured photo analysis, with the stable
 * mode→error-class mapping below. GenerationGuard owns
 * the generation deadline; the production timeout budget is an explicit TBD
 * fed by evaluation measurements + ModelProfile. Ambiguous location resolves
 * to ASK_USER (contract field shape TBD).
 *
 * No integration into assistant UI here. No dependencies.
 */

/** All fault modes the fake can reproduce. */
export type FaultMode =
  | "GOOD"
  | "SLOW"
  | "TIMEOUT"
  | "LOOP_SENTENCE"
  | "LOOP_PARAGRAPH"
  | "EMPTY"
  | "INVALID_JSON"
  | "FENCED_JSON"
  | "PROSE_PLUS_JSON"
  | "TRUNCATED_JSON"
  | "WRONG_ACTION"
  | "UNKNOWN_ACTION"
  | "REFUSAL"
  | "OOM"
  | "RUNTIME_CRASH"
  | "MODEL_MISSING"
  | "MODEL_CORRUPT"
  | "LOW_MEMORY"
  | "CANCELLED"
  | "HTTP_DROP"
  | "WRONG_CONTENT_RANGE"
  | "HASH_MISMATCH"
  | "DISK_FULL"
  | "GPU_INIT_ERROR"
  | "NPU_ABSENT"
  | "INVALID_UTF8"
  | "PROCESS_DEATH"
  | "TWO_VLM_RACE"
  | "MODEL_UPDATE_DURING_INFERENCE"
  | "CLOUD_OFFLINE"
  | "PATH_TRAVERSAL";

export const FAULT_MODES: readonly FaultMode[] = [
  "GOOD",
  "SLOW",
  "TIMEOUT",
  "LOOP_SENTENCE",
  "LOOP_PARAGRAPH",
  "EMPTY",
  "INVALID_JSON",
  "FENCED_JSON",
  "PROSE_PLUS_JSON",
  "TRUNCATED_JSON",
  "WRONG_ACTION",
  "UNKNOWN_ACTION",
  "REFUSAL",
  "OOM",
  "RUNTIME_CRASH",
  "MODEL_MISSING",
  "MODEL_CORRUPT",
  "LOW_MEMORY",
  "CANCELLED",
  "HTTP_DROP",
  "WRONG_CONTENT_RANGE",
  "HASH_MISMATCH",
  "DISK_FULL",
  "GPU_INIT_ERROR",
  "NPU_ABSENT",
  "INVALID_UTF8",
  "PROCESS_DEATH",
  "TWO_VLM_RACE",
  "MODEL_UPDATE_DURING_INFERENCE",
  "CLOUD_OFFLINE",
  "PATH_TRAVERSAL",
];

/** Planned application error classes. */
export type AiErrorClass =
  | "LOOP_DETECTED"
  | "TIMEOUT"
  | "LOW_MEMORY"
  | "INVALID_OUTPUT"
  | "UNSUPPORTED_REQUEST"
  | "UNSUPPORTED_ACTION"
  | "MODEL_UNAVAILABLE"
  | "MODEL_CORRUPT"
  | "RUNTIME_ERROR"
  | "CANCELLED";

/**
 * Stable mode→error-class mapping. `null` means the
 * fake itself succeeds (no error thrown); classification then belongs to the
 * calling layer.
 */
export const PROPOSED_MODE_ERROR_MAP: Record<FaultMode, AiErrorClass | null> = {
  // Stable: success. SLOW is latency only, never an error; GenerationGuard
  // owns the deadline. Production timeout budget is TBD (evaluation
  // measurements + ModelProfile); slowDelayMs/timeoutMs below are
  // harness-only knobs, not production budgets.
  GOOD: null,
  SLOW: null,
  TIMEOUT: "TIMEOUT",
  LOOP_SENTENCE: "LOOP_DETECTED",
  LOOP_PARAGRAPH: "LOOP_DETECTED",
  EMPTY: "INVALID_OUTPUT",
  INVALID_JSON: "INVALID_OUTPUT",
  // Stable: tolerantly extract ONE recoverable JSON object, then STRICTLY
  // validate (schema + enum/action allowlist). Multiple conflicting objects
  // or invalid schema → INVALID_OUTPUT.
  FENCED_JSON: null,
  PROSE_PLUS_JSON: null,
  TRUNCATED_JSON: "INVALID_OUTPUT",
  // Stable: UNSUPPORTED_ACTION; diagnostics preserve which mode occurred
  // (WRONG_ACTION vs UNKNOWN_ACTION). See diagnosticCodeForMode().
  WRONG_ACTION: "UNSUPPORTED_ACTION",
  UNKNOWN_ACTION: "UNSUPPORTED_ACTION",
  // Stable: UNSUPPORTED_REQUEST with a refusal reason (well-formed refusal,
  // not malformed output).
  REFUSAL: "UNSUPPORTED_REQUEST",
  OOM: "LOW_MEMORY",
  RUNTIME_CRASH: "RUNTIME_ERROR",
  MODEL_MISSING: "MODEL_UNAVAILABLE",
  MODEL_CORRUPT: "MODEL_CORRUPT",
  LOW_MEMORY: "LOW_MEMORY",
  CANCELLED: "CANCELLED",
  // WS-F download/accelerator/runtime/request-guard faults. Delivery and
  // integrity failures normalize to the model-health classes (reinstall owns
  // recovery); DISK_FULL joins the resource-exhaustion family with LOW_MEMORY
  // while diagnostics preserve the distinct DISK_FULL cause; accelerator and
  // concurrency failures are RUNTIME_ERROR (CPU fallback / serialize+retry
  // owns recovery); offline/unsafe requests are rejected as
  // UNSUPPORTED_REQUEST with a reason, never retried blindly.
  HTTP_DROP: "MODEL_UNAVAILABLE",
  WRONG_CONTENT_RANGE: "MODEL_CORRUPT",
  HASH_MISMATCH: "MODEL_CORRUPT",
  DISK_FULL: "LOW_MEMORY",
  GPU_INIT_ERROR: "RUNTIME_ERROR",
  NPU_ABSENT: "RUNTIME_ERROR",
  INVALID_UTF8: "INVALID_OUTPUT",
  PROCESS_DEATH: "RUNTIME_ERROR",
  TWO_VLM_RACE: "RUNTIME_ERROR",
  MODEL_UPDATE_DURING_INFERENCE: "RUNTIME_ERROR",
  CLOUD_OFFLINE: "UNSUPPORTED_REQUEST",
  PATH_TRAVERSAL: "UNSUPPORTED_REQUEST",
};

/** Error thrown by the fake for transport/runtime failure modes. */
export class FakeAiError extends Error {
  readonly errorClass: AiErrorClass;
  readonly mode: FaultMode;
  readonly detail: string;
  constructor(errorClass: AiErrorClass, mode: FaultMode, message?: string, detail?: string) {
    super(message ?? `${errorClass} (mode ${mode})`);
    this.name = "FakeAiError";
    this.errorClass = errorClass;
    this.mode = mode;
    this.detail = detail ?? diagnosticCodeForMode(mode);
  }
}

/**
 * Stable diagnostic code preserving the distinct simulator cause. OOM is a
 * runtime failure and LOW_MEMORY is a preflight signal; both normalize to
 * the public LOW_MEMORY error class. WRONG/UNKNOWN preserve which mode
 * occurred; REFUSAL carries a refusal reason.
 */
export function diagnosticCodeForMode(mode: FaultMode): string {
  switch (mode) {
    case "OOM":
      return "OOM_RUNTIME";
    case "LOW_MEMORY":
      return "PRECHECK_INSUFFICIENT_MEMORY";
    case "REFUSAL":
      return "REFUSAL_POLICY";
    default:
      return mode;
  }
}

/** Canned refusal prose emitted by REFUSAL mode. */
export const REFUSAL_TEXT = "I can't help with that request.";

/**
 * Stable: ambiguous location is not an error — a successful assistant state
 * requiring clarification. No coordinates are chosen. Exact field shape is
 * TBD (contract follow-up); do not invent fields here.
 */
export const AMBIGUOUS_LOCATION_STATE = "ASK_USER" as const;
export type AssistantResultState = "ok" | typeof AMBIGUOUS_LOCATION_STATE;

/** Result of tolerant single-object extraction for FENCED/PROSE outputs. */
export interface ExtractedJson {
  json: string | null;
  count: number;
}

/**
 * Tolerantly extract brace-balanced JSON object candidates (code fences
 * stripped). Normalizer rule: count === 1 → strictly validate the object
 * (schema + enum/action allowlist); count !== 1 (none or multiple
 * conflicting) → INVALID_OUTPUT.
 */
export function extractSingleJsonObject(text: string): ExtractedJson {
  const stripped = text.replace(/```(?:json)?/g, "");
  const candidates: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          candidates.push(stripped.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }
  return { json: candidates[0] ?? null, count: candidates.length };
}

/** Minimal text request mirroring GenerateTextRequest (vlmPlugin.ts). */
export interface FakeTextRequest {
  prompt: string;
  maxOutputTokens?: number;
  temperature?: number;
}

/** Minimal photo-analysis request mirroring AnalyzeRequest (vlmPlugin.ts). */
export interface FakePhotoRequest {
  imageUri: string;
  instruction: string;
  maxOutputTokens?: number;
  temperature?: number;
}

export interface FakeAiResult {
  text: string;
  modelId: string;
  backend: string;
}

export interface FakeAiProviderOptions {
  mode: FaultMode;
  /** Harness-only extra latency for SLOW (ms). Default 250. */
  slowDelayMs?: number;
  /** Harness-only budget after which TIMEOUT throws (ms). Default 50. */
  timeoutMs?: number;
  /** Installed models for MODEL_MISSING / delete-while-open scenarios. */
  installedModels?: string[];
  /** Model the fake pretends to serve. Default "smolvlm2-500m". */
  modelId?: string;
}

const VALID_PHOTO_JSON = JSON.stringify({
  objectName: "black umbrella",
  suggestedCategory: "accessories",
  colors: ["black"],
  visibleBrand: null,
  visibleText: [],
  identifyingFeatures: ["curved wooden handle"],
  suggestedTitle: "Black umbrella found near the library",
  suggestedDescription: "A black umbrella with a curved wooden handle.",
  uncertainFields: ["visibleBrand"],
});

const LOOP_SENTENCE_TEXT =
  "Tap Report, then Lost, then fill the form. ".repeat(12).trim();

const LOOP_PARAGRAPH_TEXT =
  "To report a lost item, open the Report tab and choose Lost. Fill in the title, description, category, date and map location. Publish when ready. ".repeat(
    4,
  ).trim();

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new FakeAiError("CANCELLED", "CANCELLED", "aborted before start"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new FakeAiError("CANCELLED", "CANCELLED", "aborted mid-generation"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Deterministic fake AI provider. Output-shape modes (LOOP_*, EMPTY,
 * *_JSON, WRONG/UNKNOWN_ACTION, REFUSAL) resolve with canned text so the
 * normalizer/parser under test performs the classification; transport and
 * runtime modes (TIMEOUT, OOM, RUNTIME_CRASH, MODEL_MISSING, MODEL_CORRUPT,
 * LOW_MEMORY, CANCELLED) reject with FakeAiError. Any AbortSignal abort rejects with
 * CANCELLED regardless of mode.
 */
export class FakeAiProvider {
  private mode: FaultMode;
  private readonly slowDelayMs: number;
  private readonly timeoutMs: number;
  private readonly installed: Set<string>;
  private readonly modelId: string;
  private loadedRuntime: string | null;
  private readonly releasedRuntimes: string[];
  /** Captured generation requests so callers can assert cap propagation. */
  readonly textRequests: FakeTextRequest[] = [];
  readonly photoRequests: FakePhotoRequest[] = [];

  constructor(options: FakeAiProviderOptions) {
    this.mode = options.mode;
    this.slowDelayMs = options.slowDelayMs ?? 250;
    this.timeoutMs = options.timeoutMs ?? 50;
    this.installed = new Set(options.installedModels ?? ["smolvlm2-500m", "smolvlm-256m"]);
    this.modelId = options.modelId ?? "smolvlm2-500m";
    this.loadedRuntime = this.modelId;
    this.releasedRuntimes = [];
  }

  setMode(mode: FaultMode): void {
    this.mode = mode;
  }

  getMode(): FaultMode {
    return this.mode;
  }

  /** Models the fake currently pretends are installed. */
  isInstalled(modelId: string): boolean {
    return this.installed.has(modelId);
  }

  /** Simulates deleting a model while a sheet is open. */
  deleteModel(modelId: string): void {
    this.installed.delete(modelId);
  }

  /**
   * Simulates switching models: releases the old runtime and loads the new
   * one. Throws MODEL_UNAVAILABLE when the target is not installed.
   */
  switchModel(nextModelId: string): void {
    if (!this.installed.has(nextModelId)) {
      throw new FakeAiError("MODEL_UNAVAILABLE", "MODEL_MISSING", `model not installed: ${nextModelId}`);
    }
    if (this.loadedRuntime !== null && this.loadedRuntime !== nextModelId) {
      this.releasedRuntimes.push(this.loadedRuntime);
    }
    this.loadedRuntime = nextModelId;
  }

  loadedModel(): string | null {
    return this.loadedRuntime;
  }

  releasedModels(): readonly string[] {
    return this.releasedRuntimes;
  }

  async generateText(request: FakeTextRequest, signal?: AbortSignal): Promise<FakeAiResult> {
    this.textRequests.push({ ...request });
    return this.run(request.prompt, "help", signal);
  }

  async analyzePhoto(request: FakePhotoRequest, signal?: AbortSignal): Promise<FakeAiResult> {
    this.photoRequests.push({ ...request });
    return this.run(request.instruction, "photo", signal);
  }

  private async run(input: string, kind: "help" | "photo", signal?: AbortSignal): Promise<FakeAiResult> {
    if (signal?.aborted) {
      throw new FakeAiError("CANCELLED", "CANCELLED", "aborted before start");
    }
    switch (this.mode) {
      case "TIMEOUT":
        await delay(this.timeoutMs, signal);
        throw new FakeAiError("TIMEOUT", "TIMEOUT", `generation timed out after ${this.timeoutMs}ms`);
      case "OOM":
      case "LOW_MEMORY":
        throw new FakeAiError("LOW_MEMORY", this.mode, "out of memory during generation");
      case "MODEL_CORRUPT":
        throw new FakeAiError("MODEL_CORRUPT", this.mode, "model failed integrity check");
      case "RUNTIME_CRASH":
        throw new FakeAiError("RUNTIME_ERROR", this.mode, "runtime crashed during generation");
      case "MODEL_MISSING":
        throw new FakeAiError("MODEL_UNAVAILABLE", this.mode, `model not installed: ${this.modelId}`);
      case "CANCELLED":
        throw new FakeAiError("CANCELLED", this.mode, "generation cancelled by user");
      case "HTTP_DROP":
        throw new FakeAiError("MODEL_UNAVAILABLE", this.mode, "download interrupted: http connection dropped");
      case "WRONG_CONTENT_RANGE":
        throw new FakeAiError("MODEL_CORRUPT", this.mode, "download content-range mismatch");
      case "HASH_MISMATCH":
        throw new FakeAiError("MODEL_CORRUPT", this.mode, "download hash mismatch");
      case "DISK_FULL":
        throw new FakeAiError("LOW_MEMORY", this.mode, "no space left on device");
      case "GPU_INIT_ERROR":
        throw new FakeAiError("RUNTIME_ERROR", this.mode, "gpu delegate failed to initialize");
      case "NPU_ABSENT":
        throw new FakeAiError("RUNTIME_ERROR", this.mode, "npu delegate absent on this device");
      case "PROCESS_DEATH":
        throw new FakeAiError("RUNTIME_ERROR", this.mode, "host process died mid-generation");
      case "TWO_VLM_RACE":
        throw new FakeAiError("RUNTIME_ERROR", this.mode, "concurrent vlm sessions conflict");
      case "MODEL_UPDATE_DURING_INFERENCE":
        throw new FakeAiError("RUNTIME_ERROR", this.mode, "model revision changed mid-inference");
      case "CLOUD_OFFLINE":
        throw new FakeAiError("UNSUPPORTED_REQUEST", this.mode, "cloud request while offline");
      case "PATH_TRAVERSAL":
        throw new FakeAiError("UNSUPPORTED_REQUEST", this.mode, "unsafe path rejected");
      case "SLOW":
        await delay(this.slowDelayMs, signal);
        break;
      default:
        break;
    }
    if (signal?.aborted) {
      throw new FakeAiError("CANCELLED", "CANCELLED", "aborted mid-generation");
    }
    if (!this.installed.has(this.modelId)) {
      throw new FakeAiError("MODEL_UNAVAILABLE", "MODEL_MISSING", `model not installed: ${this.modelId}`);
    }
    return { text: this.cannedText(input, kind), modelId: this.modelId, backend: "fake" };
  }

  private cannedText(input: string, kind: "help" | "photo"): string {
    void input;
    switch (this.mode) {
      case "GOOD":
      case "SLOW":
        return kind === "photo"
          ? VALID_PHOTO_JSON
          : "Open the Report tab, choose Lost, fill the form, then Publish.";
      case "LOOP_SENTENCE":
        return LOOP_SENTENCE_TEXT;
      case "LOOP_PARAGRAPH":
        return LOOP_PARAGRAPH_TEXT;
      case "EMPTY":
        return "";
      case "INVALID_JSON":
        return "{objectName: black umbrella, colors: [}";
      case "FENCED_JSON":
        return "```json\n" + VALID_PHOTO_JSON + "\n```";
      case "PROSE_PLUS_JSON":
        return "Here is the analysis you asked for:\n" + VALID_PHOTO_JSON + "\nLet me know if you need anything else.";
      case "TRUNCATED_JSON":
        return VALID_PHOTO_JSON.slice(0, Math.floor(VALID_PHOTO_JSON.length / 2));
      case "WRONG_ACTION":
        return JSON.stringify({ action: "delete_someone_elses_post", args: { postId: "abc" } });
      case "UNKNOWN_ACTION":
        return JSON.stringify({ action: "teleport_item_home", args: {} });
      case "REFUSAL":
        return REFUSAL_TEXT;
      case "INVALID_UTF8":
        return "Black umbrella \uD800 found near the library \uDFFF hurry";
      case "TIMEOUT":
      case "OOM":
      case "RUNTIME_CRASH":
      case "MODEL_MISSING":
      case "MODEL_CORRUPT":
      case "LOW_MEMORY":
      case "CANCELLED":
      case "HTTP_DROP":
      case "WRONG_CONTENT_RANGE":
      case "HASH_MISMATCH":
      case "DISK_FULL":
      case "GPU_INIT_ERROR":
      case "NPU_ABSENT":
      case "PROCESS_DEATH":
      case "TWO_VLM_RACE":
      case "MODEL_UPDATE_DURING_INFERENCE":
      case "CLOUD_OFFLINE":
      case "PATH_TRAVERSAL":
        throw new Error("unreachable: throwing modes reject in run()");
    }
  }
}
