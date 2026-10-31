/**
 * Task interpreters: the single authority that turns raw runtime output
 * into validated route values.
 *
 * Boundary (runtime returns raw, task interprets):
 * - the generic runtime layer executes the selected model and returns its
 *   RAW output plus actual provenance. It never JSON.parses text, never
 *   unwraps envelopes, never guesses a task shape.
 * - the task interpreter for the routed task id then interprets that raw
 *   output: it selects the generation mode the runtime must use
 *   (`structured` = tool-constrained JSON envelope, `typed` = already-typed
 *   adapter value such as vectors), parses exactly once, runs the task's
 *   strict contract, and only then produces the route value.
 *
 * Exhaustive: EVERY model-routable task id has an interpreter. There is no
 * permissive fallthrough — an unlisted task id fails closed, never ok:true.
 * `interpret` runs inside adapters on fresh model output; `revalidate`
 * re-checks an already-interpreted value at the orchestrator layer, so a
 * future adapter cannot bypass interpretation and still succeed.
 */
import {
  validateIntentPayload,
  validateReportSlots,
  validateSearchFilters,
  validateSlotEnvelope,
} from "../normalize";
import { validateCategoryPayload } from "../ops/classifyCategory";
import { validateRouteIntent, type RouteIntentInput } from "../ops/routeIntent";
import { isIntent, type AiResult, type AiTaskId } from "../types";

/** How the runtime must generate for this task before interpretation. */
export type TaskGenerationMode = "structured" | "typed";

export interface TaskInterpretContext {
  readonly taskId: string;
  readonly input: unknown;
}

export type TaskInterpretation =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string };

export interface TaskInterpreter {
  readonly taskId: AiTaskId;
  readonly generation: TaskGenerationMode;
  interpret(raw: unknown, ctx: TaskInterpretContext): TaskInterpretation;
  revalidate(value: unknown, ctx: TaskInterpretContext): boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeError(error: AiResult<unknown>): string {
  if (error.ok) return "valid";
  const detail = error.error;
  return `${detail.errorClass}:${detail.diagnostic}${detail.reason ? `:${detail.reason}` : ""}`;
}

function failResult(taskId: string, error: AiResult<unknown>): TaskInterpretation {
  return { ok: false, error: `Task "${taskId}" output failed its contract: ${describeError(error)}`.slice(0, 400) };
}

/** Parse one model text output; every structured interpreter funnels here. */
function parseModelJson(taskId: string, raw: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  if (typeof raw !== "string") {
    return { ok: false, error: `Task "${taskId}" needs model text; got ${Array.isArray(raw) ? "array" : typeof raw}.` };
  }
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false, error: `Task "${taskId}" output was not JSON.` };
  }
}

function slotInterpreter(
  taskId: AiTaskId,
  validate: (candidate: unknown) => AiResult<unknown>,
): TaskInterpreter {
  return {
    taskId,
    generation: "structured",
    interpret: (raw, ctx) => {
      const parsed = parseModelJson(ctx.taskId, raw);
      if (!parsed.ok) return parsed;
      const checked = validateSlotEnvelope(parsed.value, validate);
      if (!checked.ok) return failResult(ctx.taskId, checked);
      // Local producers emit the canonical `{ fields }` envelope; keep it
      // so downstream op parsers see the exact shape they already accept.
      return { ok: true, value: { fields: checked.value } };
    },
    revalidate: (value, _ctx) => {
      if (!isRecord(value)) return false;
      return validateSlotEnvelope(value, validate).ok;
    },  };
}

function asRouteIntentInput(input: unknown): RouteIntentInput | undefined {
  if (!isRecord(input)) return undefined;
  const intent = input["intent"];
  if (!isIntent(intent)) return undefined;
  const hint = input["hint"];
  const hasLocation = input["hasLocation"];
  return {
    intent,
    ...(hint === undefined ? {} : { hint: typeof hint === "string" ? hint : "" }),
    ...(hasLocation === undefined ? {} : { hasLocation: hasLocation === true }),
  };
}

function interpretEmbedVectors(taskId: string, raw: unknown): TaskInterpretation {
  if (!isRecord(raw) || !Array.isArray(raw["vectors"]) || raw["vectors"].length === 0) {
    return { ok: false, error: `Task "${taskId}" needs a non-empty vectors array.` };
  }
  for (const row of raw["vectors"]) {
    if (!Array.isArray(row) || row.length === 0 || row.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))) {
      return { ok: false, error: `Task "${taskId}" vectors failed shape validation.` };
    }
  }
  return { ok: true, value: { vectors: raw["vectors"] } };
}

const INTERPRETERS: readonly TaskInterpreter[] = [
  slotInterpreter("extract-search-filters", (candidate) => validateSearchFilters(candidate)),
  slotInterpreter("extract-report-fields", (candidate) => validateReportSlots(candidate)),
  slotInterpreter("classify-category", (candidate) => validateCategoryPayload(candidate)),
  {
    taskId: "classify-intent",
    generation: "structured",
    interpret: (raw, ctx) => {
      const parsed = parseModelJson(ctx.taskId, raw);
      if (!parsed.ok) return parsed;
      const checked = validateIntentPayload(parsed.value);
      if (!checked.ok) return failResult(ctx.taskId, checked);
      return { ok: true, value: checked.value };
    },
    revalidate: (value) => validateIntentPayload(value).ok,
  },
  {
    taskId: "route-intent",
    generation: "structured",
    interpret: (raw, ctx) => {
      const parsed = parseModelJson(ctx.taskId, raw);
      if (!parsed.ok) return parsed;
      // Business rules need caller input (OPEN_MAP requires hasLocation);
      // without it the rules fail closed, never permissively.
      const checked = validateRouteIntent(parsed.value, undefined, asRouteIntentInput(ctx.input));
      if (!checked.ok) return failResult(ctx.taskId, checked);
      return { ok: true, value: checked.value };
    },
    revalidate: (value, ctx) => validateRouteIntent(value, undefined, asRouteIntentInput(ctx.input)).ok,
  },
  {
    taskId: "embed-texts",
    generation: "typed",
    interpret: (raw, ctx) => interpretEmbedVectors(ctx.taskId, raw),
    revalidate: (value, ctx) => interpretEmbedVectors(ctx.taskId, value).ok,
  },
];

const BY_TASK_ID: ReadonlyMap<string, TaskInterpreter> = new Map(
  INTERPRETERS.map((interpreter) => [interpreter.taskId, interpreter]),
);

/** The interpreter for one task id, or undefined when the task has none. */
export function interpreterFor(taskId: string): TaskInterpreter | undefined {
  return BY_TASK_ID.get(taskId);
}

/** Every interpreter task id (gate asserts this covers all routable tasks). */
export function listInterpreterTaskIds(): readonly string[] {
  return INTERPRETERS.map((interpreter) => interpreter.taskId);
}
