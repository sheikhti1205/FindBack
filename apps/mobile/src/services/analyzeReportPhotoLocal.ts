/**
 * On-device report-photo analyzer (SmolVLM2 via the AI orchestrator).
 *
 * The DEFAULT engine for report-photo suggestions is the on-device vision
 * model. This module is the only place that calls `route("analyze-image")`
 * for the report-photo flow; it NEVER makes a cloud call. It normalizes via
 * the canonical derivative pipeline (sampled decode, oriented, bounded —
 * never a full-res source in JS) and routes the base64 to the `local-vision`
 * runtime with explicit consent. There is no 2 MB / 1920px skip: a readable
 * source always attempts inference; downsampling happens inside normalization.
 *
 * Availability is fail-open to the caller: any non-abort failure (no Android
 * runtime, model not installed, unparseable output) resolves `null` so the
 * cloud fallback can run. AbortError is never swallowed — a user cancel must
 * stop the whole request.
 */
import { CATEGORIES, CATEGORY_CATALOG } from "@findback/shared";
import { getApplicationAi } from "./ai/applicationAi";
import { normalizeImage } from "./image";
import { throwIfAborted } from "./timeout";
import { parseVlmOutput, type VlmAnalysis } from "./vlmParser";

/**
 * The exact 9-field instruction the cloud analyzer sends, shared so both
 * engines ask for the same structured `photo-analysis/v2` object.
 */
export const PHOTO_INSTRUCTION = `Analyze only what is visible in this lost-and-found item photo. Do not guess personal details.
Return one JSON object with ALL of these fields: objectName (string|null), suggestedCategory (string|null), colors (string[]), visibleBrand (string|null), visibleText (string[]), identifyingFeatures (string[]), suggestedTitle (string|null), suggestedDescription (string|null), uncertainFields (string[]).
Allowed suggestedCategory: ${JSON.stringify(CATEGORIES)}. Mark uncertain details in uncertainFields. Never invent identifying text.`;

/** Released category canonicals; the same allowlist `parseVlmOutput` gets from the cloud path. */
export const PHOTO_CATEGORY_CANONICALS: readonly string[] = CATEGORY_CATALOG.map(
  (option) => option.canonical,
);

/**
 * Injectable route seam. Matches the shape this module needs from
 * `ApplicationAiService.route` without importing the orchestrator types into
 * every test double.
 */
export type LocalAnalyzeRoute = (
  taskId: "analyze-image",
  input: { readonly prompt: string; readonly imageBase64: string },
  context: { readonly traceId: string; readonly consent: true },
) => Promise<{ readonly ok: boolean; readonly value?: unknown }>;

const defaultRoute: LocalAnalyzeRoute = (taskId, input, context) =>
  getApplicationAi().route(taskId, input, context);

export interface LocalAnalyzeOptions {
  readonly signal?: AbortSignal;
  /** Test seam; defaults to the application-owned on-device service. */
  readonly route?: LocalAnalyzeRoute;
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  return error instanceof Error && error.name === "AbortError";
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
}

/** Normalize + base64-encode without the `data:` URL prefix the bridge does not want. */
async function encodeImageBase64(file: File, signal?: AbortSignal): Promise<string | null> {
  try {
    const normalized = await normalizeImage(file, undefined, { signal });
    throwIfAborted(signal);
    // No size/edge skip: the canonical pipeline already downsamples (sampled
    // decode, 1920px derivative bound). A readable source always attempts
    // inference; oversized derivatives are still sent — the runtime, not the
    // picker, owns any model-specific bound.
    return bytesToBase64(new Uint8Array(await normalized.blob.arrayBuffer()));
  } catch (error) {
    if (isAbortError(error) || signal?.aborted) throw error;
    return null;
  }
}

function textOf(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const text = (value as { text?: unknown }).text;
  return typeof text === "string" ? text : null;
}

/**
 * Analyze one report photo on-device. Resolves a parsed `VlmAnalysis`, or
 * `null` when the on-device path is unavailable/unusable so the caller can
 * fall back to cloud. Only AbortError escapes.
 */
export async function analyzeReportPhotoLocally(
  file: File,
  opts?: LocalAnalyzeOptions,
): Promise<VlmAnalysis | null> {
  const signal = opts?.signal;
  try {
    throwIfAborted(signal);
    const imageBase64 = await encodeImageBase64(file, signal);
    if (imageBase64 === null) return null;
    const route = opts?.route ?? defaultRoute;
    const result = await route(
      "analyze-image",
      { prompt: PHOTO_INSTRUCTION, imageBase64 },
      { traceId: crypto.randomUUID(), consent: true },
    );
    if (!result.ok) return null;
    const text = textOf(result.value);
    if (text === null) return null;
    return parseVlmOutput(text, PHOTO_CATEGORY_CANONICALS);
  } catch (error) {
    if (isAbortError(error) || signal?.aborted) throw error;
    return null;
  }
}
