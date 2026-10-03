/**
 * AI common contract for FindBack on-device assistance.
 *
 * Evidence: external coded evaluation corpus (93 text rows, 31 per text
 * model; 36 vision rows, 12 per vision model — corpus files are lab records,
 * not tracked in this tree).
 * The stable error taxonomy (AiErrorClass + mode mapping) is owned by
 * services/ai/testing/FakeAiProvider.ts — imported here, never redefined.
 * R3 loop detection belongs to the guard (seam in normalize.ts). The
 * production timeout budget is an explicit TBD fed by evaluation
 * measurements + ModelProfile — no timeout number lives in this contract.
 */
import type { AiErrorClass } from "./testing/FakeAiProvider";

export type { AiErrorClass };

/** Stable intent vocabulary for the narrow classify-intent op. */
export const INTENTS = [
  "REPORT_LOST",
  "REPORT_FOUND",
  "SEARCH",
  "APP_QUESTION",
  "OPEN_QUESTION",
  "UNKNOWN",
] as const;
export type Intent = (typeof INTENTS)[number];

/**
 * Stable action allowlist. Anything outside this list is discarded by the
 * validators in normalize.ts (UNSUPPORTED_ACTION, never applied).
 */
export const ACTIONS = [
  "NONE",
  "ASK_USER",
  "OPEN_REPORT",
  "OPEN_SEARCH",
  "OPEN_MAP",
  "PICK_PHOTO",
  "TAKE_PHOTO",
  "OPEN_MODEL_LIBRARY",
  "APPLY_REPORT_DRAFT",
] as const;
export type Action = (typeof ACTIONS)[number];

export function isIntent(value: unknown): value is Intent {
  return typeof value === "string" && (INTENTS as readonly string[]).includes(value);
}

export function isAction(value: unknown): value is Action {
  return typeof value === "string" && (ACTIONS as readonly string[]).includes(value);
}

/** Narrow adapter op identifiers. Small models get one op per call. */
export const NARROW_OPS = [
  "classify-intent",
  "extract-report-fields",
  "answer-help",
  "extract-search-filters",
  "analyze-image",
] as const;
export type NarrowOp = (typeof NARROW_OPS)[number];

/** What the assistant needs clarified when it resolves to ASK_USER. */
export const CLARIFICATION_FIELDS = [
  "location",
  "category",
  "date",
  "photo",
  "query",
  "other",
] as const;
export type ClarificationField = (typeof CLARIFICATION_FIELDS)[number];

/** Shape bounds for the ASK_USER field (mobile sheet UI budget). */
export const ASK_USER_QUESTION_MAX = 280;
export const ASK_USER_OPTIONS_MAX = 6;
export const ASK_USER_OPTION_MAX = 80;

/**
 * ASK_USER field shape (was TBD in the fault-scaffolding; defined here).
 * Ambiguous location is a successful state needing clarification: this shape
 * carries a question plus optional disambiguation options, and by
 * construction carries NO coordinates — the contract has no
 * coordinate-accepting field, so silent coordinates are unrepresentable.
 */
export interface AskUserPrompt {
  readonly question: string;
  readonly field: ClarificationField;
  readonly options?: readonly string[];
}

export function isAskUserPrompt(value: unknown): value is AskUserPrompt {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { question?: unknown; field?: unknown; options?: unknown };
  if (typeof candidate.question !== "string") return false;
  const question = candidate.question.trim();
  if (question.length === 0 || question.length > ASK_USER_QUESTION_MAX) return false;
  if (
    typeof candidate.field !== "string" ||
    !(CLARIFICATION_FIELDS as readonly string[]).includes(candidate.field)
  ) {
    return false;
  }
  if (candidate.options === undefined) return true;
  if (!Array.isArray(candidate.options)) return false;
  if (candidate.options.length > ASK_USER_OPTIONS_MAX) return false;
  return candidate.options.every(
    (option): boolean =>
      typeof option === "string" &&
      option.trim().length > 0 &&
      option.length <= ASK_USER_OPTION_MAX,
  );
}

/**
 * An assistant action. `prompt` is required if and only if the action is
 * ASK_USER; any other action carrying a prompt is invalid (dead data).
 */
export interface AssistantAction {
  readonly action: Action;
  readonly prompt?: AskUserPrompt;
}

export function isAssistantAction(value: unknown): value is AssistantAction {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { action?: unknown; prompt?: unknown };
  if (!isAction(candidate.action)) return false;
  if (candidate.action === "ASK_USER") return isAskUserPrompt(candidate.prompt);
  return candidate.prompt === undefined;
}

/** Classified user intent plus the deterministically derived action. */
export interface ClassifiedIntent {
  readonly intent: Intent;
  readonly action: AssistantAction;
}

/** Normalized error: stable class + machine-readable diagnostic. */
export interface AiError {
  readonly errorClass: AiErrorClass;
  readonly diagnostic: string;
  readonly reason?: string;
}

export function makeAiError(
  errorClass: AiErrorClass,
  diagnostic: string,
  reason?: string,
): AiError {
  return reason === undefined ? { errorClass, diagnostic } : { errorClass, diagnostic, reason };
}

/** Operation outcome: success value or normalized error. */
export type AiResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: AiError };

/** Transport injection point for narrow ops (FakeAiProvider or native runtime). */
export interface GenerateOptions {
  readonly maxOutputTokens: number;
  readonly temperature: number;
}

export type GenerateFn = (prompt: string, options: GenerateOptions) => Promise<string>;

/** Narrow slot set for lost/found report extraction (no coordinates). */
export interface ReportSlotFields {
  readonly title?: string;
  readonly description?: string;
  readonly category?: string;
  readonly dateText?: string;
  readonly locationNote?: string;
}

export interface ReportExtraction {
  readonly fields: ReportSlotFields;
  readonly action: AssistantAction;
}

/** Narrow slot set for search-filter extraction (no coordinates). */
export interface SearchFilterFields {
  readonly query?: string;
  readonly category?: string;
  readonly status?: string;
  readonly dateRangeText?: string;
}

export interface SearchExtraction {
  readonly fields: SearchFilterFields;
  readonly action: AssistantAction;
}

/** Prose help answer. Free text is bounded and thought-stripped upstream. */
export interface HelpAnswer {
  readonly answerText: string;
  readonly action: AssistantAction;
}

/**
 * Photo-analysis schema: exactly these 9 fields (VISION_STRUCTURED_V2).
 * Vision models emit lookalike aliases ("title", "description"); the strict
 * validator accepts only these keys.
 */
export const PHOTO_ANALYSIS_KEYS = [
  "objectName",
  "suggestedCategory",
  "colors",
  "visibleBrand",
  "visibleText",
  "identifyingFeatures",
  "suggestedTitle",
  "suggestedDescription",
  "uncertainFields",
] as const;
export type PhotoAnalysisKey = (typeof PHOTO_ANALYSIS_KEYS)[number];

export interface PhotoAnalysis {
  readonly objectName: string | null;
  readonly suggestedCategory: string | null;
  readonly colors: readonly string[];
  readonly visibleBrand: string | null;
  readonly visibleText: readonly string[];
  readonly identifyingFeatures: readonly string[];
  readonly suggestedTitle: string | null;
  readonly suggestedDescription: string | null;
  readonly uncertainFields: readonly string[];
}

/**
 * WS-A task-router contract. One `AiTaskSpec` bounds a single routable AI
 * task: input budgets (`maxBytes`/`maxImages`), the privacy envelope, the
 * ordered runtime preference list (`runtimes`, first-available wins —
 * single-path invoke, never fan-out), the per-task timeout, whether explicit
 * user consent is required before a remote runtime may run, and the schema
 * tag the task result validates against.
 */
export const AI_TASK_IDS = [
  "classify-intent",
  "extract-report-fields",
  "answer-help",
  "extract-search-filters",
  "analyze-image",
  "route-intent",
  "embed-texts",
  "ground-objects",
  "classify-category",
  "summarize-local-context",
] as const;
export type AiTaskId = (typeof AI_TASK_IDS)[number];

export function isAiTaskId(value: unknown): value is AiTaskId {
  return typeof value === "string" && (AI_TASK_IDS as readonly string[]).includes(value);
}

export const AI_PRIVACY_CLASSES = ["local-only", "local-first", "consented-remote"] as const;
export type AiPrivacyClass = (typeof AI_PRIVACY_CLASSES)[number];

export function isAiPrivacyClass(value: unknown): value is AiPrivacyClass {
  return (
    typeof value === "string" && (AI_PRIVACY_CLASSES as readonly string[]).includes(value)
  );
}

export interface AiTaskSpec {
  readonly taskId: AiTaskId;
  readonly maxBytes: number;
  readonly maxImages: number;
  readonly privacyClass: AiPrivacyClass;
  readonly runtimes: readonly string[];
  readonly timeoutMs: number;
  readonly needsConsent: boolean;
  readonly schema: string;
}
