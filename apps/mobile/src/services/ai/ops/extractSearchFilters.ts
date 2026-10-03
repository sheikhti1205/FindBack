/**
 * Narrow op: extract-search-filters.
 *
 * The model emits ONE small slot object (query, category, status,
 * dateRangeText). Ambiguous or empty filters are a successful ASK_USER
 * state (faultScenarios search-ambiguous-place). Status stays free text:
 * no report-status enum exists in this contract (schema is out of scope),
 * so enum binding is deferred to the schema owner.
 */
import type { ModelProfile } from "../modelProfiles";
import { makeAskUserPrompt } from "../clarificationCopy";
import { normalizeJsonOp, validateSearchFilters, type NormalizeOptions } from "../normalize";
import { taskSpecFor, type AiTaskSpec } from "../taskSpecs";
import type {
  AiResult,
  AssistantAction,
  GenerateFn,
  SearchExtraction,
} from "../types";

export const SEARCH_SLOTS_INSTRUCTION =
  "Extract search filters. Return ONLY one JSON object with any of " +
  '"query", "category", "status", "dateRangeText" as short strings. Omit ' +
  "unknown slots. Never invent coordinates. No markdown, no commentary.";

export function buildSearchSlotsPrompt(userMessage: string): string {
  return `${SEARCH_SLOTS_INSTRUCTION}\nUser message: ${userMessage}`;
}

export async function extractSearchFilters(
  generate: GenerateFn,
  userMessage: string,
  profile: ModelProfile,
  options?: NormalizeOptions,
): Promise<AiResult<SearchExtraction>> {
  const rawText = await generate(buildSearchSlotsPrompt(userMessage), {
    maxOutputTokens: profile.maxOutputTokensText,
    temperature: profile.defaultTemperature,
  });
  const context = {
    instruction: SEARCH_SLOTS_INSTRUCTION,
    userContext: options?.context?.userContext ?? userMessage,
  };
  const parsed = normalizeJsonOp(
    rawText,
    profile,
    (value, innerContext) => validateSearchFilters(value, innerContext),
    { ...options, context },
  );
  if (!parsed.ok) return parsed;
  const hasFilter =
    parsed.value.query !== undefined ||
    parsed.value.category !== undefined ||
    parsed.value.status !== undefined ||
    parsed.value.dateRangeText !== undefined;
  const action: AssistantAction = hasFilter
    ? { action: "NONE" }
    : { action: "ASK_USER", prompt: makeAskUserPrompt({ field: "query" }) };
  return { ok: true, value: { fields: parsed.value, action } };
}

export const extractSearchFiltersTaskSpec: AiTaskSpec = taskSpecFor("extract-search-filters");
