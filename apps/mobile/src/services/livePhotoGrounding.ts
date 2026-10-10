/** Real, consented local-first vision transport for the reviewed report selector. */
import { getApplicationAi } from "./ai/applicationAi";
import { effectivePhotoEngine, type PhotoEnginePreference } from "./ai/aiPreferences";
import { profileFor } from "./ai/modelProfiles";
import { GROUND_EXPRESSION_MAX_CHARS, type GroundGenerateFn } from "./ai/ops/groundObjects";
import { makeAiError, type AiResult } from "./ai/types";
import { createOpenRouterClient, OpenRouterError } from "./openRouter";
import { resolveAccountOpenRouterKey } from "./aiCredentials";
import { normalizeImage } from "./image";
import { requestGroundedOptions, type GroundedOptions } from "./photoGrounding";
import { throwIfAborted, withTimeout } from "./timeout";

const VISION_MODEL = "smolvlm2-500M-vision";
export interface LiveGroundedOptions extends GroundedOptions {
  readonly engine: "on-device" | "cloud";
  /** Exact normalized image seen by inference, so orientation and boxes agree. */
  readonly imageUrl: string;
}
interface TransportOptions { readonly signal: AbortSignal; readonly accountId: string }
export interface GroundingDeps {
  local(prompt: string, imageBase64: string, options: TransportOptions): Promise<string | null>;
  cloud(prompt: string, imageUrl: string, consent: boolean, options: { signal: AbortSignal }): Promise<string>;
}
export interface LiveGroundingOptions {
  readonly signal?: AbortSignal;
  readonly photoEngine?: PhotoEnginePreference;
  readonly accountId?: string;
  /** Test seam only. Omitted in the production CreateReport consumer. */
  readonly deps?: GroundingDeps;
}

/**
 * The application-owned cancellable offline vision adapter loads the same
 * verified Smol runtime as local-vision. Unlike RouteContext (which has no
 * signal), this surface forwards cancellation all the way to native generation.
 * Only this request's approved image is resolvable; no draft/history is sent.
 */
async function localGround(prompt: string, imageBase64: string, { signal, accountId }: TransportOptions): Promise<string | null> {
  throwIfAborted(signal);
  const imageId = crypto.randomUUID();
  const adapter = getApplicationAi().offlineAdapter(async (id) => {
    throwIfAborted(signal);
    if (id !== imageId) throw new Error("Unapproved grounding image");
    return imageBase64;
  });
  let text = "";
  for await (const event of adapter.complete({
    selection: { accountId, provider: "offline", modelId: VISION_MODEL, mode: "free-only" },
    task: "image-question", policyVersion: "ground-objects/v1", knowledgeVersion: "none",
    currentText: prompt, recentTurns: [], approvedImageIds: [imageId], authorizedResultIds: [],
    maxOutputTokens: profileFor(VISION_MODEL)!.maxOutputTokensVision!, signal,
  })) {
    throwIfAborted(signal);
    if (event.kind === "error") return null;
    if (event.kind === "done" && event.stopReason === "cancelled") throw new DOMException("Aborted", "AbortError");
    if (event.kind === "text") {
      text += event.delta;
      if (text.length > 12_000) return null;
    }
  }
  throwIfAborted(signal);
  return text || null;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Account-bound key resolution for grounding sends. Delegates to the shared
 * fail-closed resolver: exactly one session lookup, no "currently signed in"
 * fallback, so an account switch mid-request can never retarget the send.
 */
async function resolveGroundingKey(accountId: string): Promise<string | null> {
  return resolveAccountOpenRouterKey(accountId);
}

/** Never crops, infers location, writes the draft, publishes, or auto-applies. */
export async function groundReportPhoto(
  file: File,
  expression: string,
  consent: boolean,
  options: LiveGroundingOptions = {},
): Promise<AiResult<LiveGroundedOptions>> {
  if (!consent) throw new OpenRouterError("CONSENT_REQUIRED");
  throwIfAborted(options.signal);
  const referringExpression = expression.trim();
  if (!referringExpression) throw new Error("Describe the item to look for in the photo.");
  if (referringExpression.length > GROUND_EXPRESSION_MAX_CHARS) throw new Error("Use at most 140 characters to describe the item.");
  // Source acceptance mirrors the media pipeline (≤100 MB, any image-like
  // source). No MIME pre-gate: HEIC/HEIF/AVIF/GIF normalize first; the AI
  // ceiling applies to the derivative below, never to the user's source.
  if (file.size === 0 || file.size > 100 * 1024 * 1024) {
    throw new OpenRouterError("INVALID_IMAGE");
  }
  const accountId = options.accountId ?? "local";
  const engine = options.photoEngine ?? effectivePhotoEngine(accountId);
  const normalized = await normalizeImage(file, undefined, { signal: options.signal });
  throwIfAborted(options.signal);
  // The normalized derivative is the exact image inference sees (orientation
  // applied, EXIF stripped). No 2 MB / 1920px skip: a readable source always
  // attempts grounding; the ladder below fits the cloud transport instead of
  // refusing.
  if (normalized.blob.size === 0 || normalized.width <= 0 || normalized.height <= 0) {
    throw new OpenRouterError("INVALID_IMAGE");
  }
  // Fit the cloud transport (~2 MB) via a quality ladder instead of refusing.
  // The on-device leg uses the same fitted derivative: smaller is always
  // safe for grounding, and one exact image keeps orientation/boxes honest.
  let fittedBlob = normalized.blob;
  let fittedMime = normalized.mimeType;
  if (fittedBlob.size > 2_000_000) {
    const derivativeFile = new File([fittedBlob], "ground-derivative", { type: fittedMime });
    let fitted: { blob: Blob; mimeType: string } | null = null;
    for (const quality of [0.7, 0.55, 0.4]) {
      try {
        const attempt = await normalizeImage(derivativeFile, undefined, {
          signal: options.signal,
          quality: { jpeg: quality, webp: quality },
        });
        if (attempt.blob.size <= 2_000_000) {
          fitted = attempt;
          break;
        }
      } catch {
        break;
      }
    }
    if (fitted === null && (fittedMime === "image/png" || fittedMime === "image/gif")) {
      const asJpeg = new File([fittedBlob], "ground-derivative.jpg", { type: "image/jpeg" });
      for (const quality of [0.82, 0.7, 0.55, 0.4]) {
        try {
          const attempt = await normalizeImage(asJpeg, undefined, {
            signal: options.signal,
            quality: { jpeg: quality, webp: quality },
          });
          if (attempt.blob.size <= 2_000_000) {
            fitted = attempt;
            break;
          }
        } catch {
          break;
        }
      }
    }
    if (fitted === null) throw new OpenRouterError("INVALID_IMAGE");
    fittedBlob = fitted.blob;
    fittedMime = fitted.mimeType;
  }
  const bytes = new Uint8Array(await fittedBlob.arrayBuffer());
  throwIfAborted(options.signal);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  const imageBase64 = btoa(binary);
  const imageUrl = `data:${fittedMime};base64,${imageBase64}`;
  const profile = profileFor(VISION_MODEL)!;

  async function run(used: "on-device" | "cloud"): Promise<AiResult<LiveGroundedOptions>> {
    throwIfAborted(options.signal);
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    let failure: unknown;
    const generate: GroundGenerateFn = async (prompt, transport) => {
      // Bind exactly the normalized photo supplied to the op. No arbitrary URI
      // fetch, text-only inference or default fake can silently replace it.
      if (transport.imageUri !== imageUrl) throw new Error("Grounding image mismatch");
      try {
        if (used === "cloud") {
          return await (options.deps?.cloud ?? ((p, image, confirmed, opts) =>
            createOpenRouterClient(() => resolveGroundingKey(accountId)).image(p, image, confirmed, opts)))(prompt, imageUrl, true, { signal: controller.signal });
        }
        const text = await withTimeout(() => (options.deps?.local ?? localGround)(prompt, imageBase64, { signal: controller.signal, accountId }),
          30_000, "On-device item search took too long.", controller.signal);
        if (text === null) throw new Error("On-device item search is unavailable.");
        return text;
      } catch (error) { failure = error; throw error; }
    };
    try {
      const result = await requestGroundedOptions(generate, profile, { imageUri: imageUrl, referringExpression, imageConsent: true, signal: controller.signal });
      throwIfAborted(options.signal);
      if (isAbort(failure) || (!result.ok && result.error.errorClass === "CANCELLED")) throw new DOMException("Aborted", "AbortError");
      if (failure && used === "cloud") throw failure;
      return result.ok ? { ok: true, value: { ...result.value, engine: used, imageUrl } } : result;
    } finally {
      options.signal?.removeEventListener("abort", abort);
      // Also cancel a timed-out/overlong local stream, not just its UI wait.
      controller.abort();
    }
  }

  if (engine !== "cloud-only") {
    let local: AiResult<LiveGroundedOptions>;
    try { local = await run("on-device"); }
    catch (error) {
      throwIfAborted(options.signal);
      if (isAbort(error)) throw error;
      local = { ok: false, error: makeAiError("MODEL_UNAVAILABLE", "ON_DEVICE_UNAVAILABLE", "On-device item search is unavailable. Install the local model or choose a different photo engine.") };
    }
    throwIfAborted(options.signal);
    if (local.ok || engine === "on-device-only") return local;
  }
  // Automatic consent explicitly includes cloud fallback; abort always wins.
  throwIfAborted(options.signal);
  return run("cloud");
}
