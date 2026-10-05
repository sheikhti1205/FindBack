import { createOpenRouterClient, OpenRouterError } from "./openRouter";
import { getConnectedOpenRouterKey } from "./aiCredentials";
import { normalizeImage } from "./image";
import { parseVlmOutput, type VlmAnalysis } from "./vlmParser";
import {
  analyzeReportPhotoLocally,
  PHOTO_CATEGORY_CANONICALS,
  PHOTO_INSTRUCTION,
} from "./analyzeReportPhotoLocal";

interface PhotoDeps {
  encode(file: File): Promise<string>;
  send(prompt: string, image: string, consent: boolean, options?: { signal?: AbortSignal }): Promise<string>;
  /**
   * On-device analyzer seam. Defaults to the real local analyzer; tests inject
   * a fake so the cloud path can be exercised deterministically.
   */
  analyzeLocally?(file: File, opts?: { signal?: AbortSignal }): Promise<VlmAnalysis | null>;
  /**
   * Photo-engine preference seam. Lane A owns the real store; when it is
   * absent this seam is simply unused and `getPhotoEngine()` below falls back
   * to 'automatic'. Tests inject a fake to exercise each engine deterministically.
   */
  getPhotoEngine?(): PhotoEnginePreference;
}

/** Photo engine preference (Lane A owns the persisted store; this is the read seam). */
export type PhotoEnginePreference = "automatic" | "on-device-only" | "cloud-only";

/** Which engine actually produced a photo analysis. */
export type PhotoEngineUsed = "on-device" | "cloud";

/** Photo analysis with the producing engine attached (assignable to VlmAnalysis). */
export type PhotoAnalysis = VlmAnalysis & { engine: PhotoEngineUsed };

/** Fail-closed code when `on-device-only` cannot analyze locally. Never falls back to cloud. */
export const PHOTO_ON_DEVICE_UNAVAILABLE_CODE = "ON_DEVICE_UNAVAILABLE" as const;
export const PHOTO_ON_DEVICE_UNAVAILABLE_MESSAGE =
  "On-device photo analysis isn't available on this device. Install the local model or choose a different engine.";

function isPhotoEnginePreference(value: unknown): value is PhotoEnginePreference {
  return value === "automatic" || value === "on-device-only" || value === "cloud-only";
}

/**
 * Narrow preference seam. Reads the published effective engine slot (fed by
 * the persisted aiPreferences store; see publishEffectivePhotoEngine), with a
 * tolerant fallback (test/global override, then the localStorage slot), and
 * defaults to 'automatic' so the local-first default stays intact.
 */
export function getPhotoEngine(): PhotoEnginePreference {
  try {
    const scope = globalThis as { __findbackPhotoEngine?: unknown; localStorage?: Storage };
    if (isPhotoEnginePreference(scope.__findbackPhotoEngine)) return scope.__findbackPhotoEngine;
    const stored = scope.localStorage?.getItem("findback.photoEngine");
    if (isPhotoEnginePreference(stored)) return stored;
  } catch {
    // Storage/global access must never break analysis; fall through to default.
  }
  return "automatic";
}

function onDeviceUnavailable(): Error & { code: string } {
  return Object.assign(new Error(PHOTO_ON_DEVICE_UNAVAILABLE_MESSAGE), {
    code: PHOTO_ON_DEVICE_UNAVAILABLE_CODE,
  });
}

async function encodePhoto(file: File): Promise<string> {
  const normalized = await normalizeImage(file);
  if (normalized.blob.size > 2_000_000 || normalized.width > 1920 || normalized.height > 1920) {
    throw new OpenRouterError("INVALID_IMAGE");
  }
  const bytes = new Uint8Array(await normalized.blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return `data:${normalized.mimeType};base64,${btoa(binary)}`;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Suggestions only. Form application is an independent, confirmed UI action.
 *
 * Local-first (owner decision): the on-device SmolVLM2 vision model is the
 * DEFAULT engine; cloud OpenRouter is the fallback. Preference-aware:
 * - automatic (default): try local, fall back to cloud on non-abort failure;
 *   an abort propagates and never hits the network.
 * - on-device-only: local only, fail closed with an honest unavailable error;
 *   cloud is never contacted (abort still propagates).
 * - cloud-only: skip local entirely and run the cloud path.
 * Consent and image validation run first and are engine-independent.
 */
export async function analyzeReportPhoto(
  file: File,
  consent: boolean,
  options?: { signal?: AbortSignal; deps?: PhotoDeps; photoEngine?: PhotoEnginePreference }
): Promise<PhotoAnalysis> {
  if (!consent) throw new OpenRouterError("CONSENT_REQUIRED");
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 8_000_000) {
    throw new OpenRouterError("INVALID_IMAGE");
  }

  const rawEngine =
    options?.photoEngine ?? options?.deps?.getPhotoEngine?.() ?? getPhotoEngine();
  const engine: PhotoEnginePreference = isPhotoEnginePreference(rawEngine) ? rawEngine : "automatic";

  const analyzeLocally = options?.deps?.analyzeLocally ?? analyzeReportPhotoLocally;

  async function runCloud(): Promise<PhotoAnalysis> {
    const image = await (options?.deps?.encode ?? encodePhoto)(file);
    const text = await (options?.deps?.send ?? ((
      prompt: string,
      data: string,
      confirmed: boolean,
      opts?: { signal?: AbortSignal }
    ) => createOpenRouterClient(getConnectedOpenRouterKey).image(prompt, data, confirmed, opts)))(PHOTO_INSTRUCTION, image, consent, options);
    const parsed = parseVlmOutput(text, PHOTO_CATEGORY_CANONICALS);
    if (parsed === null) throw new OpenRouterError("UNUSABLE_RESPONSE");
    // Every catalog category is released (migration 20260926000001 applied),
    // and parseVlmOutput already constrains suggestions to the catalog, so a
    // parsed category is always form-applicable. Unknown strings never parse.
    return { ...parsed, engine: "cloud" };
  }

  if (engine === "cloud-only") {
    return runCloud();
  }

  if (engine === "on-device-only") {
    let local: VlmAnalysis | null;
    try {
      local = await analyzeLocally(file, { signal: options?.signal });
    } catch (error) {
      if (isAbort(error)) throw error;
      throw onDeviceUnavailable();
    }
    if (local === null) throw onDeviceUnavailable();
    return { ...local, engine: "on-device" };
  }

  try {
    const local = await analyzeLocally(file, { signal: options?.signal });
    if (local !== null) return { ...local, engine: "on-device" };
  } catch (error) {
    if (isAbort(error)) throw error;
    // Any other local failure (no Android runtime, model absent, load failure,
    // unparseable output) falls through to the cloud fallback below.
  }

  return runCloud();
}
