import { createOpenRouterClient, OpenRouterError } from "./openRouter";
import { resolveAccountOpenRouterKey } from "./aiCredentials";
import { effectivePhotoEngine } from "./ai/aiPreferences";
import { normalizeImage } from "./image";
import { parseVlmOutput, type VlmAnalysis } from "./vlmParser";
import {
  analyzeReportPhotoLocally,
  PHOTO_CATEGORY_CANONICALS,
  PHOTO_INSTRUCTION,
} from "./analyzeReportPhotoLocal";

interface PhotoDeps {
  encode(file: File): Promise<string>;
  /**
   * Cloud-send seam. Optional: when absent the real account-bound OpenRouter
   * client runs (key resolved for `options.accountId`, fail-closed). Tests
   * inject a fake to avoid the network; the account-binding suite omits it
   * deliberately to exercise the real resolver.
   */
  send?(prompt: string, image: string, consent: boolean, options?: { signal?: AbortSignal }): Promise<string>;
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
 * Engine preference seam, now account-scoped. Reads the owning account's
 * effective engine (assistant mode is authoritative) from the persisted
 * per-account store — never a global/localStorage slot, so one account's
 * choice can never leak into another's send. Absent/unreadable store falls
 * back to 'automatic' (SmolVLM2 local-first). Kept as a function (not a bare
 * import) so tests keep the single-function injection seam via `deps`.
 */
export function getPhotoEngine(accountId = "local"): PhotoEnginePreference {
  try {
    return effectivePhotoEngine(accountId);
  } catch {
    return "automatic";
  }
}

function onDeviceUnavailable(): Error & { code: string } {
  return Object.assign(new Error(PHOTO_ON_DEVICE_UNAVAILABLE_MESSAGE), {
    code: PHOTO_ON_DEVICE_UNAVAILABLE_CODE,
  });
}

async function encodePhoto(file: File): Promise<string> {
  // Canonical AI derivative: normalize (sampled decode, oriented, 1920px
  // upload bound) then fit the ~2 MB transport ceiling via a quality ladder —
  // never reject an otherwise readable source for the AI bound. GIF animation
  // samples to a still JPEG when over bound; PNG over bound re-encodes to
  // JPEG for the AI leg (transparency is irrelevant to inference).
  const first = await normalizeImage(file);
  if (first.blob.size <= 2_000_000 && first.width <= 1920 && first.height <= 1920) {
    return toDataUrl(first.blob, first.mimeType);
  }
  // Over-bound: step down quality on the derivative itself.
  const derivativeFile = new File([first.blob], "ai-derivative", { type: first.mimeType });
  for (const quality of [0.7, 0.55, 0.4]) {
    try {
      const attempt = await normalizeImage(derivativeFile, undefined, { quality: { jpeg: quality, webp: quality } });
      if (attempt.blob.size <= 2_000_000) return toDataUrl(attempt.blob, attempt.mimeType);
    } catch {
      break;
    }
  }
  // PNG/GIF still over bound: sample to a JPEG still for the AI leg.
  if (first.mimeType === "image/png" || first.mimeType === "image/gif") {
    const asJpeg = new File([first.blob], "ai-derivative.jpg", { type: "image/jpeg" });
    for (const quality of [0.82, 0.7, 0.55, 0.4]) {
      try {
        const attempt = await normalizeImage(asJpeg, undefined, { quality: { jpeg: quality, webp: quality } });
        if (attempt.blob.size <= 2_000_000) return toDataUrl(attempt.blob, attempt.mimeType);
      } catch {
        break;
      }
    }
  }
  throw new OpenRouterError("INVALID_IMAGE");
}

async function toDataUrl(blob: Blob, mimeType: string): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
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
  options?: {
    signal?: AbortSignal;
    deps?: PhotoDeps;
    photoEngine?: PhotoEnginePreference;
    /**
     * Owning account for the cloud leg. The key resolver is fail-closed and
     * account-bound: a session owned by anyone else (or no session) refuses
     * the send instead of resolving another account's key. Defaults to
     * "local" (legacy unbound behavior) only when the caller has no account.
     */
    accountId?: string;
  }
): Promise<PhotoAnalysis> {
  if (!consent) throw new OpenRouterError("CONSENT_REQUIRED");
  // Source acceptance mirrors the media pipeline: up to 100 MB when
  // platform-readable. No MIME pre-gate here — HEIC/HEIF/AVIF/GIF normalize
  // first via the canonical derivative pipeline; only empty files and absurd
  // sources refuse up front. The AI transport ceiling applies to the
  // normalized derivative inside encodePhoto, never to the user's source.
  if (file.size === 0) throw new OpenRouterError("INVALID_IMAGE");
  if (file.size > 100 * 1024 * 1024) throw new OpenRouterError("INVALID_IMAGE");

  const accountId = options?.accountId ?? "local";
  const rawEngine =
    options?.photoEngine ?? options?.deps?.getPhotoEngine?.() ?? getPhotoEngine(accountId);
  const engine: PhotoEnginePreference = isPhotoEnginePreference(rawEngine) ? rawEngine : "automatic";

  const analyzeLocally = options?.deps?.analyzeLocally ?? analyzeReportPhotoLocally;

  async function runCloud(): Promise<PhotoAnalysis> {
    const image = await (options?.deps?.encode ?? encodePhoto)(file);
    const text = await (options?.deps?.send ?? ((
      prompt: string,
      data: string,
      confirmed: boolean,
      opts?: { signal?: AbortSignal }
    ) => createOpenRouterClient(() => resolveAccountOpenRouterKey(accountId)).image(prompt, data, confirmed, opts)))(PHOTO_INSTRUCTION, image, consent, options);
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
