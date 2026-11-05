/**
 * Live narrow-task transport — strictly on-device.
 *
 * Narrow tasks (Smart Search filter extraction, report-field and category
 * suggestions) are served only by the on-device router. There is deliberately
 * no cloud fallback: a natural-language query about a user's lost property must
 * never leave the device. When the local helper is unavailable the caller fails
 * closed (see `nlExtractLive`, which yields an empty patch), and the ordinary
 * non-AI path keeps working.
 *
 * Suggestions only — nothing here publishes, writes drafts, or auto-applies.
 *
 * - `generateLocalFirst(taskId, prompt)`: routes one task via
 *   `getApplicationAi().route(taskId, { prompt }, { traceId, consent: true })`.
 *   A non-ok route throws `Error(result.error)`; a string value passes
 *   through as-is, any other value is JSON-stringified for the op parsers.
 *   AbortError always propagates (never swallowed).
 * - `liveGenerateFor(taskId)` is the composer the consumer features use. It is
 *   local-only, so a local failure surfaces to the caller unchanged.
 * Cloud AI Chat has its own provider, vault and account-fenced request owner.
 * This module exposes no cloud transport or credential read.
 */
import { getApplicationAi, type ApplicationAiService } from "./ai/applicationAi";
import { isLocalSearchAbort, localSearchFailureOf, type LocalSearchFailure } from "./ai/localSearchDiagnosis";
import { describeOfflineReadiness } from "./ai/modelReadiness";
import { profileFor } from "./ai/modelProfiles";
import { NEEDLE_MODEL_ID } from "./ai/needle/embedder";
import type { AiTaskId, GenerateFn } from "./ai/types";
import { extractSearchFilters } from "./ai/ops/extractSearchFilters";
import { toValidatedPatch, type NlFilterPatch } from "./search/nlFilters";

export type LiveNarrowTaskId =
  | "extract-search-filters"
  | "extract-report-fields"
  | "classify-category";

export interface LocalFirstOptions {
  readonly signal?: AbortSignal;
  /**
   * Phase A.4: raw task input routed to the on-device engine instead of
   * the engineered prompt. Absent means the prompt itself is the input
   * (legacy callers).
   */
  readonly localInput?: unknown;
}

function abortError(): Error {
  const error = new Error("AI request cancelled.");
  error.name = "AbortError";
  return error;
}

/**
 * A failed local route that keeps its stable denial reason.
 *
 * `generateLocalFirst` must still throw the route's own message (callers and
 * their tests read it), but the denial reason is the only reliable statement
 * of WHICH boundary failed — losing it collapsed "the model never loaded" and
 * "the model ran and returned nothing usable" into one indistinguishable
 * error.
 */
export class LocalRouteError extends Error {
  readonly denialReason: string;

  constructor(denialReason: string, message: string) {
    super(message);
    this.name = "LocalRouteError";
    this.denialReason = denialReason;
  }
}

/**
 * One on-device generation against the local router. Throws on
 * non-ok routes; AbortError propagates untouched.
 */
export async function generateLocalFirst(
  taskId: LiveNarrowTaskId | AiTaskId,
  prompt: string,
  opts?: LocalFirstOptions,
): Promise<string> {
  if (opts?.signal?.aborted) throw abortError();
  // No catch here: route rejections (including AbortError on user cancel)
  // propagate to the caller, which decides fail-closed behaviour.
  // The local route gets the raw task input when the op supplied one —
  // a tool model must see the original request, not an engineered prompt.
  const input = opts?.localInput ?? { prompt };
  const result: Awaited<ReturnType<import("./ai/applicationAi").ApplicationAiService["route"]>> =
    await getApplicationAi().route(
      taskId,
      input,
      { traceId: crypto.randomUUID(), consent: true, ...(opts?.signal ? { signal: opts.signal } : {}) },
    );
  if (opts?.signal?.aborted) throw abortError();
  if (!result.ok) {
    if (/cancel|abort/i.test(result.error) || /cancel|abort/i.test(result.state)) throw abortError();
    // Keep the route's denial reason: the message alone cannot say whether the
    // engine never loaded, the native call failed, or the output was invalid.
    throw new LocalRouteError(result.denialReason, result.error);
  }
  const value = (result as { value?: unknown }).value;
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * Live `GenerateFn` for one narrow task. On-device only, by design: a local
 * failure is surfaced to the caller instead of being escalated to any network
 * transport. An abort (thrown or pre-signalled) propagates untouched.
 */
export function liveGenerateFor(taskId: LiveNarrowTaskId): GenerateFn {
  return async (prompt, genOpts) => {
    const signal = (genOpts as unknown as { signal?: AbortSignal } | undefined)?.signal;
    if (signal?.aborted) throw abortError();
    try {
      return await generateLocalFirst(taskId, prompt, {
        signal,
        ...(genOpts.localTaskInput !== undefined ? { localInput: genOpts.localTaskInput } : {}),
      });
    } catch (error) {
      // A cancel that races a local failure must still surface as an abort
      // rather than as a generic engine error — and it must never escalate.
      if (signal?.aborted) throw abortError();
      throw error;
    }
  };
}

/** Live composer for the report-fields suggestion op. */
export const generateForFieldsLive: GenerateFn = liveGenerateFor("extract-report-fields");

/** Live composer for the category suggestion op. */
export const generateForCategoryLive: GenerateFn = liveGenerateFor("classify-category");

/**
 * Profile for every narrow task: the model that actually serves the route.
 * `extract-search-filters`, `extract-report-fields` and `classify-category` are
 * tool-constrained (structured) tasks, and the production seam serves structured
 * roles ONLY through Needle (`applicationAi.ts` `structuredModelId`, enforced in
 * `productionRuntimes.ts`). Parsing with an unrelated prose profile applied a
 * reasoning envelope to tool output, which truncated any value
 * containing the literal marker and silently dropped the whole patch.
 *
 * Single source of truth (IF-108): `CreateReport.tsx` parses the SAME two ops, so
 * it must hand its ops this same profile. Never re-pin a narrow task to the prose
 * profile.
 */
export const NARROW_TASK_PROFILE_ID = NEEDLE_MODEL_ID;

/**
 * Can the on-device helper that serves Smart Search run on this device at all?
 *
 * `unsupported-platform` is not the same truth as "not set up": a build without
 * the native driver (the web app) can never run on-device AI, so telling that
 * reader the model "isn't set up yet" and offering an install would promise
 * something that can never arrive. The two take different copy (CF-040 F6/F9).
 */
export type NlHelperState =
  | "ready"
  | "not-set-up"
  | "unsupported-platform"
  | "unsupported-device"
  | "unknown";

/**
 * The slice of the routing seam this predicate reads. Injectable so the state
 * machine can be exercised against real statuses instead of a mock of itself;
 * production callers pass nothing and get the live service.
 */
export type NlHelperSource = Pick<
  ApplicationAiService,
  "android" | "ready" | "manager" | "compatibility"
>;

/**
 * Which of the three truths applies: the helper is set up, it is absent on a
 * device that could run it, or this device/build cannot run it at all.
 *
 * Smart Search fails closed either way, so an empty patch alone cannot tell
 * "the helper ran and found nothing confident" apart from "the helper isn't
 * here yet" — and reporting the second as the first is a lie about why nothing
 * happened. This asks the routing seam's OWN predicates, the same ones
 * `applicationAi` enforces before it serves a task (`applicationAi.ts:409`) and
 * the same compatibility snapshot the Local intelligence helper row renders,
 * so this cannot drift from what routing will do.
 *
 * Terminal states are separated because an install offer is a promise:
 *
 * - `unsupported-platform` — the web build, where no install can ever help;
 * - `unsupported-device` — Android, but this device cannot run the runtime
 *   (ABI/runtime mismatch). Uses the canonical compatibility snapshot including
 *   its known limit: device facts that were never collected read as
 *   incompatible here exactly as they do on the models screen — one shared
 *   answer, not two.
 *
 * Readiness is read **after** boot reconciliation settles: before `ready`
 * resolves, an installed model still reports `not-installed`, which would be
 * the same lie in reverse (an installed helper described as absent). For the
 * same reason a state of `installed` is never file presence — the checksum pin
 * must have verified. No probe, no fetch, no credential. This is a diagnostic,
 * so it is total: a failure inside it yields `unknown`, never a rejection and
 * never a claim about the user's device.
 */
export async function nlHelperState(source?: NlHelperSource): Promise<NlHelperState> {
  try {
    const ai = source ?? getApplicationAi();
    if (!ai.android) return "unsupported-platform";
    await ai.ready;
    if (!ai.compatibility(NARROW_TASK_PROFILE_ID).compatible) return "unsupported-device";
    return describeOfflineReadiness(ai.manager, NARROW_TASK_PROFILE_ID).ready
      ? "ready"
      : "not-set-up";
  } catch {
    return "unknown";
  }
}

/**
 * Live NL search extractor: raw input through `extract-search-filters`
 * (on-device only) mapped to a validated patch.
 *
 * The result is TAGGED. An untagged empty patch cannot distinguish "the helper
 * ran and found nothing confident" from "the helper never ran", and reporting
 * the second as the first is a lie about the reader's device. Cancellation
 * still propagates untouched; every other failure is a receipt.
 */
export async function nlExtractLive(input: string): Promise<NlExtractOutcome> {
  const profile = profileFor(NARROW_TASK_PROFILE_ID);
  if (!profile) return { kind: "failed", failure: { stage: "helper", code: "NO_PROFILE" } };
  if (input.trim() === "") return { kind: "extracted", patch: {} };
  try {
    const result = await extractSearchFilters(liveGenerateFor("extract-search-filters"), input, profile);
    if (!result.ok) return { kind: "failed", failure: await describeRouteFailure(result.error) };
    return { kind: "extracted", patch: toValidatedPatch(result.value.fields) };
  } catch (error) {
    if (isLocalSearchAbort(error)) throw error;
    return { kind: "failed", failure: await describeRouteFailure(error) };
  }
}

/**
 * One runtime code covers three different truths — the helper is absent, this
 * build cannot run one, or this device cannot. Ask the same predicate the
 * helper row renders before naming a recovery; a failed predicate leaves the
 * original receipt rather than inventing a device claim.
 */
async function describeRouteFailure(error: unknown): Promise<LocalSearchFailure> {
  const base = localSearchFailureOf(error);
  if (base.stage !== "helper") return base;
  const state = await nlHelperState();
  if (state === "unsupported-platform") return { stage: "plugin", code: "UNSUPPORTED_PLATFORM" };
  if (state === "unsupported-device") return { stage: "plugin", code: "UNSUPPORTED_DEVICE" };
  if (state === "not-set-up") return { stage: "helper", code: "NOT_SET_UP" };
  return base;
}

/**
 * Smart Search's result. A plain patch from an injected extractor means the
 * extractor ran; only the live path can say "it never ran".
 */
export type NlExtractOutcome =
  | { readonly kind: "extracted"; readonly patch: NlFilterPatch }
  | { readonly kind: "failed"; readonly failure: LocalSearchFailure };

/** Normalise an extractor result; a bare patch is a completed extraction. */
export function asNlExtractOutcome(value: NlFilterPatch | NlExtractOutcome): NlExtractOutcome {
  return "kind" in value ? value : { kind: "extracted", patch: value };
}
