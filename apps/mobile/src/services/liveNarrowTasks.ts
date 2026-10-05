/**
 * Live narrow-task transport (local-first with cloud fallback).
 *
 * Mirrors the shipped photo path (analyzeReportPhoto.ts /
 * analyzeReportPhotoLocal.ts): on-device `route(...)` is the DEFAULT engine
 * and OpenRouter cloud text is the fallback. Suggestions only — nothing here
 * publishes, writes drafts, or auto-applies.
 *
 * - `generateLocalFirst(taskId, prompt)`: routes one task via
 *   `getApplicationAi().route(taskId, { prompt }, { traceId, consent: true })`.
 *   A non-ok route throws `Error(result.error)`; a string value passes
 *   through as-is, any other value is JSON-stringified for the op parsers.
 *   AbortError always propagates (never swallowed, never falls back).
 * - Cloud `GenerateFn`: `createOpenRouterClient(getConnectedOpenRouterKey)`
 *   `.text(prompt, { signal })`. A missing key surfaces honestly as
 *   MISSING_KEY from the transport.
 * - `liveGenerateFor(taskId)`: try local; on non-abort failure fall back to
 *   cloud; an abort never touches the network.
 */
import { getApplicationAi } from "./ai/applicationAi";
import { createOpenRouterClient } from "./openRouter";
import { getConnectedOpenRouterKey } from "./aiCredentials";
import { profileFor } from "./ai/modelProfiles";
import type { AiTaskId, GenerateFn } from "./ai/types";
import { extractNlFilters, type NlFilterPatch } from "./search/nlFilters";

export type LiveNarrowTaskId =
  | "extract-search-filters"
  | "extract-report-fields"
  | "classify-category";

export interface LocalFirstOptions {
  readonly signal?: AbortSignal;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function abortError(): Error {
  const error = new Error("AI request cancelled.");
  error.name = "AbortError";
  return error;
}

/**
 * One local-first generation against the on-device router. Throws on
 * non-ok routes; AbortError propagates untouched.
 */
export async function generateLocalFirst(
  taskId: LiveNarrowTaskId | AiTaskId,
  prompt: string,
  opts?: LocalFirstOptions,
): Promise<string> {
  if (opts?.signal?.aborted) throw abortError();
  let result: Awaited<ReturnType<import("./ai/applicationAi").ApplicationAiService["route"]>>;
  try {
    result = await getApplicationAi().route(
      taskId,
      { prompt },
      { traceId: crypto.randomUUID(), consent: true },
    );
  } catch (error) {
    // AbortError (user cancel) must stop the whole request, never fall back.
    throw error;
  }
  if (opts?.signal?.aborted) throw abortError();
  if (!result.ok) throw new Error(result.error);
  const value = (result as { value?: unknown }).value;
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Cloud text transport. Missing keys surface honestly (MISSING_KEY). */
export const generateCloud: GenerateFn = async (prompt, genOpts) => {
  const signal = (genOpts as unknown as { signal?: AbortSignal } | undefined)?.signal;
  return createOpenRouterClient(getConnectedOpenRouterKey).text(prompt, { signal });
};

/**
 * Live `GenerateFn` for one narrow task: local first, cloud fallback on any
 * non-abort local failure. An abort (thrown or pre-signalled) never touches
 * the network.
 */
export function liveGenerateFor(taskId: LiveNarrowTaskId): GenerateFn {
  return async (prompt, genOpts) => {
    const signal = (genOpts as unknown as { signal?: AbortSignal } | undefined)?.signal;
    if (signal?.aborted) throw abortError();
    try {
      return await generateLocalFirst(taskId, prompt, { signal });
    } catch (error) {
      if (isAbort(error) || signal?.aborted) throw error;
      return generateCloud(prompt, genOpts);
    }
  };
}

/** Live composer for the report-fields suggestion op. */
export const generateForFieldsLive: GenerateFn = liveGenerateFor("extract-report-fields");

/** Live composer for the category suggestion op. */
export const generateForCategoryLive: GenerateFn = liveGenerateFor("classify-category");

const SEARCH_PROFILE_ID = "qwen3-0.6b-dynamic-int4";

/**
 * Live NL search extractor: raw input through `extract-search-filters`
 * (local-first, cloud fallback) mapped to a validated patch. Fail-closed:
 * empty input never calls generate, and any failure yields an empty patch
 * via `extractNlFilters`.
 */
export async function nlExtractLive(input: string): Promise<NlFilterPatch> {
  const profile = profileFor(SEARCH_PROFILE_ID);
  if (!profile) return {};
  return extractNlFilters(liveGenerateFor("extract-search-filters"), input, profile);
}
