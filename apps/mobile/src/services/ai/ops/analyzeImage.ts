/**
 * Narrow op: analyze-image.
 *
 * Structured vision path: the model emits ONE 9-field photo object under
 * the canonical VLM instruction. Strict schema validation + R5/R6 guards
 * are mandatory (SmolVLM2-500M-vision is 0/12 valid without them).
 * One-retry-then-fail-closed per faultScenarios photo-invalid; the retry
 * budget comes from profile.retryLimit (1).
 */
import type { ModelProfile } from "../modelProfiles";
import { normalizeJsonOp, validatePhotoAnalysis, type NormalizeOptions } from "../normalize";
import { taskSpecFor, type AiTaskSpec } from "../taskSpecs";
import { PHOTO_ANALYSIS_KEYS, type AiResult, type GenerateFn, type PhotoAnalysis } from "../types";

export const PHOTO_INSTRUCTION =
  "Analyze the photo. Return ONLY one JSON object with exactly these keys: " +
  PHOTO_ANALYSIS_KEYS.join(", ") +
  ". Use null for unknown scalars and [] for unknown arrays. " +
  "No markdown, no commentary.";

export function buildPhotoPrompt(userContext?: string): string {
  return userContext === undefined || userContext.trim() === ""
    ? PHOTO_INSTRUCTION
    : `${PHOTO_INSTRUCTION}\nUser context: ${userContext}`;
}

export interface AnalyzeImageInput {
  readonly imageUri: string;
  readonly userContext?: string;
}

export async function analyzeImage(
  generate: GenerateFn,
  input: AnalyzeImageInput,
  profile: ModelProfile,
  options?: NormalizeOptions,
): Promise<AiResult<PhotoAnalysis>> {
  void input.imageUri;
  const prompt = buildPhotoPrompt(input.userContext);
  const context = {
    instruction: PHOTO_INSTRUCTION,
    userContext: input.userContext ?? options?.context?.userContext,
  };
  const attempts = profile.retryLimit + 1;
  let last: AiResult<PhotoAnalysis> = {
    ok: false,
    error: { errorClass: "INVALID_OUTPUT", diagnostic: "R1_NO_ATTEMPT" },
  };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const rawText = await generate(prompt, {
      maxOutputTokens: profile.maxOutputTokensVision ?? profile.maxOutputTokensText,
      temperature: profile.defaultTemperature,
    });
    const parsed = normalizeJsonOp(
      rawText,
      profile,
      (value, innerContext) => validatePhotoAnalysis(value, innerContext),
      { ...options, context },
    );
    if (parsed.ok) return parsed;
    if (parsed.error.errorClass !== "INVALID_OUTPUT") return parsed;
    last = parsed;
  }
  return last;
}

export const analyzeImageTaskSpec: AiTaskSpec = taskSpecFor("analyze-image");
