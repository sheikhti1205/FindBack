/**
 * Cohere BYOK provider adapter (packet AI-020d).
 *
 * Wire shape follows Cohere's OpenAI-compatible Chat API v2:
 * - `POST https://api.cohere.com/v2/chat`,
 *   `Authorization: Bearer <key>`.
 * - OpenAI-compatible SSE: `data:` chunks with
 *   `choices[0].delta.content`, `:` keepalive comments, terminator
 *   `data: [DONE]`. Usage is requested via
 *   `stream_options: { include_usage: true }` and arrives as
 *   `prompt_tokens` / `completion_tokens`.
 * - Mid-stream errors arrive as SSE `data:` events with a top-level
 *   `error` field and/or `finish_reason: "error"` (HTTP stays 200).
 *
 * Honesty notes:
 * - `listModels` is intentionally NOT implemented: the documented shape of
 *   `GET https://api.cohere.com/v2/models` was not verified to the level
 *   needed to map `ModelRecord` fields, so no catalogue (and no pricing —
 *   never invented) is advertised here.
 * - Vision support varies by Cohere model and was not verified per model,
 *   so `vision` / `maxImagesPerCall` stay `unknown`. Approved images are
 *   still never silently dropped: without a resolver the call fails loudly
 *   (`unsupported-images`), and with one they travel as OpenAI-compatible
 *   `image_url` parts (`unresolvable-image` when an id cannot be resolved).
 *
 * No live key is held here: the key arrives per call via the injected
 * `getApiKey` resolver (owned by the credential packet). Without an owner
 * key every live path is NOT TESTED LIVE. Single attempt only — this
 * adapter never performs a paid or cross-provider photo retry on its own,
 * and it never logs prompt or photo content (no console usage at all).
 *
 * NOTE (interface proposal): `providerContract.ts` `ProviderId` is FROZEN
 * and has no `"cohere"` member, so `id`/provider comparisons cast below.
 * Proposed change: extend the union to
 * `"openrouter" | "openai" | "anthropic" | "google" | "deepseek" | "cohere"`.
 */
import type {
  NormalizedRequest,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderId,
  StreamEvent,
} from "../providerContract";
import { hasNoInlineImageBytesOrKeys } from "../providerContract";

/** Sole allowlisted origin for this adapter. No proxy, no override. */
export const COHERE_API_ORIGIN = "https://api.cohere.com";
export const COHERE_CHAT_URL = `${COHERE_API_ORIGIN}/v2/chat`;

/** Proposed `ProviderId` member (see note above); cast until adopted. */
export const COHERE_PROVIDER_ID: ProviderId = "cohere";

const ATTEMPT = 1;
const ERROR_BODY_MAX_CHARS = 65536;
const ERROR_MESSAGE_MAX_CHARS = 500;

export interface CohereAdapterOptions {
  /** Resolve the caller's BYOK key; `null` means unauthenticated. Never embedded here. */
  getApiKey: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
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

function* failureEvents(
  code: string,
  message: string,
  retryable: boolean,
): Generator<StreamEvent> {
  yield { kind: "phase", phase: "failed", attempt: ATTEMPT, message: code };
  yield { kind: "error", attempt: ATTEMPT, code, message, retryable };
  yield { kind: "done", attempt: ATTEMPT, stopReason: "error" };
}

function* cancelledEvents(): Generator<StreamEvent> {
  yield { kind: "phase", phase: "cancelled", attempt: ATTEMPT };
  yield { kind: "done", attempt: ATTEMPT, stopReason: "cancelled" };
}

function positiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    return undefined;
  return Math.floor(value);
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/** Never echo the credential, whatever an upstream body contained. */
function scrubKey(text: string, apiKey: string, fallback: string): string {
  if (apiKey !== "" && text.includes(apiKey)) return fallback;
  return text;
}

async function readJsonBounded(res: Response): Promise<unknown> {
  const text = await res.text();
  const trimmed = text.trim();
  if (trimmed === "") return null;
  if (trimmed.length > ERROR_BODY_MAX_CHARS)
    throw new Error("cohere-body-too-large");
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function apiErrorMessage(body: unknown, apiKey: string): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const err = (body as { error?: unknown }).error;
  let raw: string | undefined;
  if (typeof err === "string" && err.trim() !== "")
    raw = truncate(err, ERROR_MESSAGE_MAX_CHARS);
  if (typeof err === "object" && err !== null) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string" && message.trim() !== "")
      raw = truncate(message, ERROR_MESSAGE_MAX_CHARS);
  }
  if (raw === undefined) return undefined;
  return scrubKey(raw, apiKey, "Cohere rejected the request.");
}

function errorForStatus(
  status: number,
  body: unknown,
  apiKey: string,
): { code: string; message: string; retryable: boolean } {
  const detail = apiErrorMessage(body, apiKey);
  if (status === 400)
    return { code: "bad-request", message: detail ?? "Cohere rejected the request.", retryable: false };
  if (status === 401)
    return { code: "auth-invalid", message: detail ?? "Cohere rejected the API key.", retryable: false };
  if (status === 403)
    return { code: "auth-forbidden", message: detail ?? "Cohere refused the request for this key.", retryable: false };
  if (status === 404)
    return { code: "not-found", message: detail ?? "Cohere model or route not found.", retryable: false };
  if (status === 429)
    return { code: "rate-limited", message: detail ?? "Cohere rate limit hit.", retryable: true };
  if (status >= 500)
    return { code: "provider-error", message: detail ?? `Cohere upstream failure (HTTP ${status}).`, retryable: true };
  return { code: "request-failed", message: detail ?? `Cohere request failed (HTTP ${status}).`, retryable: false };
}

export function createCohereAdapter(
  options: CohereAdapterOptions,
): ProviderAdapter {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);

  async function* complete(
    request: NormalizedRequest,
  ): AsyncIterable<StreamEvent> {
    yield { kind: "phase", phase: "queued", attempt: ATTEMPT } as const;
    if (request.signal.aborted) {
      yield* cancelledEvents();
      return;
    }
    if (request.selection.provider !== COHERE_PROVIDER_ID) {
      yield* failureEvents(
        "invalid_provider",
        "request selection is not the cohere provider",
        false,
      );
      return;
    }
    if (!hasNoInlineImageBytesOrKeys(request)) {
      yield* failureEvents(
        "request_not_allowed",
        "request carries inline data or unexpected fields",
        false,
      );
      return;
    }

    let apiKey: string | null = null;
    try {
      apiKey = await options.getApiKey();
    } catch {
      yield* failureEvents(
        "credential_unavailable",
        "the stored credential could not be read",
        false,
      );
      return;
    }
    if (request.signal.aborted) {
      yield* cancelledEvents();
      return;
    }
    if (apiKey === null || apiKey === "") {
      yield* failureEvents(
        "auth-missing",
        "No Cohere API key is configured for this account.",
        false,
      );
      return;
    }

    const messages: OutgoingMessage[] = [];
    if (
      request.summary !== undefined &&
      request.summary.summaryText.trim() !== ""
    ) {
      messages.push({ role: "system", content: request.summary.summaryText });
    }
    for (const turn of request.recentTurns) {
      if (turn.text.trim() === "") continue;
      messages.push({ role: turn.role, content: turn.text });
    }
    if (
      request.approvedImageIds.length > 0 &&
      options.resolveImageUrl === undefined
    ) {
      yield* failureEvents(
        "unsupported-images",
        "This request includes photos but no image resolver is configured; refusing instead of dropping photos.",
        false,
      );
      return;
    }
    let userContent: OutgoingMessage["content"] = request.currentText;
    if (request.approvedImageIds.length > 0) {
      const parts: OutgoingMessage["content"] = [
        { type: "text", text: request.currentText },
      ];
      for (const imageId of request.approvedImageIds) {
        let url: string | null = null;
        try {
          url = await options.resolveImageUrl!(imageId);
        } catch {
          url = null;
        }
        if (request.signal.aborted) {
          yield* cancelledEvents();
          return;
        }
        if (url === null || url === "") {
          yield* failureEvents(
            "unresolvable-image",
            "An approved photo could not be resolved for upload; not retried.",
            false,
          );
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

    const hasContent = messages.some((message) =>
      typeof message.content === "string"
        ? message.content.trim() !== ""
        : message.content.some((part) =>
            part.type === "text" ? part.text.trim() !== "" : true,
          ),
    );
    if (!hasContent) {
      yield* failureEvents(
        "no_messages",
        "request carries no message content",
        false,
      );
      return;
    }

    yield { kind: "phase", phase: "sending", attempt: ATTEMPT } as const;

    const maxOutputTokens = positiveInt(request.maxOutputTokens);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    };

    let res: Response;
    try {
      res = await fetchImpl(COHERE_CHAT_URL, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: request.selection.modelId,
          messages,
          ...(maxOutputTokens === undefined
            ? {}
            : { max_tokens: maxOutputTokens }),
          stream: true,
          stream_options: { include_usage: true },
        }),
        signal: request.signal,
      });
    } catch (error) {
      if (request.signal.aborted) {
        yield* cancelledEvents();
        return;
      }
      const raw =
        error instanceof Error ? truncate(error.message, ERROR_MESSAGE_MAX_CHARS) : "Network failure.";
      yield* failureEvents(
        "network-error",
        scrubKey(raw, apiKey, "Network failure."),
        true,
      );
      return;
    }

    if (!res.ok) {
      let body: unknown = null;
      try {
        body = await readJsonBounded(res);
      } catch {
        body = null;
      }
      const mapped = errorForStatus(res.status, body, apiKey);
      yield* failureEvents(mapped.code, mapped.message, mapped.retryable);
      return;
    }

    const reader = res.body?.getReader();
    if (reader === undefined) {
      yield* failureEvents(
        "stream-error",
        "Cohere returned an empty stream body.",
        true,
      );
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
        let message = "Cohere reported a mid-stream error.";
        if (
          typeof errorField === "object" &&
          errorField !== null &&
          typeof (errorField as { message?: unknown }).message === "string"
        ) {
          message = truncate(
            (errorField as { message: string }).message,
            ERROR_MESSAGE_MAX_CHARS,
          );
        }
        yield {
          kind: "error",
          attempt: ATTEMPT,
          code: "stream-error",
          message: scrubKey(message, apiKey, "Cohere reported a mid-stream error."),
          retryable: false,
        } as const;
        return;
      }
      const choices = chunk["choices"];
      const first = Array.isArray(choices) ? choices[0] : undefined;
      const delta =
        typeof first === "object" && first !== null
          ? ((first as { delta?: unknown }).delta as
              | { content?: unknown }
              | undefined)
          : undefined;
      const content = delta?.content;
      if (typeof content === "string" && content !== "") {
        if (!firstTokenSent) {
          firstTokenSent = true;
          yield { kind: "phase", phase: "first-token", attempt: ATTEMPT } as const;
        }
        yield { kind: "text", attempt: ATTEMPT, delta: content } as const;
      }
      const usage = chunk["usage"];
      if (typeof usage === "object" && usage !== null) {
        const usageRecord = usage as Record<string, unknown>;
        const inputTokens = positiveInt(usageRecord["prompt_tokens"]);
        const outputTokens = positiveInt(usageRecord["completion_tokens"]);
        if (inputTokens !== undefined || outputTokens !== undefined) {
          yield {
            kind: "usage",
            attempt: ATTEMPT,
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
          attempt: ATTEMPT,
          code: "stream-error",
          message: "Cohere ended the stream with an error.",
          retryable: false,
        } as const;
      }
    };

    // SSE framing note: spec-style streams may split one JSON object across
    // several `data:` lines of a single event (blank-line separated), while
    // hand-rolled clients treat each `data:` line as an independent payload
    // (notably `data: [DONE]` often follows the last chunk with no blank
    // line between), so pending lines flush two ways: a new `data:` line
    // flushes already-complete pending JSON first, otherwise it continues
    // the pending event; blank lines / EOF flush whatever is pending,
    // falling back to per-line dispatch when the join does not parse.
    const tryParseObject = (
      payload: string,
    ): Record<string, unknown> | undefined => {
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
          yield* cancelledEvents();
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
            yield { kind: "phase", phase: "failed", attempt: ATTEMPT } as const;
            yield { kind: "done", attempt: ATTEMPT, stopReason: "error" } as const;
            return;
          }
        }
        if (request.signal.aborted) {
          try {
            await reader.cancel();
          } catch {
            // Ignore cancel errors; the caller went away.
          }
          yield* cancelledEvents();
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
          yield { kind: "phase", phase: "failed", attempt: ATTEMPT } as const;
          yield { kind: "done", attempt: ATTEMPT, stopReason: "error" } as const;
          return;
        }
      }
    } catch (error) {
      if (request.signal.aborted) {
        yield* cancelledEvents();
        return;
      }
      const raw =
        error instanceof Error
          ? truncate(error.message, ERROR_MESSAGE_MAX_CHARS)
          : "Stream read failure.";
      yield* failureEvents(
        "stream-error",
        scrubKey(raw, apiKey, "Stream read failure."),
        true,
      );
      return;
    }

    if (failed) {
      yield { kind: "phase", phase: "failed", attempt: ATTEMPT } as const;
      yield { kind: "done", attempt: ATTEMPT, stopReason: "error" } as const;
      return;
    }
    // A clean EOF without [DONE] still terminates the single attempt.
    yield { kind: "phase", phase: "complete", attempt: ATTEMPT } as const;
    yield { kind: "done", attempt: ATTEMPT, stopReason: "complete" } as const;
  }

  function capabilities(): ProviderCapabilities {
    // Model-varying facts (vision, windows, image limits) stay unknown:
    // never zeroed, never a free default. Only SSE streaming is known.
    return {
      vision: { state: "unknown" },
      maxImagesPerCall: { state: "unknown" },
      contextTokens: { state: "unknown" },
      maxOutputTokens: { state: "unknown" },
      streaming: { state: "known", value: true },
    };
  }

  return { id: COHERE_PROVIDER_ID, capabilities, complete };
}
