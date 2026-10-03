import type { AiErrorClass, FaultMode } from "./FakeAiProvider";

/** Assistant surface a scenario exercises. No UI is built here. */
export type AssistantSurface = "help" | "report" | "photo" | "search" | "runtime";

/**
 * Deterministic fault scenario: an ordered mode sequence plus the expected
 * application error class and the UI affordance the assistant UI must provide
 * (described, not implemented).
 */
export interface FaultScenario {
  id: string;
  surface: AssistantSurface;
  title: string;
  modes: FaultMode[];
  expectedError: AiErrorClass | null;
  expectedUi: string;
  notes: string;
  /** Successful-state marker; ASK_USER = clarification needed, no coordinates chosen. */
  expectedAssistantState?: "ok" | "ASK_USER";
}

/**
 * Scenario matrix covering the thirteen simulator mode-mapping cases plus the
 * eight WS-F delivery/integrity/resource/accelerator/encoding/lifecycle/
 * concurrency/guard cases (21 rows total).
 * `expectedError: null` means the sequence ends in recovery/success.
 */
export const SCENARIO_MATRIX: readonly FaultScenario[] = [
  {
    id: "help-loop-recovery",
    surface: "help",
    title: "Help → loop → recovery UI",
    modes: ["LOOP_SENTENCE", "GOOD"],
    expectedError: "LOOP_DETECTED",
    expectedUi: "Loop notice with Stop + Regenerate affordance; second attempt answers cleanly.",
    notes: "Also runnable with LOOP_PARAGRAPH. Loop classification belongs to the normalization layer, not the fake.",
  },
  {
    id: "help-timeout-switch-model",
    surface: "help",
    title: "Help → timeout → switch model",
    modes: ["TIMEOUT", "GOOD"],
    expectedError: "TIMEOUT",
    expectedUi: "Timeout notice offering model switch / retry; retry on the other model succeeds.",
    notes: "Stable: TIMEOUT. GenerationGuard owns the deadline; production timeout budget is TBD (evaluation measurements + ModelProfile).",
  },
  {
    id: "report-malformed-extraction",
    surface: "report",
    title: "Report assistant → malformed extraction",
    modes: ["INVALID_JSON", "TRUNCATED_JSON", "EMPTY"],
    expectedError: "INVALID_OUTPUT",
    expectedUi: "Extraction-failed state asking the user to rephrase; draft is preserved.",
    notes: "Stable: EMPTY, INVALID_JSON, and TRUNCATED_JSON map to INVALID_OUTPUT.",
  },
  {
    id: "report-unknown-action-rejected",
    surface: "report",
    title: "Report assistant → unknown action rejected",
    modes: ["UNKNOWN_ACTION", "WRONG_ACTION"],
    expectedError: "UNSUPPORTED_ACTION",
    expectedUi: "Unsupported-action rejection naming the rejected action; no side effects applied.",
    notes: "Stable: both map to UNSUPPORTED_ACTION; diagnostics preserve which mode occurred (WRONG_ACTION vs UNKNOWN_ACTION).",
  },
  {
    id: "photo-valid",
    surface: "photo",
    title: "Photo analysis valid",
    modes: ["GOOD"],
    expectedError: null,
    expectedUi: "Structured suggestions shown (title, description, category, colors).",
    notes: "Stable: tolerantly extract ONE recoverable JSON object, then strictly validate (schema + enum/action allowlist); multiple conflicting objects or invalid schema → INVALID_OUTPUT.",
  },
  {
    id: "photo-invalid",
    surface: "photo",
    title: "Photo analysis invalid",
    modes: ["INVALID_JSON"],
    expectedError: "INVALID_OUTPUT",
    expectedUi: "Analysis-failed state with retry; no bogus suggestions shown.",
    notes: "Covers the one-retry-then-fail-closed shape of analyzeImageLocally.",
  },
  {
    id: "search-ambiguous-place",
    surface: "search",
    title: "Search assistant → ambiguous place",
    modes: ["PROSE_PLUS_JSON", "GOOD"],
    expectedError: null,
    expectedUi: "Disambiguation prompt listing candidate places; selection continues the search.",
    notes: "Stable: ambiguous location is not an error — successful ASK_USER state, no coordinates chosen. Exact field shape TBD (contract follow-up).",
    expectedAssistantState: "ASK_USER",
  },
  {
    id: "oom-during-generation",
    surface: "runtime",
    title: "OOM during generation",
    modes: ["OOM", "LOW_MEMORY"],
    expectedError: "LOW_MEMORY",
    expectedUi: "Low-memory notice suggesting the smaller model or freeing memory.",
    notes: "Stable: OOM (runtime failure) and LOW_MEMORY (preflight) stay distinct simulator causes, both normalizing to LOW_MEMORY; diagnostics preserve OOM_RUNTIME vs PRECHECK_INSUFFICIENT_MEMORY.",
  },
  {
    id: "user-cancel",
    surface: "runtime",
    title: "User cancel",
    modes: ["CANCELLED"],
    expectedError: "CANCELLED",
    expectedUi: "Generation stops promptly; partial output is discarded, no error toast.",
    notes: "Also covered via AbortSignal on any mode; CANCELLED mode is the no-signal equivalent.",
  },
  {
    id: "navigate-away-mid-generation",
    surface: "runtime",
    title: "Navigate away mid-generation",
    modes: ["SLOW"],
    expectedError: "CANCELLED",
    expectedUi: "Pending generation is aborted on unmount; no state update after unmount.",
    notes: "Exercised by aborting a SLOW call mid-flight; expects CANCELLED, never a late success.",
  },
  {
    id: "model-corrupt-reinstall",
    surface: "runtime",
    title: "Model corrupt → reinstall",
    modes: ["MODEL_CORRUPT"],
    expectedError: "MODEL_CORRUPT",
    expectedUi: "Model-corrupt notice with reinstall action; generation is blocked until reinstall.",
    notes: "Stable: deterministic MODEL_CORRUPT simulator mode exercising the taxonomy's MODEL_CORRUPT class.",
  },
  {
    id: "model-deleted-while-sheet-open",
    surface: "runtime",
    title: "Model deleted while sheet open",
    modes: ["MODEL_MISSING"],
    expectedError: "MODEL_UNAVAILABLE",
    expectedUi: "Model-missing notice with reinstall / switch-model actions.",
    notes: "Exercised via deleteModel() then generate, or MODEL_MISSING mode directly.",
  },
  {
    id: "model-switch-releases-runtime",
    surface: "runtime",
    title: "Model switch releases old runtime",
    modes: ["GOOD"],
    expectedError: null,
    expectedUi: "Switch completes with no leaked runtime; old model is released before the new one loads.",
    notes: "Asserted via switchModel() + releasedModels(); switching to a missing model throws MODEL_UNAVAILABLE.",
  },
  {
    id: "download-http-drop-resume",
    surface: "runtime",
    title: "Model download → http drop → resume",
    modes: ["HTTP_DROP"],
    expectedError: "MODEL_UNAVAILABLE",
    expectedUi: "Download-interrupted notice with resume/retry action; the model stays uninstallable-blocked until the download completes.",
    notes: "Stable: HTTP_DROP normalizes to MODEL_UNAVAILABLE; diagnostics preserve the HTTP_DROP cause. No partial file is treated as installed.",
  },
  {
    id: "download-integrity-mismatch-reinstall",
    surface: "runtime",
    title: "Model download → range/hash mismatch → reinstall",
    modes: ["WRONG_CONTENT_RANGE", "HASH_MISMATCH"],
    expectedError: "MODEL_CORRUPT",
    expectedUi: "Integrity-failure notice with reinstall action; generation is blocked until reinstall, same as a corrupt on-disk model.",
    notes: "Stable: both delivery-integrity modes map to MODEL_CORRUPT; diagnostics preserve WRONG_CONTENT_RANGE vs HASH_MISMATCH.",
  },
  {
    id: "disk-full-free-space",
    surface: "runtime",
    title: "Disk full during download",
    modes: ["DISK_FULL"],
    expectedError: "LOW_MEMORY",
    expectedUi: "Storage-full notice suggesting freeing space or choosing the smaller model; download/generation is blocked until space is available.",
    notes: "Stable: DISK_FULL joins the resource-exhaustion family (LOW_MEMORY class) while diagnostics preserve the distinct DISK_FULL cause, mirroring OOM vs preflight LOW_MEMORY.",
  },
  {
    id: "accelerator-unavailable-cpu-fallback",
    surface: "runtime",
    title: "GPU init error / NPU absent → CPU fallback",
    modes: ["GPU_INIT_ERROR", "NPU_ABSENT"],
    expectedError: "RUNTIME_ERROR",
    expectedUi: "Accelerator-unavailable notice; inference falls back to CPU with no leaked delegate, mirroring the LiteRT CPU-first stable path.",
    notes: "Stable: both accelerator modes map to RUNTIME_ERROR; diagnostics preserve GPU_INIT_ERROR vs NPU_ABSENT.",
  },
  {
    id: "invalid-utf8-output-rejected",
    surface: "report",
    title: "Report assistant → invalid UTF-8 output rejected",
    modes: ["INVALID_UTF8"],
    expectedError: "INVALID_OUTPUT",
    expectedUi: "Garbled-output state asking the user to rephrase/regenerate; no mojibake is rendered or persisted.",
    notes: "Stable: INVALID_UTF8 resolves canned non-well-formed text so the normalization layer performs the INVALID_OUTPUT classification, like the other output-shape modes.",
  },
  {
    id: "process-death-twice-fail-closed",
    surface: "runtime",
    title: "Host process dies twice → fail closed",
    modes: ["PROCESS_DEATH", "PROCESS_DEATH"],
    expectedError: "RUNTIME_ERROR",
    expectedUi: "Restart notice after the first death with generation retried; a second death fails closed with the draft preserved, never a half-applied side effect.",
    notes: "Stable: PROCESS_DEATH maps to RUNTIME_ERROR; the doubled mode encodes death-during-retry. Diagnostics preserve the PROCESS_DEATH cause.",
  },
  {
    id: "inference-concurrency-conflict-retry",
    surface: "runtime",
    title: "Two VLM sessions race / model updates mid-inference → serialize and retry",
    modes: ["TWO_VLM_RACE", "MODEL_UPDATE_DURING_INFERENCE"],
    expectedError: "RUNTIME_ERROR",
    expectedUi: "Conflict notice explaining the losing generation is retried serially on the settled model revision; no interleaved output is shown.",
    notes: "Stable: both concurrency modes map to RUNTIME_ERROR; diagnostics preserve TWO_VLM_RACE vs MODEL_UPDATE_DURING_INFERENCE.",
  },
  {
    id: "rejected-request-offline-or-unsafe",
    surface: "runtime",
    title: "Cloud request while offline / unsafe path → rejected",
    modes: ["CLOUD_OFFLINE", "PATH_TRAVERSAL"],
    expectedError: "UNSUPPORTED_REQUEST",
    expectedUi: "Request rejected naming the reason (offline / unsafe path) with on-device alternatives offered where applicable; nothing is sent or written.",
    notes: "Stable: both request-guard modes map to UNSUPPORTED_REQUEST with a reason (well-formed rejection, not malformed output), like REFUSAL.",
  },
];

export function scenarioFor(id: string): FaultScenario | undefined {
  return SCENARIO_MATRIX.find((s) => s.id === id);
}
