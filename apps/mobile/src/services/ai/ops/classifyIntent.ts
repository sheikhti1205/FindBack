/**
 * Narrow op: classify-intent (Task 21).
 *
 * The model emits ONE small JSON object carrying an intent enum. A missing
 * action defaults deterministically in code (intentDefaultAction); a
 * model-supplied action is allowlist-checked (unknown actions surface as
 * UNSUPPORTED_ACTION per the frozen mapping) and never applied here.
 * Evidence: T07 "I lost something." needs UNKNOWN → ASK_USER clarification.
 */
import type { ModelProfile } from "../modelProfiles";
import { normalizeJsonOp, validateIntentPayload, type NormalizeOptions } from "../normalize";
import type { AiResult, ClassifiedIntent, GenerateFn } from "../types";

export const CLASSIFY_INTENT_INSTRUCTION =
  "Classify the user message. Return ONLY one JSON object like " +
  '{"intent":"REPORT_LOST"} with intent one of REPORT_LOST, REPORT_FOUND, ' +
  "SEARCH, APP_QUESTION, OPEN_QUESTION, UNKNOWN. No markdown, no commentary.";

export function buildClassifyIntentPrompt(userMessage: string): string {
  return `${CLASSIFY_INTENT_INSTRUCTION}\nUser message: ${userMessage}`;
}

export async function classifyIntent(
  generate: GenerateFn,
  userMessage: string,
  profile: ModelProfile,
  options?: NormalizeOptions,
): Promise<AiResult<ClassifiedIntent>> {
  const rawText = await generate(buildClassifyIntentPrompt(userMessage), {
    maxOutputTokens: profile.maxOutputTokensText,
    temperature: profile.defaultTemperature,
  });
  return normalizeJsonOp(rawText, profile, (value) => validateIntentPayload(value), options);
}
