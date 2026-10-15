/**
 * Narrow op: extract-report-fields.
 *
 * The model emits ONE small slot object (title, description, category,
 * dateText, locationNote). Missing or ambiguous location is a successful
 * ASK_USER state — never guessed coordinates, never an error.
 */
import type { ModelProfile } from "../modelProfiles";
import { makeAskUserPrompt } from "../clarificationCopy";
import { normalizeJsonOp, validateReportSlots, validateSlotEnvelope, type NormalizeOptions } from "../normalize";
import {
  makeAiError,
  type AiResult,
  type AssistantAction,
  type GenerateFn,
  type ReportExtraction,
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
  let rawText: string;
  try {
    rawText = await generate(buildReportSlotsPrompt(userMessage), {
      maxOutputTokens: profile.maxOutputTokensText,
      temperature: profile.defaultTemperature,
      // The on-device route receives the raw request (a tool model selects
      // and fills its tool from what the user said); cloud keeps the prompt.
      localTaskInput: { text: userMessage },
    });
  } catch (error) {
    // This op promises `AiResult`, so an engine failure has to come back as a
    // result: a rejection here only surfaces if every caller remembers its own
    // try/catch, and a transient on-device failure then reads as nothing at all.
    // A real cancellation stays CANCELLED — the screen shows "AI request
    // cancelled." for that class and must not show it for a failure.
    if (error instanceof Error && error.name === "AbortError") {
      return { ok: false, error: makeAiError("CANCELLED", "ABORT_MID_GENERATION") };
    }
    return { ok: false, error: makeAiError("RUNTIME_ERROR", "FIELDS_GENERATION_FAILED") };
  }
  const context = {
    instruction: REPORT_SLOTS_INSTRUCTION,
    userContext: options?.context?.userContext ?? userMessage,
  };
  const parsed = normalizeJsonOp(
    rawText,
    profile,
    (value, innerContext) => validateSlotEnvelope(value, (candidate) => validateReportSlots(candidate, innerContext), innerContext),
    { ...options, context },
  );
  if (!parsed.ok) return parsed;
  const action: AssistantAction =
    parsed.value.locationNote === undefined
      ? { action: "ASK_USER", prompt: makeAskUserPrompt({ field: "location" }) }
      : { action: "NONE" };
  return { ok: true, value: { fields: parsed.value, action } };
}

