/**
 * Narrow op: answer-help (Task 21).
 *
 * Prose path: no JSON required. Output is thought-stripped (R2, Qwen
 * profile only), refusal/empty-checked (R4), bounded, and echo-checked
 * (R6). Hallucinated app features are out of scope here: no
 * APP_CAPABILITIES list exists in evidence, so this op does not judge
 * factuality — it normalizes shape only.
 */
import type { ModelProfile } from "../modelProfiles";
import { normalizeProse, type NormalizeOptions } from "../normalize";
import type { AiResult, GenerateFn, HelpAnswer } from "../types";

export const HELP_INSTRUCTION =
  "Answer the user's question about the FindBack app briefly in 1-3 " +
  "sentences. If the question is unclear, ask one clarifying question. " +
  "Do not wrap the answer in JSON or markdown fences.";

export function buildHelpPrompt(userMessage: string): string {
  return `${HELP_INSTRUCTION}\nUser question: ${userMessage}`;
}

export async function answerHelp(
  generate: GenerateFn,
  userMessage: string,
  profile: ModelProfile,
  options?: NormalizeOptions,
): Promise<AiResult<HelpAnswer>> {
  const rawText = await generate(buildHelpPrompt(userMessage), {
    maxOutputTokens: profile.maxOutputTokensText,
    temperature: profile.defaultTemperature,
  });
  const context = {
    instruction: HELP_INSTRUCTION,
    userContext: options?.context?.userContext ?? userMessage,
  };
  const parsed = normalizeProse(rawText, profile, { ...options, context });
  if (!parsed.ok) return parsed;
  return { ok: true, value: { answerText: parsed.value, action: { action: "NONE" } } };
}
