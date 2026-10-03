/**
 * Narrow op: route-intent.
 *
 * classify-intent answers "what does the user want"; this op answers "where
 * in the app does it go". The model emits ONE small JSON object carrying a
 * route enum. Code owns the preconditions: OPEN_MAP is refused unless the
 * caller confirms location availability, and ASK_USER is refused without a
 * stated reason. Pure: no navigation, no DB writes, no side effects.
 */
import type { ModelProfile } from "../modelProfiles";
import {
  containsEcho,
  normalizeJsonOp,
  type NormalizeContext,
  type NormalizeOptions,
} from "../normalize";
import { taskSpecFor, type AiTaskSpec } from "../taskSpecs";
import {
  isIntent,
  makeAiError,
  type AiResult,
  type GenerateFn,
  type Intent,
} from "../types";

/** In-app destinations the model may propose. Anything else is refused. */
export const ROUTE_DESTINATIONS = [
  "OPEN_REPORT_LOST",
  "OPEN_REPORT_FOUND",
  "OPEN_SEARCH",
  "OPEN_HELP",
  "OPEN_MAP",
  "ASK_USER",
] as const;
export type RouteDestination = (typeof ROUTE_DESTINATIONS)[number];

export function isRouteDestination(value: unknown): value is RouteDestination {
  return typeof value === "string" && (ROUTE_DESTINATIONS as readonly string[]).includes(value);
}

export const ROUTE_INTENT_INSTRUCTION =
  "Route the classified intent. Return ONLY one JSON object like " +
  '{"route":"OPEN_SEARCH"} with route one of OPEN_REPORT_LOST, ' +
  "OPEN_REPORT_FOUND, OPEN_SEARCH, OPEN_HELP, OPEN_MAP, ASK_USER. " +
  'An optional "confidence" number 0-1 and a short "reason" string may be ' +
  "included. No markdown, no commentary.";

export const ROUTE_HINT_MAX_CHARS = 280;
export const ROUTE_REASON_MAX_CHARS = 140;

export interface RouteIntentInput {
  readonly intent: Intent;
  readonly hint?: string;
  /** Caller-confirmed location availability; required for OPEN_MAP. */
  readonly hasLocation?: boolean;
}

export interface RoutedIntent {
  readonly route: RouteDestination;
  readonly confidence?: number;
  readonly reason?: string;
}

export type RouteIntentOptions = NormalizeOptions & {
  readonly signal?: AbortSignal;
};

export function buildRouteIntentPrompt(input: RouteIntentInput): string {
  const hint = input.hint === undefined || input.hint.trim() === "" ? "" : `\nHint: ${input.hint}`;
  return `${ROUTE_INTENT_INSTRUCTION}\nIntent: ${input.intent}${hint}`;
}

function fail<T>(error: AiResult<T>): AiResult<T> {
  return error;
}

/**
 * R1-strict validator for route-intent payloads: known keys only, route
 * allowlist, confidence in 0-1, short reason. Business rules need the
 * caller input: ASK_USER must state a reason, OPEN_MAP needs hasLocation.
 */
export function validateRouteIntent(
  value: unknown,
  context?: NormalizeContext,
  input?: RouteIntentInput,
): AiResult<RoutedIntent> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: makeAiError("INVALID_OUTPUT", "R1_BAD_ROUTE_OBJECT") };
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!["route", "confidence", "reason"].includes(key)) {
      return { ok: false, error: makeAiError("INVALID_OUTPUT", `R1_UNKNOWN_FIELD:route:${key}`) };
    }
  }
  if (!("route" in record)) {
    return { ok: false, error: makeAiError("INVALID_OUTPUT", "R1_MISSING_ROUTE") };
  }
  if (!isRouteDestination(record["route"])) {
    return { ok: false, error: makeAiError("INVALID_OUTPUT", `R1_UNKNOWN_ROUTE:${String(record["route"])}`) };
  }
  const route = record["route"];
  let confidence: number | undefined;
  if (record["confidence"] !== undefined) {
    const candidate = record["confidence"];
    if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < 0 || candidate > 1) {
      return { ok: false, error: makeAiError("INVALID_OUTPUT", "R1_BAD_CONFIDENCE") };
    }
    confidence = candidate;
  }
  let reason: string | undefined;
  if (record["reason"] !== undefined) {
    const candidate = record["reason"];
    if (typeof candidate !== "string") {
      return { ok: false, error: makeAiError("INVALID_OUTPUT", "R1_BAD_FIELD:reason") };
    }
    const trimmed = candidate.trim();
    if (trimmed.length > ROUTE_REASON_MAX_CHARS) {
      return { ok: false, error: makeAiError("INVALID_OUTPUT", "R5_FIELD_TOO_LONG:reason") };
    }
    if (trimmed !== "") {
      if (containsEcho(trimmed, context)) {
        return { ok: false, error: makeAiError("INVALID_OUTPUT", "R6_CONTEXT_ECHO:reason") };
      }
      reason = trimmed;
    }
  }
  if (route === "ASK_USER" && reason === undefined) {
    return { ok: false, error: makeAiError("INVALID_OUTPUT", "R1_BUSINESS_RULE:ASK_USER_REQUIRES_REASON") };
  }
  if (route === "OPEN_MAP" && input?.hasLocation !== true) {
    return { ok: false, error: makeAiError("INVALID_OUTPUT", "R1_BUSINESS_RULE:OPEN_MAP_REQUIRES_LOCATION") };
  }
  return confidence === undefined && reason === undefined
    ? { ok: true, value: { route } }
    : { ok: true, value: { route, ...(confidence === undefined ? {} : { confidence }), ...(reason === undefined ? {} : { reason }) } };
}

// No import cycle: normalize.ts never imports from ops/.
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

export async function routeIntent(
  generate: GenerateFn,
  input: RouteIntentInput,
  profile: ModelProfile,
  options?: RouteIntentOptions,
): Promise<AiResult<RoutedIntent>> {
  const signal = options?.signal;
  if (signal !== undefined && signal.aborted) {
    return fail({ ok: false, error: makeAiError("CANCELLED", "ABORT_BEFORE_START") });
  }
  if (!isIntent(input.intent)) {
    return { ok: false, error: makeAiError("INVALID_OUTPUT", "R1_UNKNOWN_INTENT") };
  }
  if (input.hint !== undefined && input.hint.trim().length > ROUTE_HINT_MAX_CHARS) {
    return { ok: false, error: makeAiError("INVALID_OUTPUT", "R5_INPUT_TOO_LONG:hint") };
  }
  let rawText: string;
  try {
    rawText = await raceWithSignal(
      generate(buildRouteIntentPrompt(input), {
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
    instruction: ROUTE_INTENT_INSTRUCTION,
    userContext: options?.context?.userContext ?? input.hint ?? input.intent,
  };
  return normalizeJsonOp(rawText, profile, (value, innerContext) => validateRouteIntent(value, innerContext, input), {
    ...options,
    context,
  });
}

export const routeIntentTaskSpec: AiTaskSpec = taskSpecFor("route-intent");
