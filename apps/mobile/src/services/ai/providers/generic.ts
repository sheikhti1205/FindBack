/**
 * Generic OpenAI-compatible provider adapter (AI-020e).
 *
 * Configurable `baseURL` for any OpenAI-compatible endpoint (Ollama, LM
 * Studio, LAN gateways, arbitrary cloud endpoints):
 * - `POST {baseURL}/chat/completions` with `stream: true` SSE
 *   (`data:` chunks with `choices[0].delta.content`, `:` keepalive comments,
 *   terminator `data: [DONE]`, optional final usage chunk).
 * - `GET {baseURL}/models` best-effort catalogue; any failure falls back to
 *   an empty (unknown) catalogue and never throws.
 *
 * Honesty constraints (mirrors the OpenRouter adapter):
 * - Key arrives per call via the injected `getApiKey` resolver. `null`/empty
 *   means keyless (LAN) and the request is sent without an `Authorization`
 *   header — never an `auth-missing` error.
 * - `baseURL` is validated/sanitized at construction: http/https only, no
 *   credentials in the URL, trailing slashes stripped. Invalid input throws
 *   synchronously; construction never performs network I/O.
 * - Pricing is never invented: every model record carries `prices: []` and
 *   `priceClass: "unknown"`.
 * - No prompt/photo/key logging (no console usage at all), single attempt
 *   only, abort-aware throughout.
 *
 * NOTE: reports the `"generic"` union member (IF-001) and tags its model
 * records with the same id.
 */
import type {
  ModelRecord,
  NormalizedRequest,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderId,
  StreamEvent,
} from "../providerContract";

const ERROR_BODY_MAX_CHARS = 65536;
const ERROR_MESSAGE_MAX_CHARS = 500;

export interface GenericAdapterOptions {
  /**
   * Base URL of the OpenAI-compatible API root, e.g.
   * `http://localhost:11434/v1` or `https://api.example.com/v1`.
   * The adapter appends `/chat/completions` and `/models`.
   */
  baseURL: string;
  /**
   * Union id this adapter reports. Defaults to `"generic"`.
   */
  provider?: ProviderId;
  /**
   * Resolve the caller's key; `null`/empty means keyless (LAN) — the request
   * is sent without an `Authorization` header. Never embedded here.
   */
  getApiKey: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  /**
   * Optional extra headers sent on both chat and models calls (e.g.
   * `HTTP-Referer`, `X-Title`). `Authorization`, `Content-Type`, and
   * `Accept` are owned by the adapter and cannot be overridden here.
   */
  extraHeaders?: Record<string, string>;
  /**
   * Resolve an approved image id to a deliverable URL. When request images
   * exist but no resolver is configured the call fails loudly instead of
   * silently dropping user-approved photos.
   */
  resolveImageUrl?: (imageId: string) => Promise<string | null>;
}

type OutgoingMessage = {
  role: string;
  content:
    | string
    | Array<
        | { type: "text"; text: string }
        | { type: "image_url"; image_url: { url: string } }
      >;
};

function positiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    return undefined;
  return Math.floor(value);
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * Validate and normalize a base URL. Throws on anything that is not an
 * http(s) URL without embedded credentials. Trailing slashes are stripped.
 */
export function normalizeBaseURL(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") throw new Error("generic-invalid-base-url: empty baseURL.");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("generic-invalid-base-url: unparseable baseURL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("generic-invalid-base-url: only http(s) baseURLs are allowed.");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error("generic-invalid-base-url: credentials must not appear in the baseURL.");
  }
  if (parsed.hostname === "") {
    throw new Error("generic-invalid-base-url: missing host.");
  }
  return trimmed.replace(/\/+$/, "");
}

function sanitizedExtraHeaders(
  extra: Record<string, string> | undefined,
): Record<string, string> {
  if (extra === undefined) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(extra)) {
    const lower = key.toLowerCase();
    if (lower === "authorization" || lower === "content-type" || lower === "accept") continue;
    if (typeof value !== "string" || value === "") continue;
    out[key] = value;
  }
  return out;
}

async function readJsonBounded(res: Response): Promise<unknown> {
  const text = await res.text();
  const trimmed = text.trim();
  if (trimmed === "") return null;
  if (trimmed.length > ERROR_BODY_MAX_CHARS)
    throw new Error("generic-body-too-large");
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function apiErrorMessage(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const err = (body as { error?: unknown }).error;
  if (typeof err === "string" && err.trim() !== "")
    return truncate(err, ERROR_MESSAGE_MAX_CHARS);
  if (typeof err === "object" && err !== null) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string" && message.trim() !== "")
      return truncate(message, ERROR_MESSAGE_MAX_CHARS);
  }
  return undefined;
}

function errorForStatus(
  status: number,
  body: unknown,
): { code: string; message: string; retryable: boolean } {
  const detail = apiErrorMessage(body);
  if (status === 400)
    return { code: "bad-request", message: detail ?? "Custom endpoint rejected the request.", retryable: false };
  if (status === 401)
    return { code: "auth-invalid", message: detail ?? "Custom endpoint rejected the API key.", retryable: false };
  if (status === 402)
    return { code: "payment-required", message: detail ?? "Custom endpoint reports insufficient credits.", retryable: false };
  if (status === 404)
    return { code: "not-found", message: detail ?? "Custom endpoint model or route not found.", retryable: false };
  if (status === 429)
    return { code: "rate-limited", message: detail ?? "Custom endpoint rate limit hit.", retryable: true };
  if (status >= 500)
    return { code: "provider-error", message: detail ?? `Custom endpoint upstream failure (HTTP ${status}).`, retryable: true };
  return { code: "request-failed", message: detail ?? `Custom endpoint request failed (HTTP ${status}).`, retryable: false };
}

export function createGenericAdapter(
  options: GenericAdapterOptions,
): ProviderAdapter {
  const base = normalizeBaseURL(options.baseURL);
  const providerId: ProviderId = options.provider ?? "generic";
  const completionsUrl = `${base}/chat/completions`;
  const modelsUrl = `${base}/models`;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const extra = sanitizedExtraHeaders(options.extraHeaders);

  async function* complete(
    request: NormalizedRequest,
  ): AsyncIterable<StreamEvent> {
    const attempt = 1;
    yield { kind: "phase", phase: "queued", attempt } as const;
    if (request.signal.aborted) {
      yield { kind: "phase", phase: "cancelled", attempt } as const;
      yield { kind: "done", attempt, stopReason: "cancelled" } as const;
      return;
    }
    yield { kind: "phase", phase: "sending", attempt } as const;

    // Keyless (LAN) is valid: null/empty simply omits the auth header.
    // The getter result is never logged or echoed into events.
    const apiKey = await options.getApiKey();
    if (request.signal.aborted) {
      yield { kind: "phase", phase: "cancelled", attempt } as const;
      yield { kind: "done", attempt, stopReason: "cancelled" } as const;
      return;
    }
    const authHeader: Record<string, string> =
      apiKey !== null && apiKey !== "" ? { Authorization: `Bearer ${apiKey}` } : {};

    const messages: OutgoingMessage[] = [];
    if (request.summary !== undefined) {
      messages.push({ role: "system", content: request.summary.summaryText });
    }
    for (const turn of request.recentTurns) {
      messages.push({ role: turn.role, content: turn.text });
    }
    if (request.approvedImageIds.length > 0 && options.resolveImageUrl === undefined) {
      yield {
        kind: "error",
        attempt,
        code: "unsupported-images",
        message:
          "This request includes photos but no image resolver is configured; refusing instead of dropping photos.",
        retryable: false,
      } as const;
      yield { kind: "done", attempt, stopReason: "error" } as const;
      return;
    }
    let userContent: OutgoingMessage["content"] = request.currentText;
    if (request.approvedImageIds.length > 0) {
      const parts: OutgoingMessage["content"] = [
        { type: "text", text: request.currentText },
      ];
      for (const imageId of request.approvedImageIds) {
        const url = await options.resolveImageUrl!(imageId);
        if (request.signal.aborted) {
          yield { kind: "phase", phase: "cancelled", attempt } as const;
          yield { kind: "done", attempt, stopReason: "cancelled" } as const;
          return;
        }
        if (url === null || url === "") {
          yield {
            kind: "error",
            attempt,
            code: "unresolvable-image",
            message: "An approved photo could not be resolved for upload; not retried.",
            retryable: false,
          } as const;
          yield { kind: "done", attempt, stopReason: "error" } as const;
          return;
        }
        (parts as Array<{ type: "image_url"; image_url: { url: string } }>).push({
          type: "image_url",
          image_url: { url },
        });
      }
      userContent = parts;
    }
    messages.push({ role: "user", content: userContent });

    const maxOutputTokens = positiveInt(request.maxOutputTokens);
    const headers: Record<string, string> = {
      ...extra,
      ...authHeader,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    };

    let res: Response;
    try {
      res = await fetchImpl(completionsUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: request.selection.modelId,
          messages,
          ...(maxOutputTokens === undefined ? {} : { max_tokens: maxOutputTokens }),
          stream: true,
        }),
        signal: request.signal,
      });
    } catch (error) {
      if (request.signal.aborted) {
        yield { kind: "phase", phase: "cancelled", attempt } as const;
        yield { kind: "done", attempt, stopReason: "cancelled" } as const;
        return;
      }
      yield {
        kind: "error",
        attempt,
        code: "network-error",
        message: error instanceof Error ? truncate(error.message, ERROR_MESSAGE_MAX_CHARS) : "Network failure.",
        retryable: true,
      } as const;
      yield { kind: "done", attempt, stopReason: "error" } as const;
      return;
    }

    if (!res.ok) {
      let body: unknown = null;
      try {
        body = await readJsonBounded(res);
      } catch {
        body = null;
      }
      const mapped = errorForStatus(res.status, body);
      yield { kind: "error", attempt, ...mapped } as const;
      yield { kind: "done", attempt, stopReason: "error" } as const;
      return;
    }

    const reader = res.body?.getReader();
    if (reader === undefined) {
      yield {
        kind: "error",
        attempt,
        code: "stream-error",
        message: "Custom endpoint returned an empty stream body.",
        retryable: true,
      } as const;
      yield { kind: "done", attempt, stopReason: "error" } as const;
      return;
    }

    const decoder = new TextDecoder();
    let buffer = "";
    const dataLines: string[] = [];
    let firstTokenSent = false;
    let failed = false;

    const handlePayload = function* (payload: string): Generator<StreamEvent> {
      if (payload === "[DONE]") return;
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(payload);
      } catch {
        return; // Ignore malformed lines, per OpenAI-compatible samples.
      }
      if (typeof parsed !== "object" || parsed === null) return;
      const chunk = parsed as Record<string, unknown>;
      const errorField = chunk["error"];
      if (errorField !== undefined) {
        const message =
          typeof errorField === "object" &&
          errorField !== null &&
          typeof (errorField as { message?: unknown }).message === "string"
            ? truncate((errorField as { message: string }).message, ERROR_MESSAGE_MAX_CHARS)
            : "Custom endpoint reported a mid-stream error.";
        yield { kind: "error", attempt, code: "stream-error", message, retryable: false } as const;
        return;
      }
      const choices = chunk["choices"];
      const first = Array.isArray(choices) ? choices[0] : undefined;
      const delta =
        typeof first === "object" && first !== null
          ? ((first as { delta?: unknown }).delta as { content?: unknown } | undefined)
          : undefined;
      const content = delta?.content;
      if (typeof content === "string" && content !== "") {
        if (!firstTokenSent) {
          firstTokenSent = true;
          yield { kind: "phase", phase: "first-token", attempt } as const;
        }
        yield { kind: "text", attempt, delta: content } as const;
      }
      const usage = chunk["usage"];
      if (typeof usage === "object" && usage !== null) {
        const usageRecord = usage as Record<string, unknown>;
        const inputTokens = positiveInt(usageRecord["prompt_tokens"]);
        const outputTokens = positiveInt(usageRecord["completion_tokens"]);
        if (inputTokens !== undefined || outputTokens !== undefined) {
          yield {
            kind: "usage",
            attempt,
            ...(inputTokens === undefined ? {} : { inputTokens }),
            ...(outputTokens === undefined ? {} : { outputTokens }),
          } as const;
        }
      }
      const finishReason =
        typeof first === "object" && first !== null
          ? (first as { finish_reason?: unknown }).finish_reason
          : undefined;
      if (finishReason === "error") {
        yield {
          kind: "error",
          attempt,
          code: "stream-error",
          message: "Custom endpoint ended the stream with an error.",
          retryable: false,
        } as const;
      }
    };

    // SSE framing: handle each `data:` line as an independent JSON payload,
    // while tolerating spec-style streams that split one JSON object across
    // several `data:` lines of a single event (blank-line separated). A new
    // `data:` line flushes already-complete pending JSON first; blank lines /
    // EOF flush whatever is pending, falling back to per-line dispatch.
    const tryParseObject = (payload: string): Record<string, unknown> | undefined => {
      try {
        const parsed: unknown = JSON.parse(payload);
        if (typeof parsed === "object" && parsed !== null)
          return parsed as Record<string, unknown>;
      } catch {
        // Not complete JSON yet; may be a partial multi-line event.
      }
      return undefined;
    };

    const dispatchLines = function* (lines: string[]): Generator<StreamEvent> {
      for (const line of lines) {
        if (line === "") {
          if (dataLines.length > 0) {
            const pending = dataLines.splice(0, dataLines.length);
            const joined = pending.join("\n");
            if (joined === "[DONE]" || tryParseObject(joined) !== undefined) {
              yield* handlePayload(joined);
            } else {
              for (const single of pending) yield* handlePayload(single);
            }
          }
          continue;
        }
        if (line.startsWith(":")) continue; // SSE keepalive comment.
        if (line.startsWith("data:")) {
          const value = line.slice("data:".length);
          const stripped = value.startsWith(" ") ? value.slice(1) : value;
          if (dataLines.length > 0) {
            const joined = dataLines.join("\n");
            if (joined === "[DONE]" || tryParseObject(joined) !== undefined) {
              const pending = dataLines.splice(0, dataLines.length);
              yield* handlePayload(pending.join("\n"));
            }
          }
          dataLines.push(stripped);
        }
        // Other SSE fields (event:, id:, retry:) are ignored.
      }
    };

    try {
      for (;;) {
        if (request.signal.aborted) {
          try {
            await reader.cancel();
          } catch {
            // Ignore cancel errors; the caller went away.
          }
          yield { kind: "phase", phase: "cancelled", attempt } as const;
          yield { kind: "done", attempt, stopReason: "cancelled" } as const;
          return;
        }
        const read = await reader.read();
        if (read.done) break;
        buffer += decoder.decode(read.value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const event of dispatchLines(
          lines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line)),
        )) {
          if (event.kind === "error") failed = true;
          yield event;
          if (failed) {
            try {
              await reader.cancel();
            } catch {
              // Ignore: stream already terminal.
            }
            yield { kind: "phase", phase: "failed", attempt } as const;
            yield { kind: "done", attempt, stopReason: "error" } as const;
            return;
          }
        }
        if (request.signal.aborted) {
          try {
            await reader.cancel();
          } catch {
            // Ignore cancel errors; the caller went away.
          }
          yield { kind: "phase", phase: "cancelled", attempt } as const;
          yield { kind: "done", attempt, stopReason: "cancelled" } as const;
          return;
        }
      }
      buffer += decoder.decode();
      // Tolerate a missing trailing blank line / missing [DONE]: flush any
      // pending event and terminate the single attempt normally.
      const tailLines: string[] = [];
      if (buffer !== "") {
        tailLines.push(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
        buffer = "";
      }
      tailLines.push("");
      for (const event of dispatchLines(tailLines)) {
        if (event.kind === "error") failed = true;
        yield event;
        if (failed) {
          yield { kind: "phase", phase: "failed", attempt } as const;
          yield { kind: "done", attempt, stopReason: "error" } as const;
          return;
        }
      }
    } catch (error) {
      if (request.signal.aborted) {
        yield { kind: "phase", phase: "cancelled", attempt } as const;
        yield { kind: "done", attempt, stopReason: "cancelled" } as const;
        return;
      }
      yield {
        kind: "error",
        attempt,
        code: "stream-error",
        message: error instanceof Error ? truncate(error.message, ERROR_MESSAGE_MAX_CHARS) : "Stream read failure.",
        retryable: true,
      } as const;
      yield { kind: "done", attempt, stopReason: "error" } as const;
      return;
    }

    if (failed) {
      yield { kind: "phase", phase: "failed", attempt } as const;
      yield { kind: "done", attempt, stopReason: "error" } as const;
      return;
    }
    // A clean EOF without [DONE] still terminates the single attempt.
    yield { kind: "phase", phase: "complete", attempt } as const;
    yield { kind: "done", attempt, stopReason: "complete" } as const;
  }

  /**
   * Best-effort catalogue: every failure mode (network, non-OK, oversize,
   * malformed) falls back to an empty catalogue. Never throws, never invents
   * pricing or limits — every record stays `unknown` except its id.
   */
  async function listModels(signal?: AbortSignal): Promise<readonly ModelRecord[]> {
    let apiKey: string | null = null;
    try {
      apiKey = await options.getApiKey();
    } catch {
      return [];
    }
    const headers: Record<string, string> = { ...extra, Accept: "application/json" };
    if (apiKey !== null && apiKey !== "") {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }
    let res: Response;
    try {
      res = await fetchImpl(modelsUrl, { headers, signal });
    } catch {
      return [];
    }
    if (!res.ok) return [];
    let body: unknown = null;
    try {
      body = await readJsonBounded(res);
    } catch {
      return [];
    }
    if (typeof body !== "object" || body === null) return [];
    const data = (body as { data?: unknown }).data;
    if (!Array.isArray(data)) return [];
    const retrievedAt = new Date().toISOString();
    const records: ModelRecord[] = [];
    for (const entry of data) {
      if (typeof entry !== "object" || entry === null) continue;
      const id = (entry as Record<string, unknown>)["id"];
      if (typeof id !== "string" || id.trim() === "") continue;
      records.push({
        provider: providerId,
        id,
        // An arbitrary compatible host is not the official provider, even
        // if it returns a familiar ID or advertises qualification fields.
        qualifiedRoles: [],
        input: ["text"],
        output: ["text"],
        // Unknown stays unknown: no pricing or limits are ever invented.
        prices: [],
        priceClass: "unknown",
        retrievedAt,
        entitlement: "untested",
      });
    }
    return records;
  }

  function capabilities(): ProviderCapabilities {
    // Endpoint-selected models vary in vision/context/output support, so only
    // streaming (SSE, OpenAI-compatible) is known.
    return {
      vision: { state: "unknown" },
      maxImagesPerCall: { state: "unknown" },
      contextTokens: { state: "unknown" },
      maxOutputTokens: { state: "unknown" },
      streaming: { state: "known", value: true },
    };
  }

  return { id: providerId, capabilities, listModels, complete };
}
