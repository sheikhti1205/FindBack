/**
 * Narrow op: extract-report-fields.
 *
 * The model emits ONE small slot object (title, description, category,
 * dateText, locationNote). Missing or ambiguous location is a successful
 * ASK_USER state — never guessed coordinates, never an error.
 */
import type { ModelProfile } from "../modelProfiles";
import { makeAskUserPrompt } from "../clarificationCopy";
import { normalizeJsonOp, validateReportSlots, type NormalizeOptions } from "../normalize";
import type {
  AiResult,
  AssistantAction,
  GenerateFn,
  ReportExtraction,
} from "../types";

export const REPORT_SLOTS_INSTRUCTION =
  "Extract report slots. Return ONLY one JSON object with any of " +
  '"title", "description", "category", "dateText", "locationNote" as short ' +
  "strings. Omit unknown slots. Never invent coordinates. No markdown, no commentary.";

export function buildReportSlotsPrompt(userMessage: string): string {
  return `${REPORT_SLOTS_INSTRUCTION}\nUser message: ${userMessage}`;
}

export async function extractReportFields(
  generate: GenerateFn,
  userMessage: string,
  profile: ModelProfile,
  options?: NormalizeOptions,
): Promise<AiResult<ReportExtraction>> {
  const rawText = await generate(buildReportSlotsPrompt(userMessage), {
    maxOutputTokens: profile.maxOutputTokensText,
    temperature: profile.defaultTemperature,
  });
  const context = {
    instruction: REPORT_SLOTS_INSTRUCTION,
    userContext: options?.context?.userContext ?? userMessage,
  };
  const parsed = normalizeJsonOp(
    rawText,
    profile,
    (value, innerContext) => validateReportSlots(value, innerContext),
    { ...options, context },
  );
  if (!parsed.ok) return parsed;
  const action: AssistantAction =
    parsed.value.locationNote === undefined
      ? { action: "ASK_USER", prompt: makeAskUserPrompt({ field: "location" }) }
      : { action: "NONE" };
  return { ok: true, value: { fields: parsed.value, action } };
}

