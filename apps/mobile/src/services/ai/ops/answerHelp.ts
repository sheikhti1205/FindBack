/**
 * Narrow op: answer-help — the single app-help op, grounded in the current
 * FindBack capability knowledge (appKnowledge.ts).
 *
 * Prose path: no JSON required. The prompt carries the versioned knowledge
 * block so the model answers from shipped capabilities; output is
 * thought-stripped (R2, Qwen profile only), refusal/empty-checked (R4),
 * bounded, echo-checked (R6), and screened for SQL/private-data/model-claim
 * leakage (groundAppAnswer) before it is shown.
 */
import type { ModelProfile } from "../modelProfiles";
import { getCurrentKnowledge, groundAppAnswer } from "../appKnowledge";
import { normalizeProse, type NormalizeOptions } from "../normalize";
import type { AiResult, GenerateFn, HelpAnswer } from "../types";

export const HELP_INSTRUCTION =
  "Answer the user's question about the FindBack app briefly in 1-3 " +
  "sentences. If the question is unclear, ask one clarifying question. " +
  "Do not wrap the answer in JSON or markdown fences.";

export function buildHelpPrompt(userMessage: string): string {
  const knowledge = getCurrentKnowledge();
  return (
    `${HELP_INSTRUCTION}\n` +
    `[knowledge version=${knowledge.version}]\n${knowledge.text}\n` +
    `User question: ${userMessage}`
  );
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
  // Screen before showing: SQL, private data and model-identity claims are
  // replaced with the honest grounded reply (same contract as the Help
  // ask-path screening). Safe answers pass through untouched.
  const grounded = groundAppAnswer(parsed.value);
  if (!grounded.safe) {
    return { ok: true, value: { answerText: grounded.reply, action: { action: "NONE" } } };
  }
  return { ok: true, value: { answerText: grounded.text, action: { action: "NONE" } } };
}

