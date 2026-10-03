/**
 * Per-task envelopes for FindBack narrow AI tasks (WS-B).
 *
 * One AiTaskSpec per narrow task records the execution envelope the
 * orchestrator/guard layer enforces: input/output budgets, privacy tier,
 * eligible runtimes, generation timeout, and consent requirements. Specs are
 * data only — they authorize nothing and mutate nothing.
 *
 * Timeout numbers are provisional on-device budgets, not measured SLOs:
 * evaluation evidence shows typical photo inference at 6-11 s with runaway
 * loops at 88-102 s, so vision tasks ask 60 s (cutting runaways early) and
 * text tasks ask 30 s (text-loop wall times are unmeasured). GenerationGuard
 * owns the deadline and enforces whatever the caller passes; these values
 * are the per-task ask, subject to revision once evaluation measures them.
 * embed-texts is non-generative local preprocessing (no model call), so its
 * budget is a small scheduling bound, not an inference budget.
 */
import type { ModelRuntime } from "./modelProfiles";

/** Every narrow task with a spec. First five are the established ops. */
export const AI_TASKS = [
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
export type AiTaskId = (typeof AI_TASKS)[number];

export function isAiTaskId(value: unknown): value is AiTaskId {
  return typeof value === "string" && (AI_TASKS as readonly string[]).includes(value);
}

/**
 * Privacy tier. All narrow tasks are local-only: prompt text, images, and
 * embeddings never leave the device. `handlesImage` marks tasks whose input
 * may carry user photos (photo-library consent surface stays with the
 * caller); `handlesText` marks tasks carrying free-form user text.
 */
export interface TaskPrivacy {
  readonly tier: "local-only";
  readonly handlesImage: boolean;
  readonly handlesText: boolean;
}

/** Eligible runtimes. `local-native` is deterministic on-device code (no model). */
export type TaskRuntime = ModelRuntime | "local-native";

/**
 * Consent envelope. `required: false` means the op takes no consent flag
 * (input already passed the caller's permission/picker gate). `required: true`
 * means the op itself takes a consent flag and refuses without it.
 */
export interface TaskConsent {
  readonly required: boolean;
  readonly kind?: "image";
  readonly reason: string;
}

/** Execution envelope for one narrow task. */
export interface AiTaskSpec {
  readonly task: AiTaskId;
  readonly description: string;
  /** Max accepted input chars (caller-side bound; oversize fails closed). */
  readonly maxInputChars: number;
  /** Max model output tokens for the task (0 = non-generative, no model call). */
  readonly maxOutputTokens: number;
  /** Provisional generation timeout the guard enforces (ms). */
  readonly timeoutMs: number;
  readonly privacy: TaskPrivacy;
  readonly runtimes: readonly TaskRuntime[];
  readonly consent: TaskConsent;
  /** Single attempt unless noted: narrow ops fail closed, no hidden retries. */
  readonly retryLimit: number;
}

const LOCAL_TEXT: TaskPrivacy = { tier: "local-only", handlesImage: false, handlesText: true };
const LOCAL_IMAGE: TaskPrivacy = { tier: "local-only", handlesImage: true, handlesText: true };

const NO_CONSENT: TaskConsent = {
  required: false,
  reason: "Caller gates input (permission/picker); the op takes no consent flag.",
};

export const TASK_SPECS: Record<AiTaskId, AiTaskSpec> = {
  "classify-intent": {
    task: "classify-intent",
    description: "Classify a user message into the stable intent vocabulary.",
    maxInputChars: 2000,
    maxOutputTokens: 256,
    timeoutMs: 30_000,
    privacy: LOCAL_TEXT,
    runtimes: ["litert-lm", "llama-cpp"],
    consent: NO_CONSENT,
    retryLimit: 0,
  },
  "extract-report-fields": {
    task: "extract-report-fields",
    description: "Extract lost/found report slots; never invent coordinates.",
    maxInputChars: 2000,
    maxOutputTokens: 256,
    timeoutMs: 30_000,
    privacy: LOCAL_TEXT,
    runtimes: ["litert-lm", "llama-cpp"],
    consent: NO_CONSENT,
    retryLimit: 0,
  },
  "answer-help": {
    task: "answer-help",
    description: "Answer an app question in 1-3 prose sentences.",
    maxInputChars: 2000,
    maxOutputTokens: 256,
    timeoutMs: 30_000,
    privacy: LOCAL_TEXT,
    runtimes: ["litert-lm", "llama-cpp"],
    consent: NO_CONSENT,
    retryLimit: 0,
  },
  "extract-search-filters": {
    task: "extract-search-filters",
    description: "Extract search filters; empty filters resolve to ASK_USER.",
    maxInputChars: 2000,
    maxOutputTokens: 256,
    timeoutMs: 30_000,
    privacy: LOCAL_TEXT,
    runtimes: ["litert-lm", "llama-cpp"],
    consent: NO_CONSENT,
    retryLimit: 0,
  },
  "analyze-image": {
    task: "analyze-image",
    description: "Structured 9-field photo analysis with one retry, then fail closed.",
    maxInputChars: 2000,
    maxOutputTokens: 512,
    timeoutMs: 60_000,
    privacy: LOCAL_IMAGE,
    runtimes: ["litert-lm"],
    consent: NO_CONSENT,
    retryLimit: 1,
  },
  "route-intent": {
    task: "route-intent",
    description: "Route an already-classified intent to one in-app destination.",
    maxInputChars: 280,
    maxOutputTokens: 256,
    timeoutMs: 30_000,
    privacy: LOCAL_TEXT,
    runtimes: ["litert-lm", "llama-cpp"],
    consent: NO_CONSENT,
    retryLimit: 0,
  },
  "embed-texts": {
    task: "embed-texts",
    description: "Validate/normalize retrieval texts for the local embedder. Local-only, no consent flag.",
    maxInputChars: 16_000,
    maxOutputTokens: 0,
    timeoutMs: 5_000,
    privacy: LOCAL_TEXT,
    runtimes: ["local-native"],
    consent: {
      required: false,
      reason: "Local-only preprocessing: texts never leave the device, so no consent flag is taken.",
    },
    retryLimit: 0,
  },
  "ground-objects": {
    task: "ground-objects",
    description: "Ground a referring expression to boxes in relative-0-1000 space. Requires image consent.",
    maxInputChars: 140,
    maxOutputTokens: 512,
    timeoutMs: 60_000,
    privacy: LOCAL_IMAGE,
    runtimes: ["litert-lm"],
    consent: {
      required: true,
      kind: "image",
      reason: "Output boxes describe user-photo content; the op refuses without an explicit image-consent flag.",
    },
    retryLimit: 0,
  },
  "classify-category": {
    task: "classify-category",
    description: "Classify short item text into the lost-and-found category vocabulary.",
    maxInputChars: 280,
    maxOutputTokens: 256,
    timeoutMs: 30_000,
    privacy: LOCAL_TEXT,
    runtimes: ["litert-lm", "llama-cpp"],
    consent: NO_CONSENT,
    retryLimit: 0,
  },
  "summarize-local-context": {
    task: "summarize-local-context",
    description: "Summarize on-device context notes as short prose; never emit coordinates.",
    maxInputChars: 2000,
    maxOutputTokens: 256,
    timeoutMs: 30_000,
    privacy: LOCAL_TEXT,
    runtimes: ["litert-lm", "llama-cpp"],
    consent: NO_CONSENT,
    retryLimit: 0,
  },
};

export function taskSpecFor(task: AiTaskId): AiTaskSpec {
  return TASK_SPECS[task];
}
