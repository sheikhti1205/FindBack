/** The only generative endpoint/model in the active app. Never accept a model from callers. */
const COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";
const KEY_URL = "https://openrouter.ai/api/v1/key";
/** Fixed free route enforced at the transport boundary; callers cannot override it. */
export const OPENROUTER_MODEL = "openrouter/free" as const;
const MODEL = OPENROUTER_MODEL;
/** One deadline spans the request *and* the full consumption of its response body. */
export const REQUEST_TIMEOUT_MS = 25_000;
const MAX_PROMPT = 2_400;
const MAX_ANSWER = 6_000;
const MAX_IMAGE_BYTES = 2_000_000;
/** Response bodies are streamed with a hard cap so a huge payload cannot be buffered. */
const MAX_RESPONSE_BYTES = 1_000_000;

export type OpenRouterErrorCode =
  | "MISSING_KEY" | "INVALID_KEY" | "PERMISSION_DENIED" | "PAYMENT_OR_POLICY_BLOCKED"
  | "DAILY_LIMIT" | "RATE_LIMITED" | "FREE_CAPABILITY_UNAVAILABLE"
  | "NO_FREE_MODEL" | "INVALID_IMAGE" | "CONSENT_REQUIRED" | "CANCELLED"
  | "TIMEOUT" | "NETWORK" | "UNUSABLE_RESPONSE" | "PROVIDER_ERROR";

const COPY: Record<OpenRouterErrorCode, string> = {
  MISSING_KEY: "Connect your OpenRouter API key to use AI.",
  INVALID_KEY: "Your OpenRouter key was rejected. Check the key in AI Connection.",
  PERMISSION_DENIED: "OpenRouter refused this key for the free route. Check your OpenRouter account and key permissions.",
  PAYMENT_OR_POLICY_BLOCKED: "OpenRouter blocked this free request for payment or policy reasons. FindBack stays on free models only and never switches to a paid model. Check your OpenRouter account.",
  DAILY_LIMIT: "Your OpenRouter free allowance is exhausted. Try again after it resets.",
  RATE_LIMITED: "OpenRouter is limiting requests. Please try again later.",
  FREE_CAPABILITY_UNAVAILABLE: "No compatible free model supports this request right now. Please try again later or use the manual form.",
  NO_FREE_MODEL: "No compatible free model is available right now. Please try again later.",
  INVALID_IMAGE: "Choose a JPEG, PNG or WebP image smaller than 2 MB.",
  CONSENT_REQUIRED: "Confirm before sending this photo to OpenRouter.",
  CANCELLED: "AI request cancelled.",
  TIMEOUT: "OpenRouter took too long to respond. Please try again.",
  NETWORK: "Cannot reach OpenRouter. Check your connection.",
  UNUSABLE_RESPONSE: "The free model returned an unusable answer. Please try again.",
  PROVIDER_ERROR: "OpenRouter is unavailable right now. Please try again later.",
};

export class OpenRouterError extends Error {
  constructor(readonly code: OpenRouterErrorCode) {
    super(COPY[code]);
    this.name = "OpenRouterError";
  }
}

function errorFromStatus(status: number, body: unknown): OpenRouterError {
  const error = body && typeof body === "object" ? (body as { error?: unknown }).error : null;
  const data = error && typeof error === "object" ? error as { code?: unknown; message?: unknown; metadata?: unknown } : null;
  const metadata = data?.metadata && typeof data.metadata === "object"
    ? data.metadata as { error_type?: unknown; limit_source?: unknown }
    : null;
  const message = typeof data?.message === "string" ? data.message.toLowerCase() : "";
  // The body may carry an error even on HTTP 200; trust an explicit 4xx/5xx code
  // there, but never let it override a real HTTP error status.
  const embedded = typeof data?.code === "number" && data.code >= 400 && data.code <= 599 ? data.code : null;
  const mapped = status >= 400 ? status : embedded ?? status;
  const daily =
    /free|daily/i.test(String(metadata?.limit_source ?? "")) ||
    /daily.{0,24}(limit|allowance|quota|usage)|(limit|allowance|quota|usage).{0,24}daily|free.{0,16}(limit|allowance|exhaust|daily)|daily.{0,16}free/.test(message);
  const noFreeModel = /no enabled providers|routing requirements|no compatible free model|no free models?/.test(message);
  const paidOrPolicy =
    mapped === 402 ||
    /payment required|insufficient (credit|balance|funds)|out of credit|top.?up|billing|requires (credits?|payment)|add (credits?|funds)|quota.+payment|payment.+quota|policy/.test(message) ||
    metadata?.error_type === "insufficient_credits" || metadata?.error_type === "payment_required";
  const capabilityMismatch = /not supported|unsupported (parameter|model|route|capabilit|response format|response_format)|no .* (vision|image|json|tool) (support|capabilit)|capabilit|does not support (vision|images|json|structured)/.test(message);
  if (mapped === 401 || metadata?.error_type === "authentication") return new OpenRouterError("INVALID_KEY");
  if (paidOrPolicy) return new OpenRouterError("PAYMENT_OR_POLICY_BLOCKED");
  if (mapped === 403 || metadata?.error_type === "forbidden") return new OpenRouterError("PERMISSION_DENIED");
  if (mapped === 429 || metadata?.error_type === "rate_limit_exceeded") {
    return new OpenRouterError(daily ? "DAILY_LIMIT" : "RATE_LIMITED");
  }
  if (daily) return new OpenRouterError("DAILY_LIMIT");
  if (mapped === 408) return new OpenRouterError("TIMEOUT");
  if (mapped === 503 || metadata?.error_type === "provider_overloaded" || noFreeModel) {
    return new OpenRouterError("NO_FREE_MODEL");
  }
  if (metadata?.error_type === "unsupported_image_format" || metadata?.error_type === "invalid_image" ||
    /unsupported image|invalid image|image format|image size|image too (large|big)/.test(message)) {
    return new OpenRouterError("INVALID_IMAGE");
  }
  // Image wording above keeps INVALID_IMAGE; other unsupported-parameter/schema wording
  // means no eligible free model for this request shape — same route, no paid fallback.
  if (capabilityMismatch) return new OpenRouterError("FREE_CAPABILITY_UNAVAILABLE");
  return new OpenRouterError("PROVIDER_ERROR");
}

function checkedImageDataUrl(image: string): string {
  const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(image);
  if (!match || match[2]!.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || match[2]!.length < 4) {
    throw new OpenRouterError("INVALID_IMAGE");
  }
  // Bounded base64 validation; never fetch arbitrary URLs or read private files.
  try {
    const binary = atob(match[2]!);
    if (binary.length > MAX_IMAGE_BYTES || binary.length === 0) throw new Error("size");
  } catch {
    throw new OpenRouterError("INVALID_IMAGE");
  }
  return image;
}

function checkedPrompt(prompt: string): string {
  const text = prompt.trim();
  if (text.length === 0 || text.length > MAX_PROMPT) throw new OpenRouterError("UNUSABLE_RESPONSE");
  return text;
}

/**
 * Bounded body read: at most MAX_RESPONSE_BYTES are buffered, so an oversized
 * payload can never be materialised. Falls back to res.json() when the runtime
 * exposes no byte stream (test doubles, minimal fetch shims).
 */
async function readJsonBounded(res: Response): Promise<unknown> {
  const stream: unknown = res.body;
  if (!stream || typeof (stream as ReadableStream<Uint8Array>).getReader !== "function") {
    try { return await res.json(); } catch { throw new OpenRouterError("UNUSABLE_RESPONSE"); }
  }
  const reader = (stream as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new OpenRouterError("UNUSABLE_RESPONSE");
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    if (error instanceof OpenRouterError) throw error;
    throw new OpenRouterError("UNUSABLE_RESPONSE");
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  try { return JSON.parse(text); } catch { throw new OpenRouterError("UNUSABLE_RESPONSE"); }
}

/**
 * Runs one request and the complete consumption of its response under a single
 * deadline. The timer is cleared only after `consume` settles, so a stalled or
 * slow response stream is aborted mid-read instead of outliving the deadline.
 * Network requests are abortable, time-bounded and never include upstream text
 * in errors.
 */
async function withDeadline<T>(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
  consume: (res: Response) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, REQUEST_TIMEOUT_MS);
  if (signal?.aborted) abort();
  const failure = (): OpenRouterError =>
    new OpenRouterError(signal?.aborted ? "CANCELLED" : controller.signal.aborted ? "TIMEOUT" : "NETWORK");
  try {
    const res = await fetcher(url, { ...init, signal: controller.signal });
    return await consume(res);
  } catch (error) {
    // A deadline/cancel that surfaces mid-body-read must win over the generic
    // body-read error; other semantic errors pass through untouched.
    if (controller.signal.aborted || signal?.aborted) throw failure();
    if (error instanceof OpenRouterError) throw error;
    throw failure();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

export function createOpenRouterClient(getKey: () => Promise<string | null>, fetcher: typeof fetch = fetch) {
  async function complete(content: string | unknown[], signal?: AbortSignal): Promise<string> {
    const key = (await getKey())?.trim();
    if (!key) throw new OpenRouterError("MISSING_KEY");
    const { ok, status, data } = await withDeadline(fetcher, COMPLETIONS_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: MODEL, stream: false, messages: [{ role: "user", content }], max_tokens: 600 }),
    }, signal, async (res) => ({ ok: res.ok, status: res.status, data: await readJsonBounded(res) }));
    if (!ok || (data && typeof data === "object" && "error" in data)) {
      throw errorFromStatus(status, data);
    }
    const choice = (data as { choices?: Array<{ finish_reason?: unknown; error?: unknown; message?: { content?: unknown } }> })?.choices?.[0];
    if (choice?.error) throw errorFromStatus(502, { error: choice.error });
    if (choice?.finish_reason !== "stop" || typeof choice.message?.content !== "string") {
      throw new OpenRouterError("UNUSABLE_RESPONSE");
    }
    const answer = choice.message.content.trim();
    if (answer.length === 0 || answer.length > MAX_ANSWER) throw new OpenRouterError("UNUSABLE_RESPONSE");
    return answer;
  }

  return {
    text: async (prompt: string, options?: { signal?: AbortSignal }): Promise<string> =>
      complete(checkedPrompt(prompt), options?.signal),
    image: async (prompt: string, image: string, consent: boolean, options?: { signal?: AbortSignal }): Promise<string> => {
      if (!consent) throw new OpenRouterError("CONSENT_REQUIRED");
      const checked = checkedImageDataUrl(image);
      return complete([
        { type: "text", text: checkedPrompt(prompt) },
        { type: "image_url", image_url: { url: checked } },
      ], options?.signal);
    },
    validateKey: async (rawKey: string, signal?: AbortSignal): Promise<{ remaining: number | null }> => {
      const key = rawKey.trim();
      if (!key || /[\r\n]/.test(key)) throw new OpenRouterError("INVALID_KEY");
      const { ok, status, body } = await withDeadline(fetcher, KEY_URL, {
        method: "GET", headers: { authorization: `Bearer ${key}` },
      }, signal, async (res) => ({ ok: res.ok, status: res.status, body: await readJsonBounded(res) }));
      if (!ok || (body && typeof body === "object" && "error" in body)) throw errorFromStatus(status, body);
      const info = (body as { data?: { is_management_key?: unknown; free_model_daily_requests?: { remaining?: unknown } } })?.data;
      if (!info || info.is_management_key === true) throw new OpenRouterError("INVALID_KEY");
      const remaining = info.free_model_daily_requests?.remaining;
      return { remaining: typeof remaining === "number" && Number.isFinite(remaining) ? remaining : null };
    },
  };
}
