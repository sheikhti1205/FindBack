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
 *   (`structured` = tool-constrained JSON envelope, `raw` = free model
 *   text, `typed` = already-typed adapter value such as vectors), parses
 *   exactly once, runs the task's strict contract, and only then produces
 *   the route value.
 *
 * Exhaustive: EVERY model-routable task id has an interpreter. There is no
 * permissive fallthrough — an unlisted task id fails closed, never ok:true.
 * `interpret` runs inside adapters on fresh model output; `revalidate`
 * re-checks an already-interpreted value at the orchestrator layer, so a
 * future adapter cannot bypass interpretation and still succeed.
 */
import { groundAppAnswer } from "../appKnowledge";
import {
  checkNonEmptyOrRefusal,
  MAX_HELP_CHARS,
  validateIntentPayload,
  validateReportSlots,
  validateSearchFilters,
  validateSlotEnvelope,
} from "../normalize";
import { validateCategoryPayload } from "../ops/classifyCategory";
import { validateRouteIntent, type RouteIntentInput } from "../ops/routeIntent";
import { SUMMARY_MAX_CHARS } from "../ops/summarizeLocalContext";
import { isIntent, type AiResult, type AiTaskId } from "../types";

/** How the runtime must generate for this task before interpretation. */
export type TaskGenerationMode = "structured" | "raw" | "typed";

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

const COORD_PATTERN = /-?\d{1,3}\.\d+\s*,\s*-?\d{1,3}\.\d+/;
const VISION_TEXT_MAX_CHARS = 4_000;

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

/**
 * Route contract for vision tasks: bounded prose text. The strict 9-field
 * photo schema stays in the analyze-image op (with its retry budget) and
 * box geometry plus image consent stay in the ground-objects op — the
 * route never invents photo facts, boxes, or consent.
 */
function interpretVisionText(taskId: string, raw: unknown): TaskInterpretation {
  if (!isRecord(raw) || typeof raw["text"] !== "string") {
    return { ok: false, error: `Task "${taskId}" needs a text field.` };
  }
  const bounded = proseBounds(taskId, raw["text"], VISION_TEXT_MAX_CHARS);
  if (bounded !== undefined) return bounded;
  return { ok: true, value: { text: raw["text"].trim() } };
}

function proseBounds(taskId: string, text: string, maxChars: number): TaskInterpretation | undefined {
  const checked = checkNonEmptyOrRefusal(text);
  if (!checked.ok) {
    return { ok: false, error: `Task "${taskId}" output failed its contract: ${describeError(checked)}`.slice(0, 400) };
  }
  const answer = checked.value.trim();
  if (answer.length > maxChars) {
    return { ok: false, error: `Task "${taskId}" output exceeds ${maxChars} chars.` };
  }
  return undefined;
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
    taskId: "answer-help",
    generation: "raw",
    interpret: (raw, ctx) => {
      if (typeof raw !== "string") {
        return { ok: false, error: `Task "${ctx.taskId}" needs model text; got ${typeof raw}.` };
      }
      const bounded = proseBounds(ctx.taskId, raw, MAX_HELP_CHARS);
      if (bounded !== undefined) return bounded;
      const answer = raw.trim();
      // Screen before success: SQL, private data, and model-identity claims
      // resolve to the honest grounded reply (same contract as the help op).
      const grounded = groundAppAnswer(answer);
      return { ok: true, value: { answerText: grounded.safe ? grounded.text : grounded.reply } };
    },
    revalidate: (value, ctx) => {
      if (!isRecord(value) || typeof value["answerText"] !== "string") return false;
      // Shape + bounds here; the grounding screen ran at interpret time and
      // is deterministic on the same text, so re-running adds no signal.
      return proseBounds(ctx.taskId, value["answerText"], MAX_HELP_CHARS) === undefined;
    },
  },
  {
    taskId: "summarize-local-context",
    generation: "raw",
    interpret: (raw, ctx) => {
      if (typeof raw !== "string") {
        return { ok: false, error: `Task "${ctx.taskId}" needs model text; got ${typeof raw}.` };
      }
      const bounded = proseBounds(ctx.taskId, raw, SUMMARY_MAX_CHARS);
      if (bounded !== undefined) return bounded;
      const summary = raw.trim();
      // Local summaries must never leak coordinates, even when the model
      // echoes them from the notes.
      if (COORD_PATTERN.test(summary)) {
        return { ok: false, error: `Task "${ctx.taskId}" output failed its contract: INVALID_OUTPUT:R5_COORDINATES_NOT_ACCEPTED:summary` };
      }
      return { ok: true, value: { summary } };
    },
    revalidate: (value, ctx) => {
      if (!isRecord(value) || typeof value["summary"] !== "string") return false;
      if (proseBounds(ctx.taskId, value["summary"], SUMMARY_MAX_CHARS) !== undefined) return false;
      return !COORD_PATTERN.test(value["summary"].trim());
    },
  },
  {
    taskId: "embed-texts",
    generation: "typed",
    interpret: (raw, ctx) => interpretEmbedVectors(ctx.taskId, raw),
    revalidate: (value, ctx) => interpretEmbedVectors(ctx.taskId, value).ok,
  },
  {
    taskId: "analyze-image",
    generation: "typed",
    interpret: (raw, ctx) => interpretVisionText(ctx.taskId, raw),
    revalidate: (value, ctx) => interpretVisionText(ctx.taskId, value).ok,
  },
  {
    taskId: "ground-objects",
    generation: "typed",
    interpret: (raw, ctx) => interpretVisionText(ctx.taskId, raw),
    revalidate: (value, ctx) => interpretVisionText(ctx.taskId, value).ok,
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
