/**
 * Reviewable category suggestion (Lane C).
 *
 * Consumer of the `classify-category` op. The op classifies short item text
 * into its own lowercase vocabulary (documents, electronics, keys, …); this
 * module resolves that vocabulary, and any already-canonical label a caller
 * hands it, into a released form category. A suggestion is never applied: the
 * user always confirms or overrides.
 *
 * Frozen-report contract:
 * - Unreleased/unknown-category downgrade: anything that does not resolve to
 *   a released category is DROPPED (null + notice), never applied. Other
 *   field suggestions stay reviewable.
 * - Cancellation is abort-clean: a pre-aborted signal never calls generate;
 *   a mid-flight abort returns CANCELLED and never triggers fallback side
 *   effects (no retry, no second op, no apply).
 */
import { isReleasedCategory, type Category } from "@findback/shared";
import type { ModelProfile } from "./ai/modelProfiles";
import {
  classifyCategory,
  type ClassifiedCategory,
  type ItemCategory,
} from "./ai/ops/classifyCategory";
import type { AiResult, GenerateFn } from "./ai/types";

export const CATEGORY_SUGGESTION_SOURCES = ["classify-category", "photo"] as const;
export type CategorySuggestionSource = (typeof CATEGORY_SUGGESTION_SOURCES)[number];

export interface CategorySuggestion {
  readonly suggestedCategory: Category;
  readonly source: CategorySuggestionSource;
  readonly confidence?: number;
}

/**
 * Lowercase classify-category vocabulary resolved to released form labels.
 * Every target is a released catalog canonical today; the isReleasedCategory
 * guard in resolveCategorySuggestion still runs so a future catalog cutover
 * can never leak an unreleased value into the form.
 */
export const ITEM_CATEGORY_TO_RELEASED: Record<ItemCategory, Category> = {
  documents: "Documents & IDs",
  electronics: "Electronics",
  keys: "Keys",
  wallet: "Bags & Wallets",
  bags: "Bags & Wallets",
  clothing: "Clothing",
  accessories: "Accessories & Jewelry",
  jewelry: "Accessories & Jewelry",
  pets: "Pet Accessories",
  eyewear: "Watches & Eyewear",
  sports: "Sports & Fitness",
  books: "Books & Stationery",
  toys: "Toys & Games",
  tools: "Tools & Equipment",
  cosmetics: "Personal Care",
  other: "Other",
};

export interface ResolvedCategorySuggestion {
  /** Null when there was nothing to suggest or the value was downgraded. */
  readonly suggestion: CategorySuggestion | null;
  /** True when a model value existed but was dropped as unreleased/unknown. */
  readonly dropped: boolean;
}

/**
 * Pure resolver shared by the text path (classify-category) and the photo
 * path (a validated photo-analysis category string, e.g. from the vision
 * runtime's `buildCategorySuggestionFromPhoto` caller). Released canonicals
 * pass straight through; lowercase op vocabulary maps via
 * ITEM_CATEGORY_TO_RELEASED; anything else (null, empty, unknown) downgrades to
 * null. A resolved value is always released — an unreleased mapping target
 * would downgrade too.
 */
export function resolveCategorySuggestion(
  raw: string | null | undefined,
  source: CategorySuggestionSource,
  confidence?: number,
): ResolvedCategorySuggestion {
  const trimmed = raw?.trim();
  if (!trimmed) return { suggestion: null, dropped: false };
  if (isReleasedCategory(trimmed)) {
    const suggestion: CategorySuggestion =
      confidence === undefined
        ? { suggestedCategory: trimmed as Category, source }
        : { suggestedCategory: trimmed as Category, source, confidence };
    return { suggestion, dropped: false };
  }
  const mapped = ITEM_CATEGORY_TO_RELEASED[trimmed as ItemCategory];
  if (mapped !== undefined && isReleasedCategory(mapped)) {
    const suggestion: CategorySuggestion =
      confidence === undefined
        ? { suggestedCategory: mapped, source }
        : { suggestedCategory: mapped, source, confidence };
    return { suggestion, dropped: false };
  }
  return { suggestion: null, dropped: true };
}

/** Builds the reviewable suggestion from a validated classify-category value. */
export function buildCategorySuggestionFromClassification(
  classified: ClassifiedCategory,
): ResolvedCategorySuggestion {
  return resolveCategorySuggestion(classified.category, "classify-category", classified.confidence);
}

/** Builds the reviewable suggestion from a photo-analysis category string. */
export function buildCategorySuggestionFromPhoto(
  photoCategory: string | null | undefined,
): ResolvedCategorySuggestion {
  return resolveCategorySuggestion(photoCategory, "photo");
}

export interface SuggestCategoryOptions {
  readonly signal?: AbortSignal;
}

export interface SuggestCategoryResult {
  /** Null + dropped=true when the model value was downgraded (still ok). */
  readonly suggestion: CategorySuggestion | null;
  readonly dropped: boolean;
}

/**
 * Runs `classify-category` with an injected generate transport (tests pass
 * fakes) and resolves the outcome to a reviewable suggestion. Abort-clean:
 * a pre-aborted signal never calls generate (the op itself enforces this);
 * a mid-flight abort returns CANCELLED without fallback side effects. Op
 * validation failures pass through unchanged (fail closed). An unreleased or
 * unknown category is a SUCCESSFUL downgrade (suggestion null + dropped),
 * never an error — sibling field suggestions stay reviewable. The result is
 * a SUGGESTION ONLY: the caller renders Apply/Keep and the user confirms or
 * overrides.
 */
export async function suggestCategoryForText(
  generate: GenerateFn,
  text: string,
  profile: ModelProfile,
  options?: SuggestCategoryOptions,
): Promise<AiResult<SuggestCategoryResult>> {
  const result = await classifyCategory(generate, { text }, profile, options);
  if (!result.ok) {
    // CANCELLED and validation failures pass through untouched: no retry, no
    // fallback op, no silent default category.
    if (result.error.errorClass === "CANCELLED") return result;
    return result;
  }
  const resolved = buildCategorySuggestionFromClassification(result.value);
  return {
    ok: true,
    value: { suggestion: resolved.suggestion, dropped: resolved.dropped },
  };
}
