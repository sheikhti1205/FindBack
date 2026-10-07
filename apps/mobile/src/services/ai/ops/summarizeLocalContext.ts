/**
 * Narrow op: summarize-local-context.
 *
 * Prose path: the model condenses on-device context notes (recent reports,
 * searches, drafts) into a short summary. Output is thought-stripped (R2),
 * refusal/empty-checked (R4), bounded, echo-checked (R6), and
 * coordinate-scanned — local summaries must never leak coordinates. Pure:
 * no DB reads or writes happen here; the caller supplies the notes.
 */
import type { ModelProfile } from "../modelProfiles";
import { normalizeProse, type NormalizeOptions } from "../normalize";
import { makeAiError, type AiResult, type GenerateFn } from "../types";

const COORD_PATTERN = /-?\d{1,3}\.\d+\s*,\s*-?\d{1,3}\.\d+/;

/** Summary density. Anything else is refused (invalid enum). */
export const SUMMARY_DENSITIES = ["short", "detailed"] as const;
export type SummaryDensity = (typeof SUMMARY_DENSITIES)[number];

export function isSummaryDensity(value: unknown): value is SummaryDensity {
  return typeof value === "string" && (SUMMARY_DENSITIES as readonly string[]).includes(value);
}

export const SUMMARY_NOTES_MAX_CHARS = 2000;
export const SUMMARY_MAX_CHARS = 500;

const SHORT_INSTRUCTION =
  "Summarize the on-device context notes in one sentence, at most 280 " +
  "characters. Never include coordinates. No JSON, no markdown fences.";

const DETAILED_INSTRUCTION =
  "Summarize the on-device context notes in 2-4 sentences, at most 500 " +
  "characters. Never include coordinates. No JSON, no markdown fences.";

export function instructionForDensity(density: SummaryDensity): string {
  return density === "short" ? SHORT_INSTRUCTION : DETAILED_INSTRUCTION;
}

export interface SummarizeLocalContextInput {
  readonly notes: string;
  readonly density?: SummaryDensity;
}

export interface LocalContextSummary {
  readonly summaryText: string;
  readonly density: SummaryDensity;
}

export type SummarizeLocalContextOptions = NormalizeOptions & {
  readonly signal?: AbortSignal;
};

export function buildSummarizePrompt(input: SummarizeLocalContextInput, density: SummaryDensity): string {
  return `${instructionForDensity(density)}\nContext notes: ${input.notes}`;
}

function raceWithSignal(task: Promise<string>, signal: AbortSignal | undefined): Promise<string> {
  if (signal === undefined) return task;
  return new Promise<string>((resolve, reject) => {
    const onAbort = (): void => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    task.then(
      (text) => {
        signal.removeEventListener("abort", onAbort);
        resolve(text);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export async function summarizeLocalContext(
  generate: GenerateFn,
  input: SummarizeLocalContextInput,
  profile: ModelProfile,
  options?: SummarizeLocalContextOptions,
): Promise<AiResult<LocalContextSummary>> {
  const signal = options?.signal;
  if (signal !== undefined && signal.aborted) {
    return { ok: false, error: makeAiError("CANCELLED", "ABORT_BEFORE_START") };
  }
  if (typeof input.notes !== "string") {
    return { ok: false, error: makeAiError("INVALID_OUTPUT", "R1_BAD_INPUT:notes") };
  }
  if (input.notes.trim() === "") {
    return { ok: false, error: makeAiError("INVALID_OUTPUT", "R4_EMPTY_INPUT") };
  }
  const density = input.density ?? "short";
  if (!isSummaryDensity(input.density ?? "short")) {
    return { ok: false, error: makeAiError("INVALID_OUTPUT", `R1_UNKNOWN_DENSITY:${String(input.density)}`) };
  }
  if (input.notes.length > SUMMARY_NOTES_MAX_CHARS) {
    return { ok: false, error: makeAiError("INVALID_OUTPUT", "R5_INPUT_TOO_LONG:notes") };
  }
  const instruction = instructionForDensity(density);
  let rawText: string;
  try {
    rawText = await raceWithSignal(
      generate(buildSummarizePrompt(input, density), {
        maxOutputTokens: profile.maxOutputTokensText,
        temperature: profile.defaultTemperature,
      }),
      signal,
    );
  } catch {
    return { ok: false, error: makeAiError("CANCELLED", "ABORT_MID_GENERATION") };
  }
  if (signal !== undefined && signal.aborted) {
    return { ok: false, error: makeAiError("CANCELLED", "ABORT_MID_GENERATION") };
  }
  const context = {
    instruction,
    userContext: options?.context?.userContext ?? input.notes,
  };
  const parsed = normalizeProse(rawText, profile, { ...options, context });
  if (!parsed.ok) return parsed;
  if (parsed.value.length > SUMMARY_MAX_CHARS) {
    return { ok: false, error: makeAiError("INVALID_OUTPUT", "R5_SUMMARY_TOO_LONG") };
  }
  if (COORD_PATTERN.test(parsed.value)) {
    return { ok: false, error: makeAiError("INVALID_OUTPUT", "R5_COORDINATES_NOT_ACCEPTED:summary") };
  }
  return { ok: true, value: { summaryText: parsed.value, density } };
}

