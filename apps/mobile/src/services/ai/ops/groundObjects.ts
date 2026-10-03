/**
 * Narrow op: ground-objects.
 *
 * Vision grounding: given a photo plus a referring expression, the model
 * emits ONE JSON object with boxes in relative-0-1000 space. Boxes are data
 * only — this op draws nothing, crops nothing, and writes nothing.
 *
 * Consent: the output describes user-photo content, so the op takes an
 * explicit `imageConsent` flag and refuses (UNSUPPORTED_REQUEST,
 * CONSENT_REQUIRED:image) without it. The caller owns the photo-library
 * permission; this flag records that the user agreed to AI grounding.
 */
import type { ModelProfile } from "../modelProfiles";
import {
  containsEcho,
  normalizeJsonOp,
  type NormalizeContext,
  type NormalizeOptions,
} from "../normalize";
import { taskSpecFor, type AiTaskSpec } from "../taskSpecs";
import { makeAiError, type AiResult, type GenerateFn } from "../types";

export const GROUND_COORDINATE_SPACES = ["relative-0-1000"] as const;
export type GroundCoordinateSpace = (typeof GROUND_COORDINATE_SPACES)[number];

export function isGroundCoordinateSpace(value: unknown): value is GroundCoordinateSpace {
  return (
    typeof value === "string" && (GROUND_COORDINATE_SPACES as readonly string[]).includes(value)
  );
}

export const GROUND_INSTRUCTION =
  "Ground the referring expression in the photo. Return ONLY one JSON object " +
  'like {"coordinateSpace":"relative-0-1000","boxes":[{"x":10,"y":20,"w":300,' +
  '"h":200,"label":"red backpack"}]}. Coordinates are integers 0-1000 ' +
  "relative to image width/height; every box must fit inside the image. " +
  'An empty "boxes" array means nothing matched. No markdown, no commentary.';

export const GROUND_MAX_BOXES = 8;
export const GROUND_MAX_LABEL_CHARS = 40;
export const GROUND_EXPRESSION_MAX_CHARS = 140;

export interface GroundBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly label: string;
}

export interface GroundedObjects {
  readonly coordinateSpace: GroundCoordinateSpace;
  readonly boxes: readonly GroundBox[];
}

export interface GroundObjectsInput {
  readonly imageUri: string;
  readonly referringExpression: string;
}

export type GroundObjectsOptions = NormalizeOptions & {
  readonly signal?: AbortSignal;
  /** Must be true: grounding describes user-photo content. */
  readonly imageConsent?: boolean;
};

export function buildGroundObjectsPrompt(input: GroundObjectsInput): string {
  return `${GROUND_INSTRUCTION}\nReferring expression: ${input.referringExpression}`;
}

function isBoxCoordinate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * R1-strict validator for grounding payloads: known keys, coordinate-space
 * enum, box shapes, label/length bounds. Business rules: every box must fit
 * inside the 0-1000 image (no negative, no overflow, no zero area).
 */
export function validateGroundObjects(
  value: unknown,
  context?: NormalizeContext,
): AiResult<GroundedObjects> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: makeAiError("INVALID_OUTPUT", "R1_BAD_GROUND_OBJECT") };
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!["coordinateSpace", "boxes"].includes(key)) {
      return { ok: false, error: makeAiError("INVALID_OUTPUT", `R1_UNKNOWN_FIELD:ground:${key}`) };
    }
  }
  if (!isGroundCoordinateSpace(record["coordinateSpace"])) {
    return {
      ok: false,
      error: makeAiError("INVALID_OUTPUT", `R1_UNKNOWN_COORDINATE_SPACE:${String(record["coordinateSpace"])}`),
    };
  }
  if (!Array.isArray(record["boxes"])) {
    return { ok: false, error: makeAiError("INVALID_OUTPUT", "R1_BAD_FIELD:boxes") };
  }
  if (record["boxes"].length > GROUND_MAX_BOXES) {
    return { ok: false, error: makeAiError("INVALID_OUTPUT", "R5_TOO_MANY_BOXES") };
  }
  const boxes: GroundBox[] = [];
  for (const item of record["boxes"]) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return { ok: false, error: makeAiError("INVALID_OUTPUT", "R1_BAD_FIELD:box") };
    }
    const box = item as Record<string, unknown>;
    for (const key of Object.keys(box)) {
      if (!["x", "y", "w", "h", "label"].includes(key)) {
        return { ok: false, error: makeAiError("INVALID_OUTPUT", `R1_UNKNOWN_FIELD:box:${key}`) };
      }
    }
    const { x, y, w, h, label } = box;
    if (!isBoxCoordinate(x) || !isBoxCoordinate(y) || !isBoxCoordinate(w) || !isBoxCoordinate(h)) {
      return { ok: false, error: makeAiError("INVALID_OUTPUT", "R1_BAD_FIELD:box-coords") };
    }
    if (typeof label !== "string") {
      return { ok: false, error: makeAiError("INVALID_OUTPUT", "R1_BAD_FIELD:label") };
    }
    const trimmed = label.trim();
    if (trimmed === "") {
      return { ok: false, error: makeAiError("INVALID_OUTPUT", "R1_BAD_FIELD:label") };
    }
    if (trimmed.length > GROUND_MAX_LABEL_CHARS) {
      return { ok: false, error: makeAiError("INVALID_OUTPUT", "R5_FIELD_TOO_LONG:label") };
    }
    if (containsEcho(trimmed, context)) {
      return { ok: false, error: makeAiError("INVALID_OUTPUT", "R6_CONTEXT_ECHO:label") };
    }
    if (
      !Number.isInteger(x) ||
      !Number.isInteger(y) ||
      !Number.isInteger(w) ||
      !Number.isInteger(h) ||
      x < 0 ||
      y < 0 ||
      w <= 0 ||
      h <= 0 ||
      x > 1000 ||
      y > 1000 ||
      x + w > 1000 ||
      y + h > 1000
    ) {
      return { ok: false, error: makeAiError("INVALID_OUTPUT", "R1_BUSINESS_RULE:BOX_OUT_OF_BOUNDS") };
    }
    boxes.push({ x, y, w, h, label: trimmed });
  }
  return { ok: true, value: { coordinateSpace: record["coordinateSpace"], boxes } };
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

export async function groundObjects(
  generate: GenerateFn,
  input: GroundObjectsInput,
  profile: ModelProfile,
  options?: GroundObjectsOptions,
): Promise<AiResult<GroundedObjects>> {
  const signal = options?.signal;
  if (signal !== undefined && signal.aborted) {
    return { ok: false, error: makeAiError("CANCELLED", "ABORT_BEFORE_START") };
  }
  if (options?.imageConsent !== true) {
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
  if (input.referringExpression.trim().length > GROUND_EXPRESSION_MAX_CHARS) {
    return { ok: false, error: makeAiError("INVALID_OUTPUT", "R5_INPUT_TOO_LONG:referringExpression") };
  }
  void input.imageUri;
  let rawText: string;
  try {
    rawText = await raceWithSignal(
      generate(buildGroundObjectsPrompt(input), {
        maxOutputTokens: profile.maxOutputTokensVision ?? profile.maxOutputTokensText,
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
    instruction: GROUND_INSTRUCTION,
    userContext: options?.context?.userContext ?? input.referringExpression,
  };
  return normalizeJsonOp(rawText, profile, (value, innerContext) => validateGroundObjects(value, innerContext), {
    ...options,
    context,
  });
}

export const groundObjectsTaskSpec: AiTaskSpec = taskSpecFor("ground-objects");
