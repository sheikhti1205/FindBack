import type { AiErrorClass, FaultMode } from "./FakeAiProvider";

/** Assistant surface a scenario exercises. No UI is built here (Task 24). */
export type AssistantSurface = "help" | "report" | "photo" | "search" | "runtime";

/**
 * Deterministic fault scenario: an ordered mode sequence plus the expected
 * coordinator error class and the UI affordance Task 24 must provide
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
 * Scenario matrix covering the thirteen Task 23 map-freeze cases.
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
    notes: "Also runnable with LOOP_PARAGRAPH. Loop classification belongs to the coordinator, not the fake.",
  },
  {
    id: "help-timeout-switch-model",
    surface: "help",
    title: "Help → timeout → switch model",
    modes: ["TIMEOUT", "GOOD"],
    expectedError: "TIMEOUT",
    expectedUi: "Timeout notice offering model switch / retry; retry on the other model succeeds.",
    notes: "FROZEN: TIMEOUT. GenerationGuard owns the deadline; production timeout budget is TBD (Task-20/29 measurements + ModelProfile).",
  },
  {
    id: "report-malformed-extraction",
    surface: "report",
    title: "Report assistant → malformed extraction",
    modes: ["INVALID_JSON", "TRUNCATED_JSON", "EMPTY"],
    expectedError: "INVALID_OUTPUT",
    expectedUi: "Extraction-failed state asking the user to rephrase; draft is preserved.",
    notes: "FROZEN: EMPTY, INVALID_JSON, and TRUNCATED_JSON map to INVALID_OUTPUT.",
  },
  {
    id: "report-unknown-action-rejected",
    surface: "report",
    title: "Report assistant → unknown action rejected",
    modes: ["UNKNOWN_ACTION", "WRONG_ACTION"],
    expectedError: "UNSUPPORTED_ACTION",
    expectedUi: "Unsupported-action rejection naming the rejected action; no side effects applied.",
    notes: "FROZEN: both map to UNSUPPORTED_ACTION; diagnostics preserve which mode occurred (WRONG_ACTION vs UNKNOWN_ACTION).",
  },
  {
    id: "photo-valid",
    surface: "photo",
    title: "Photo analysis valid",
    modes: ["GOOD"],
    expectedError: null,
    expectedUi: "Structured suggestions shown (title, description, category, colors).",
    notes: "FROZEN: tolerantly extract ONE recoverable JSON object, then strictly validate (schema + enum/action allowlist); multiple conflicting objects or invalid schema → INVALID_OUTPUT.",
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
    notes: "FROZEN: ambiguous location is not an error — successful ASK_USER state, no coordinates chosen. Exact field shape TBD (Task 21).",
    expectedAssistantState: "ASK_USER",
  },
  {
    id: "oom-during-generation",
    surface: "runtime",
    title: "OOM during generation",
    modes: ["OOM", "LOW_MEMORY"],
    expectedError: "LOW_MEMORY",
    expectedUi: "Low-memory notice suggesting the smaller model or freeing memory.",
    notes: "FROZEN: OOM (runtime failure) and LOW_MEMORY (preflight) stay distinct simulator causes, both normalizing to LOW_MEMORY; diagnostics preserve OOM_RUNTIME vs PRECHECK_INSUFFICIENT_MEMORY.",
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
    notes: "FROZEN: deterministic MODEL_CORRUPT simulator mode exercising the taxonomy's MODEL_CORRUPT class.",
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
];

export function scenarioFor(id: string): FaultScenario | undefined {
  return SCENARIO_MATRIX.find((s) => s.id === id);
}
