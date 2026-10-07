/**
 * Task output contracts own route SUCCESS (orchestrator layer).
 *
 * This module is the orchestrator-side enforcement point: after a model
 * adapter returns, the value is re-checked against the task's interpreter
 * contract. Interpretation itself lives in `taskInterpreters.ts` (the
 * single authority); this file keeps the `LOCAL_TASK_INVALID` denial
 * reason and the `validateRouteValue` entry so existing import sites and
 * the release gate keep working.
 *
 * Total: every task id either has an interpreter or fails here. Unknown
 * task ids and uninterpretable values are LOCAL_TASK_INVALID — eligible
 * for allowed cloud fallback in Automatic mode, surfaced in
 * on-device-only, never a silent downstream drop.
 */
import { interpreterFor } from "./taskInterpreters";

export const LOCAL_TASK_INVALID = "LOCAL_TASK_INVALID" as const;

export type RouteValidation = { readonly ok: true } | { readonly ok: false; readonly error: string };

/**
 * Re-validate one runtime-produced value against the task contract.
 * `input` is the original route input (some contracts need caller
 * context, e.g. route-intent business rules); without a matching
 * interpreter the value fails closed.
 */
export function validateRouteValue(taskId: string, value: unknown, input?: unknown): RouteValidation {
  const interpreter = interpreterFor(taskId);
  if (interpreter === undefined) {
    return { ok: false, error: `Task "${taskId}" has no output contract.` };
  }
  if (!interpreter.revalidate(value, { taskId, input })) {
    return { ok: false, error: `Task "${taskId}" output failed its contract.` };
  }
  return { ok: true };
}
