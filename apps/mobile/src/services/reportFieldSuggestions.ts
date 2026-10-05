/**
 * Reviewable report-field suggestions (Lane C).
 *
 * Consumer of the `extract-report-fields` op. The op extracts a small slot
 * object (title, description, category, dateText, locationNote); this module
 * maps the form-applicable slots (title / description / date / category) into
 * per-field reviewable patches. Each patch carries its source so the UI can
 * label it, and every patch needs an explicit user Apply — nothing here
 * writes to the draft, publishes, or auto-applies.
 *
 * Frozen-report contract:
 * - Unreleased-category downgrade: a suggested category outside the released
 *   catalog is DROPPED (with a notice), never applied. Title/description/date
 *   patches stay reviewable.
 * - Cancellation is abort-clean: a pre-aborted signal never calls generate;
 *   a mid-flight abort returns CANCELLED and never triggers fallback side
 *   effects (no retry, no second op, no apply). A late op resolution is
 *   dropped, never rendered.
 * - Stale-drop is the caller's job (generation token, like VlmSuggestions):
 *   a result that resolves after a newer request started must be discarded
 *   by the UI, never rendered into another request's panel.
 */
import { isReleasedCategory, type Category } from "@findback/shared";
import type { ModelProfile } from "./ai/modelProfiles";
import { extractReportFields } from "./ai/ops/extractReportFields";
import type {
  AiResult,
  AssistantAction,
  GenerateFn,
  ReportSlotFields,
} from "./ai/types";
import { makeAiError } from "./ai/types";

export const REPORT_FIELD_SOURCE = "extract-report-fields" as const;
export type ReportFieldSource = typeof REPORT_FIELD_SOURCE;

export const DROPPED_CATEGORY_NOTE =
  "The suggested category isn't available yet, so it was left out. Pick a category manually.";

export type ReportSuggestionField = "title" | "description" | "category" | "date";

export interface ReportFieldSuggestion {
  readonly field: ReportSuggestionField;
  /** Exact suggested value; the UI may let the user edit before Apply. */
  readonly suggestedValue: string;
  readonly source: ReportFieldSource;
}

export interface BuiltReportFieldSuggestions {
  readonly suggestions: readonly ReportFieldSuggestion[];
  /** True when the model suggested a category that was dropped as unreleased. */
  readonly droppedCategory: boolean;
}

/**
 * Pure map from validated extraction slots to reviewable per-field patches.
 * Only non-empty trimmed values become suggestions. A category outside the
 * released catalog is dropped (droppedCategory=true) instead of surfacing as
 * an applicable patch — applying one field keeps the others reviewable, and
 * a dropped category never blocks title/description/date review.
 */
export function buildReportFieldSuggestions(
  fields: ReportSlotFields,
): BuiltReportFieldSuggestions {
  const suggestions: ReportFieldSuggestion[] = [];
  const title = fields.title?.trim();
  if (title) {
    suggestions.push({ field: "title", suggestedValue: title, source: REPORT_FIELD_SOURCE });
  }
  const description = fields.description?.trim();
  if (description) {
    suggestions.push({ field: "description", suggestedValue: description, source: REPORT_FIELD_SOURCE });
  }
  const dateText = fields.dateText?.trim();
  if (dateText) {
    suggestions.push({ field: "date", suggestedValue: dateText, source: REPORT_FIELD_SOURCE });
  }
  const category = fields.category?.trim();
  let droppedCategory = false;
  if (category) {
    if (isReleasedCategory(category)) {
      suggestions.push({ field: "category", suggestedValue: category, source: REPORT_FIELD_SOURCE });
    } else {
      droppedCategory = true;
    }
  }
  return { suggestions, droppedCategory };
}

export interface SuggestReportFieldsResult extends BuiltReportFieldSuggestions {
  readonly action: AssistantAction;
}

export interface SuggestReportFieldsOptions {
  readonly signal?: AbortSignal;
}

/**
 * Runs `extract-report-fields` with an injected generate transport (tests pass
 * fakes; production wires its own transport) and maps the outcome to
 * reviewable patches. Abort-clean: a pre-aborted signal never calls generate;
 * a mid-flight abort returns CANCELLED without parsing, retrying, falling
 * back, or applying anything. Op validation failures pass through unchanged
 * (fail closed). The result is SUGGESTIONS ONLY — the caller renders
 * Apply/Keep per field and drops stale generations via its own generation
 * token.
 */
export async function suggestReportFields(
  generate: GenerateFn,
  userMessage: string,
  profile: ModelProfile,
  options?: SuggestReportFieldsOptions,
): Promise<AiResult<SuggestReportFieldsResult>> {
  const signal = options?.signal;
  if (signal !== undefined && signal.aborted) {
    return { ok: false, error: makeAiError("CANCELLED", "ABORT_BEFORE_START") };
  }
  const opTask = extractReportFields(generate, userMessage, profile);
  let opResult: Awaited<typeof opTask>;
  if (signal === undefined) {
    opResult = await opTask;
  } else {
    opResult = await new Promise<Awaited<typeof opTask>>((resolve, reject) => {
      const onAbort = (): void => reject(new Error("aborted"));
      signal.addEventListener("abort", onAbort, { once: true });
      opTask.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    }).catch((error: unknown): Awaited<typeof opTask> => {
      // Only an actual abort becomes CANCELLED. A transport failure from the
      // op itself must never be mislabeled as a cancellation.
      if (signal.aborted) {
        return {
          ok: false,
          error: makeAiError("CANCELLED", "ABORT_MID_GENERATION"),
        };
      }
      throw error;
    });
    if (signal.aborted) {
      return { ok: false, error: makeAiError("CANCELLED", "ABORT_MID_GENERATION") };
    }
  }
  if (!opResult.ok) return opResult;
  const built = buildReportFieldSuggestions(opResult.value.fields);
  return {
    ok: true,
    value: {
      suggestions: built.suggestions,
      droppedCategory: built.droppedCategory,
      action: opResult.value.action,
    },
  };
}

/** Type-level proof that a built category patch is always released. */
export function isReleasedCategoryPatch(
  suggestion: ReportFieldSuggestion,
): suggestion is ReportFieldSuggestion & { field: "category"; suggestedValue: Category } {
  return suggestion.field === "category" && isReleasedCategory(suggestion.suggestedValue);
}
