/**
 * Central clarification copy for FindBack on-device assistance.
 *
 * Design decision: CENTRALIZE with contextual override. Defaults live here
 * keyed by ClarificationField; ops provide {field, context, options} and the
 * copy layer produces wording. An op may supply an evidence-backed
 * questionOverride (e.g. "Which Central Park do you mean?" beats the generic
 * location default). Never one inflexible global sentence, never duplicated
 * per-op strings. ASK_USER shape is unchanged (types.ts owns it).
 */
import {
  ASK_USER_OPTIONS_MAX,
  ASK_USER_OPTION_MAX,
  ASK_USER_QUESTION_MAX,
  type AskUserPrompt,
  type ClarificationField,
} from "./types";

export const DEFAULT_CLARIFICATION_QUESTIONS: Record<ClarificationField, string> = {
  location: "Where was the item lost or found? A nearby landmark or area name is enough.",
  category: "Which category best describes the item? For example, keys, wallet, or phone.",
  date: "When was the item lost or found? An approximate date is enough.",
  photo: "Could you add a photo of the item? It helps identify it.",
  query: "Could you say a little more about what you need?",
  other: "Could you share a little more detail?",
};

export interface ClarificationRequest {
  readonly field: ClarificationField;
  readonly context?: string;
  readonly options?: readonly string[];
  readonly questionOverride?: string;
}

export function defaultClarificationQuestion(field: ClarificationField): string {
  return DEFAULT_CLARIFICATION_QUESTIONS[field];
}

export function makeAskUserPrompt(request: ClarificationRequest): AskUserPrompt {
  const override = request.questionOverride?.trim();
  const question =
    override !== undefined && override.length > 0 && override.length <= ASK_USER_QUESTION_MAX
      ? override
      : DEFAULT_CLARIFICATION_QUESTIONS[request.field];
  if (request.options === undefined) {
    return { question, field: request.field };
  }
  const cleaned = request.options
    .map((option) => option.trim())
    .filter((option) => option.length > 0 && option.length <= ASK_USER_OPTION_MAX)
    .slice(0, ASK_USER_OPTIONS_MAX);
  if (cleaned.length === 0) {
    return { question, field: request.field };
  }
  return { question, field: request.field, options: cleaned };
}
