/**
 * Report-photo disambiguation over the ground-objects op.
 *
 * Hook-ready service (no UI wired yet): given a report photo plus a
 * referring expression, it returns validated selector options for a
 * "Which item are you reporting?" prompt. Boxes are presentation-only —
 * this module never crops, writes, or otherwise acts on coordinates.
 *
 * Fail-closed throughout: without explicit image consent, on invalid
 * boxes, or on op failure, callers get an error or zero options — never
 * invented boxes.
 */
import type { ModelProfile } from "./ai/modelProfiles";
import { groundObjects, type GroundBox } from "./ai/ops/groundObjects";
import { makeAiError, type AiResult, type GenerateFn } from "./ai/types";

export interface GroundedOption {
  readonly id: string;
  readonly label: string;
  /** Presentation-only overlay geometry (relative-0-1000 space). */
  readonly box: GroundBox;
}

export interface GroundedOptions {
  readonly options: readonly GroundedOption[];
  /** Selector copy: disambiguation question, or a no-match fallback. */
  readonly question: string;
}

export interface PhotoGroundingInput {
  readonly imageUri: string;
  readonly referringExpression: string;
  /** Must be true: grounding describes user-photo content. */
  readonly imageConsent?: boolean;
}

/** Selector copy for the disambiguation prompt. */
export function groundingQuestion(optionCount: number): string {
  if (optionCount <= 0) {
    return "Which item are you reporting? No confident match — describe it instead.";
  }
  if (optionCount === 1) return "Which item are you reporting?";
  return `Which item are you reporting? (${optionCount} options)`;
}

/**
 * Ground a referring expression in a report photo. Returns selector-ready
 * options; an empty match set yields zero options (not invented boxes).
 * UI wiring is intentionally absent: import these helpers in the report
 * flow only after review.
 */
export async function requestGroundedOptions(
  generate: GenerateFn,
  profile: ModelProfile,
  input: PhotoGroundingInput,
): Promise<AiResult<GroundedOptions>> {
  if (input.imageConsent !== true) {
    return {
      ok: false,
      error: makeAiError("UNSUPPORTED_REQUEST", "CONSENT_REQUIRED:image", "Grounding needs image consent."),
    };
  }
  if (typeof input.imageUri !== "string" || input.imageUri.trim() === "") {
    return { ok: false, error: makeAiError("INVALID_OUTPUT", "R1_BAD_INPUT:imageUri") };
  }
  if (typeof input.referringExpression !== "string" || input.referringExpression.trim() === "") {
    return { ok: false, error: makeAiError("INVALID_OUTPUT", "R1_BAD_INPUT:referringExpression") };
  }
  const grounded = await groundObjects(
    generate,
    { imageUri: input.imageUri, referringExpression: input.referringExpression },
    profile,
    { imageConsent: true },
  );
  if (!grounded.ok) return grounded;
  const options: GroundedOption[] = grounded.value.boxes.map((box, index) => ({
    id: `ground-${index}`,
    label: box.label,
    box,
  }));
  return {
    ok: true,
    value: { options, question: groundingQuestion(options.length) },
  };
}

/** Pure selector: pick a grounded option by id, or undefined (no guessing). */
export function selectGroundedOption(
  options: readonly GroundedOption[],
  id: string,
): GroundedOption | undefined {
  return options.find((option) => option.id === id);
}

export interface CssPercentRect {
  readonly leftPct: number;
  readonly topPct: number;
  readonly widthPct: number;
  readonly heightPct: number;
}

/**
 * Convert a 0-1000 relative box to CSS percentages for overlay rendering
 * only. The result must never drive crops, writes, or location inference.
 */
export function toCssPercentRect(box: GroundBox): CssPercentRect {
  return {
    leftPct: box.x / 10,
    topPct: box.y / 10,
    widthPct: box.w / 10,
    heightPct: box.h / 10,
  };
}
