/**
 * Live narrow-task transport (local-first with cloud fallback).
 *
 * Automatic tries on-device `route(...)` before OpenRouter cloud text.
 * On-device only never reads a cloud key; cloud only skips local inference.
 * Suggestions only — nothing here publishes, writes drafts, or auto-applies.
 *
 * - `generateLocalFirst(taskId, prompt)`: routes one task via
 *   `getApplicationAi().route(taskId, { prompt }, { traceId, consent: true })`.
 *   A non-ok route throws `Error(result.error)`; a string value passes
 *   through as-is, any other value is JSON-stringified for the op parsers.
 *   AbortError always propagates (never swallowed, never falls back).
 * - Cloud transport captures the authenticated account, checks privacy and
 *   cancellation around asynchronous key access, then uses the free route.
 *   A missing key surfaces honestly as MISSING_KEY from the transport.
 * - `liveGenerateFor(taskId)` resolves the current account's mode each call;
 *   cancellation and account changes never authorize cloud fallback.
 */
import { getApplicationAi } from "./ai/applicationAi";
import { createOpenRouterClient } from "./openRouter";
import { aiCredentials } from "./aiCredentials";
import { getSupabase } from "./supabaseClient";
import { loadSeededAiPreferences } from "./ai/aiPreferences";
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
  // No catch here: route rejections (including AbortError on user cancel)
  // propagate to the caller, which decides fallback vs fail-closed.
  const result: Awaited<ReturnType<import("./ai/applicationAi").ApplicationAiService["route"]>> =
    await getApplicationAi().route(
      taskId,
      { prompt },
      { traceId: crypto.randomUUID(), consent: true },
    );
  if (opts?.signal?.aborted) throw abortError();
  if (!result.ok) {
    if (/cancel|abort/i.test(result.error) || /cancel|abort/i.test(result.state)) throw abortError();
    throw new Error(result.error);
  }
  const value = (result as { value?: unknown }).value;
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Cloud text transport. Missing keys surface honestly (MISSING_KEY). */
export const generateCloud: GenerateFn = async (prompt, genOpts) => {
  const signal = (genOpts as unknown as { signal?: AbortSignal } | undefined)?.signal;
  const account = await authenticatedAccount();
  return generateCloudForAccount(account, prompt, signal);
};

async function authenticatedAccount(): Promise<string | null> {
  const { data, error } = await getSupabase().auth.getSession();
  if (error) throw error;
  return data.session?.user.id ?? null;
}

/** Capture the owning account before asynchronous local work; never retarget a send. */
export async function generateCloudForAccount(account: string | null, prompt: string, signal?: AbortSignal): Promise<string> {
  const assertCloudAllowed = async () => {
    if (signal?.aborted) throw abortError();
    const currentAccount = await authenticatedAccount();
    if (signal?.aborted) throw abortError();
    if (!account || currentAccount !== account) throw new Error("AI account changed or is not authenticated.");
    if (loadSeededAiPreferences(account).assistantMode === "on-device-only") throw new Error("On-device only: cloud is disabled.");
  };
  await assertCloudAllowed();
  if (!account) throw new Error("AI account is not authenticated.");
  return createOpenRouterClient(async () => {
    await assertCloudAllowed();
    const key = await aiCredentials.get(account, "openrouter");
    await assertCloudAllowed();
    return key;
  }).text(prompt, { signal });
}

/**
 * Live `GenerateFn` for one narrow task: local first, cloud fallback on any
 * non-abort local failure. An abort (thrown or pre-signalled) never touches
 * the network.
 */
export function liveGenerateFor(taskId: LiveNarrowTaskId): GenerateFn {
  return async (prompt, genOpts) => {
    const signal = (genOpts as unknown as { signal?: AbortSignal } | undefined)?.signal;
    if (signal?.aborted) throw abortError();
    const account = await authenticatedAccount();
    if (signal?.aborted) throw abortError();
    const mode = loadSeededAiPreferences(account ?? "local").assistantMode;
    if (mode === "cloud-only") return generateCloudForAccount(account, prompt, signal);
    try {
      return await generateLocalFirst(taskId, prompt, { signal });
    } catch (error) {
      if (signal?.aborted) throw abortError();
      if (isAbort(error) || mode === "on-device-only") throw error;
      return generateCloudForAccount(account, prompt, signal);
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
