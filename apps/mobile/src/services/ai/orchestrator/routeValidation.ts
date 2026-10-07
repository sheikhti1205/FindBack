/**
 * Phase A (Step 5): task output contracts own route SUCCESS.
 *
 * The generic runtime layer produces raw records; a route is SUCCESS only
 * after the task's output contract validates. Local producers (Needle's
 * `record_item` tool, the deterministic rules) emit slot payloads inside a
 * `{ fields: {...} }` envelope, optionally alongside the code-owned
 * `deterministic: true` marker — while cloud returns the flat slot object.
 * Both spellings are canonical here: the envelope is unwrapped, then the
 * task's strict flat validator runs. Anything else is LOCAL_TASK_INVALID,
 * which Automatic mode may cloud-fallback; it must never surface as a
 * successful value that a downstream parser silently drops.
 *
 * Tasks without a strict JSON contract here (prose answers, vision text,
 * embeddings) stay permissive at this layer and validate downstream, as
 * today. Adding a strict contract for a new task means adding it to the map
 * below — never a consumer-side shape workaround.
 */
import { validateReportSlots, validateSearchFilters } from "../normalize";
import { validateCategoryPayload } from "../ops/classifyCategory";
import type { AiResult } from "../types";

export const LOCAL_TASK_INVALID = "LOCAL_TASK_INVALID" as const;

export type RouteValidation = { readonly ok: true } | { readonly ok: false; readonly error: string };

type SlotValidator = (value: unknown) => AiResult<unknown>;

const SLOT_VALIDATORS: Readonly<Record<string, SlotValidator>> = {
  "extract-search-filters": (value) => validateSearchFilters(value),
  "extract-report-fields": (value) => validateReportSlots(value),
  "classify-category": (value) => validateCategoryPayload(value),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate one runtime-produced value against the task contract. The
 * canonical `{ fields }` envelope (plus the code-owned `deterministic`
 * marker) is unwrapped before the strict flat validator runs.
 */
export function validateRouteValue(taskId: string, value: unknown): RouteValidation {
  const validate = SLOT_VALIDATORS[taskId];
  if (validate === undefined) return { ok: true };
  if (!isRecord(value)) {
    return { ok: false, error: `Task "${taskId}" needs a JSON object; got ${typeof value}.` };
  }
  const outer = { ...value };
  delete outer["deterministic"];
  let candidate: unknown = outer;
  if ("fields" in outer) {
    const rest = { ...outer };
    delete rest["fields"];
    if (Object.keys(rest).length > 0) {
      return { ok: false, error: `Task "${taskId}" mixes a fields envelope with flat slots.` };
    }
    candidate = outer["fields"];
  }
  const parsed = validate(candidate);
  if (!parsed.ok) {
    const detail = typeof parsed.error === "string" ? parsed.error : "output failed task validation";
    return { ok: false, error: `Task "${taskId}" output failed its contract: ${detail}`.slice(0, 400) };
  }
  return { ok: true };
}
