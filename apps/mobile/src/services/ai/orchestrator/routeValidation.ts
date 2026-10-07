/**
 * Phase A (Step 5): task output contracts own route SUCCESS.
 *
 * The generic runtime layer produces raw records; a route is SUCCESS only
 * after the task's output contract validates. Envelope handling lives in
 * `validateSlotEnvelope` (normalize.ts) — the single canonical boundary.
 * A contract failure here is LOCAL_TASK_INVALID, which Automatic mode may
 * cloud-fallback; it must never surface as a successful value that a
 * downstream parser silently drops.
 *
 * Tasks without a strict JSON contract here (prose answers, vision text,
 * embeddings) stay permissive at this layer and validate downstream, as
 * today. Adding a strict contract for a new task means adding it to the map
 * below — never a consumer-side shape workaround.
 */
import { validateReportSlots, validateSearchFilters, validateSlotEnvelope } from "../normalize";
import { validateCategoryPayload } from "../ops/classifyCategory";
import type { AiResult } from "../types";

export const LOCAL_TASK_INVALID = "LOCAL_TASK_INVALID" as const;

export type RouteValidation = { readonly ok: true } | { readonly ok: false; readonly error: string };

type SlotValidator = (value: unknown) => AiResult<unknown>;

const SLOT_VALIDATORS: Readonly<Record<string, SlotValidator>> = {
  "extract-search-filters": (value) => validateSlotEnvelope(value, (candidate) => validateSearchFilters(candidate)),
  "extract-report-fields": (value) => validateSlotEnvelope(value, (candidate) => validateReportSlots(candidate)),
  "classify-category": (value) => validateSlotEnvelope(value, (candidate) => validateCategoryPayload(candidate)),
};

function describeError(error: AiResult<unknown>): string {
  if (error.ok) return "valid";
  const detail = error.error;
  return `${detail.errorClass}:${detail.diagnostic}${detail.reason ? `:${detail.reason}` : ""}`;
}

/**
 * Validate one runtime-produced value against the task contract.
 */
export function validateRouteValue(taskId: string, value: unknown): RouteValidation {
  const validate = SLOT_VALIDATORS[taskId];
  if (validate === undefined) return { ok: true };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: `Task "${taskId}" needs a JSON object; got ${Array.isArray(value) ? "array" : typeof value}.` };
  }
  const parsed = validate(value);
  if (!parsed.ok) {
    return { ok: false, error: `Task "${taskId}" output failed its contract: ${describeError(parsed)}`.slice(0, 400) };
  }
  return { ok: true };
}
