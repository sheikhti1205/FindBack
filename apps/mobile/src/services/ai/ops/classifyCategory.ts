/**
 * Narrow op: classify-category.
 *
 * The model emits ONE small JSON object carrying a category enum for short
 * item text. Pure: no DB writes, no side effects. Business rules: category
 * inputs never carry coordinates (reuse the codebase no-coordinates policy),
 * and confidence — when supplied — must be a 0-1 finite number.
 */
import type { ModelProfile } from "../modelProfiles";
import { normalizeJsonOp, type NormalizeContext, type NormalizeOptions } from "../normalize";
import { makeAiError, type AiResult, type GenerateFn } from "../types";

const COORD_PATTERN = /-?\d{1,3}\.\d+\s*,\s*-?\d{1,3}\.\d+/;

/** Lost-and-found category vocabulary. Anything else is refused. */
export const ITEM_CATEGORIES = [
  "documents",
  "electronics",
  "keys",
  "wallet",
  "bags",
  "clothing",
  "accessories",
  "jewelry",
  "pets",
  "eyewear",
  "sports",
  "books",
  "toys",
  "tools",
  "cosmetics",
  "other",
] as const;
export type ItemCategory = (typeof ITEM_CATEGORIES)[number];

export function isItemCategory(value: unknown): value is ItemCategory {
  return typeof value === "string" && (ITEM_CATEGORIES as readonly string[]).includes(value);
}

export const CLASSIFY_CATEGORY_INSTRUCTION =
  "Classify the item text. Return ONLY one JSON object like " +
  '{"category":"electronics"} with category one of ' +
  ITEM_CATEGORIES.join(", ") +
  '. An optional "confidence" number 0-1 may be included. ' +
  "No markdown, no commentary.";

export const CATEGORY_TEXT_MAX_CHARS = 280;

export interface ClassifyCategoryInput {
  readonly text: string;
}

export interface ClassifiedCategory {
  readonly category: ItemCategory;
  readonly confidence?: number;
}

export type ClassifyCategoryOptions = NormalizeOptions & {
  readonly signal?: AbortSignal;
};

export function buildClassifyCategoryPrompt(input: ClassifyCategoryInput): string {
  return `${CLASSIFY_CATEGORY_INSTRUCTION}\nItem text: ${input.text}`;
}

/**
 * R1-strict validator for category payloads: known keys only, category
 * allowlist, finite 0-1 confidence. No coordinates policy applies to the
 * input (checked by the op, not the model output).
 */
export function validateCategoryPayload(
  value: unknown,
  _context?: NormalizeContext,
): AiResult<ClassifiedCategory> {
  void _context;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: makeAiError("INVALID_OUTPUT", "R1_BAD_CATEGORY_OBJECT") };
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!["category", "confidence"].includes(key)) {
      return { ok: false, error: makeAiError("INVALID_OUTPUT", `R1_UNKNOWN_FIELD:category:${key}`) };
    }
  }
  if (!isItemCategory(record["category"])) {
    return { ok: false, error: makeAiError("INVALID_OUTPUT", `R1_UNKNOWN_CATEGORY:${String(record["category"])}`) };
  }
  if (record["confidence"] !== undefined) {
    const candidate = record["confidence"];
    if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < 0 || candidate > 1) {
      return { ok: false, error: makeAiError("INVALID_OUTPUT", "R1_BAD_CONFIDENCE") };
    }
    return { ok: true, value: { category: record["category"], confidence: candidate } };
  }
  return { ok: true, value: { category: record["category"] } };
}

function raceWithSignal(task: Promise<string>, signal: AbortSignal | undefined): Promise<string> {
  if (signal === undefined) return task;
  return new Promise<string>((resolve, reject) => {
    const onAbort = (): void => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    task.then(
      (text) => {
        signal.removeEventListener("abort", onAbort);
        resolve(text);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export async function classifyCategory(
  generate: GenerateFn,
  input: ClassifyCategoryInput,
  profile: ModelProfile,
  options?: ClassifyCategoryOptions,
): Promise<AiResult<ClassifiedCategory>> {
  const signal = options?.signal;
  if (signal !== undefined && signal.aborted) {
    return { ok: false, error: makeAiError("CANCELLED", "ABORT_BEFORE_START") };
  }
  if (typeof input.text !== "string" || input.text.trim() === "") {
    return { ok: false, error: makeAiError("INVALID_OUTPUT", "R1_BAD_INPUT:text") };
  }
  if (input.text.trim().length > CATEGORY_TEXT_MAX_CHARS) {
    return { ok: false, error: makeAiError("INVALID_OUTPUT", "R5_INPUT_TOO_LONG:text") };
  }
  if (COORD_PATTERN.test(input.text)) {
    return { ok: false, error: makeAiError("INVALID_OUTPUT", "R5_COORDINATES_NOT_ACCEPTED:text") };
  }
  let rawText: string;
  try {
    rawText = await raceWithSignal(
      generate(buildClassifyCategoryPrompt(input), {
        maxOutputTokens: profile.maxOutputTokensText,
        temperature: profile.defaultTemperature,
      }),
      signal,
    );
  } catch {
    return { ok: false, error: makeAiError("CANCELLED", "ABORT_MID_GENERATION") };
  }
  if (signal !== undefined && signal.aborted) {
    return { ok: false, error: makeAiError("CANCELLED", "ABORT_MID_GENERATION") };
  }
  const context = {
    instruction: CLASSIFY_CATEGORY_INSTRUCTION,
    userContext: options?.context?.userContext ?? input.text,
  };
  return normalizeJsonOp(rawText, profile, (value, innerContext) => validateCategoryPayload(value, innerContext), {
    ...options,
    context,
  });
}

