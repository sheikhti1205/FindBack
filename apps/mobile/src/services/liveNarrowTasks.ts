/**
 * Live narrow-task transport — strictly on-device.
 *
 * Narrow tasks (Smart Search filter extraction, report-field and category
 * suggestions) are served only by the on-device router. There is deliberately
 * no cloud fallback: a natural-language query about a user's lost property must
 * never leave the device. When the local helper is unavailable the caller fails
 * closed (see `nlExtractLive`, which yields an empty patch), and the ordinary
 * non-AI path keeps working.
 *
 * Suggestions only — nothing here publishes, writes drafts, or auto-applies.
 *
 * - `generateLocalFirst(taskId, prompt)`: routes one task via
 *   `getApplicationAi().route(taskId, { prompt }, { traceId, consent: true })`.
 *   A non-ok route throws `Error(result.error)`; a string value passes
 *   through as-is, any other value is JSON-stringified for the op parsers.
 *   AbortError always propagates (never swallowed).
 * - `liveGenerateFor(taskId)` is the composer the consumer features use. It is
 *   local-only, so a local failure surfaces to the caller unchanged.
 * - The legacy cloud transports (`generateCloud`, `generateCloudForAccount`) are
 *   retained only for the guided Help assistant: `Help.tsx` imports
 *   `generateCloudForAccount` alone, and `generateCloud` has no production
 *   consumer. Both go when Help does; nothing in the narrow-task path calls
 *   either.
 */
import { getApplicationAi } from "./ai/applicationAi";
import { createOpenRouterClient } from "./openRouter";
import { aiCredentials } from "./aiCredentials";
import { getSupabase } from "./supabaseClient";
// Still used by the legacy cloud transport's on-device-only privacy guard.
import { loadSeededAiPreferences } from "./ai/aiPreferences";
import { profileFor } from "./ai/modelProfiles";
import { NEEDLE_MODEL_ID } from "./ai/needle/embedder";
import type { AiTaskId, GenerateFn } from "./ai/types";
import { extractNlFilters, type NlFilterPatch } from "./search/nlFilters";

export type LiveNarrowTaskId =
  | "extract-search-filters"
  | "extract-report-fields"
  | "classify-category";

export interface LocalFirstOptions {
  readonly signal?: AbortSignal;
  /**
   * Phase A.4: raw task input routed to the on-device engine instead of
   * the engineered prompt. Absent means the prompt itself is the input
   * (legacy callers).
   */
  readonly localInput?: unknown;
}

function abortError(): Error {
  const error = new Error("AI request cancelled.");
  error.name = "AbortError";
  return error;
}

/**
 * One on-device generation against the local router. Throws on
 * non-ok routes; AbortError propagates untouched.
 */
export async function generateLocalFirst(
  taskId: LiveNarrowTaskId | AiTaskId,
  prompt: string,
  opts?: LocalFirstOptions,
): Promise<string> {
  if (opts?.signal?.aborted) throw abortError();
  // No catch here: route rejections (including AbortError on user cancel)
  // propagate to the caller, which decides fail-closed behaviour.
  // The local route gets the raw task input when the op supplied one —
  // a tool model must see the original request, not an engineered prompt.
  const input = opts?.localInput ?? { prompt };
  const result: Awaited<ReturnType<import("./ai/applicationAi").ApplicationAiService["route"]>> =
    await getApplicationAi().route(
      taskId,
      input,
      { traceId: crypto.randomUUID(), consent: true, ...(opts?.signal ? { signal: opts.signal } : {}) },
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
 * Live `GenerateFn` for one narrow task. On-device only, by design: a local
 * failure is surfaced to the caller instead of being escalated to any network
 * transport. An abort (thrown or pre-signalled) propagates untouched.
 */
export function liveGenerateFor(taskId: LiveNarrowTaskId): GenerateFn {
  return async (prompt, genOpts) => {
    const signal = (genOpts as unknown as { signal?: AbortSignal } | undefined)?.signal;
    if (signal?.aborted) throw abortError();
    try {
      return await generateLocalFirst(taskId, prompt, {
        signal,
        ...(genOpts.localTaskInput !== undefined ? { localInput: genOpts.localTaskInput } : {}),
      });
    } catch (error) {
      // A cancel that races a local failure must still surface as an abort
      // rather than as a generic engine error — and it must never escalate.
      if (signal?.aborted) throw abortError();
      throw error;
    }
  };
}

/** Live composer for the report-fields suggestion op. */
export const generateForFieldsLive: GenerateFn = liveGenerateFor("extract-report-fields");

/** Live composer for the category suggestion op. */
export const generateForCategoryLive: GenerateFn = liveGenerateFor("classify-category");

/**
 * Profile for the search extractor: the model that actually serves the route.
 * `extract-search-filters` is a tool-constrained (structured) task, and the
 * production seam serves structured roles ONLY through Needle
 * (`applicationAi.ts` `structuredModelId`, enforced in `productionRuntimes.ts`).
 * Parsing with the Qwen *prose* profile applied that engine's `[thought]`
 * envelope to tool output, which truncated any value containing the literal
 * marker and silently dropped the whole patch.
 */
const SEARCH_PROFILE_ID = NEEDLE_MODEL_ID;

/**
 * Live NL search extractor: raw input through `extract-search-filters`
 * (on-device only) mapped to a validated patch. Fail-closed:
 * empty input never calls generate, and any failure yields an empty patch
 * via `extractNlFilters`.
 */
export async function nlExtractLive(input: string): Promise<NlFilterPatch> {
  const profile = profileFor(SEARCH_PROFILE_ID);
  if (!profile) return {};
  return extractNlFilters(liveGenerateFor("extract-search-filters"), input, profile);
}
