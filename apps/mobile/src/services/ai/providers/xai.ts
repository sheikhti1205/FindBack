/**
 * xAI (Grok) BYOK provider adapter (packet AI-020c).
 *
 * Wire shape follows xAI's OpenAI-compatible API:
 * - `POST https://api.x.ai/v1/chat/completions`,
 *   `Authorization: Bearer <key>`.
 * - OpenAI-compatible SSE: `data:` chunks with
 *   `choices[0].delta.content`, `:` keepalive comments, terminator
 *   `data: [DONE]`. Usage is requested via
 *   `stream_options: { include_usage: true }`.
 * - Mid-stream errors arrive as SSE `data:` events with a top-level
 *   `error` field and/or `finish_reason: "error"` (HTTP stays 200).
 * - Model catalogue: `GET https://api.x.ai/v1/models`
 *   (`{object:"list", data:[{id, created, owned_by}]}` — no pricing or
 *   context-window fields, so those stay unknown, never zeroed, and no
 *   pricing is ever invented).
 *
 * No live key is held here: the key arrives per call via the injected
 * `getApiKey` resolver (owned by the credential packet). Without an owner
 * key every live path is NOT TESTED LIVE. Single attempt only — this
 * adapter never performs a paid or cross-provider photo retry on its own,
 * and it never logs prompt or photo content (no console usage at all).
 *
 * NOTE (interface proposal): `providerContract.ts` `ProviderId` is FROZEN
 * and has no `"xai"` member, so `id`/`provider` are cast below. Proposed
 * change: extend the union to
 * `"openrouter" | "openai" | "anthropic" | "google" | "deepseek" | "xai"`.
 */
import type {
  ModelRecord,
  NormalizedRequest,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderId,
  StreamEvent,
} from "../providerContract";

import { cloudCatalogMetadata } from "./catalogueQualification";

/** Sole allowlisted origin for this adapter. No proxy, no override. */
export const XAI_API_ORIGIN = "https://api.x.ai";
export const XAI_COMPLETIONS_URL = `${XAI_API_ORIGIN}/v1/chat/completions`;
export const XAI_MODELS_URL = `${XAI_API_ORIGIN}/v1/models`;

/** Proposed `ProviderId` member (see note above); cast until adopted. */
export const XAI_PROVIDER_ID: ProviderId = "xai";

const ERROR_BODY_MAX_CHARS = 65536;
const ERROR_MESSAGE_MAX_CHARS = 500;

/** The official /models list is flat; guard against pathological payloads. */
const MAX_MODELS = 1000;

export interface XaiAdapterOptions {
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

function positiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    return undefined;
  return Math.floor(value);
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

async function readJsonBounded(res: Response): Promise<unknown> {
  const text = await res.text();
  const trimmed = text.trim();
  if (trimmed === "") return null;
  if (trimmed.length > ERROR_BODY_MAX_CHARS)
    throw new Error("xai-body-too-large");
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
    return { code: "bad-request", message: detail ?? "xAI rejected the request.", retryable: false };
  if (status === 401)
    return { code: "auth-invalid", message: detail ?? "xAI rejected the API key.", retryable: false };
  if (status === 403)
    return { code: "auth-forbidden", message: detail ?? "xAI refused the request for this key.", retryable: false };
  if (status === 404)
    return { code: "not-found", message: detail ?? "xAI model or route not found.", retryable: false };
  if (status === 429)
    return { code: "rate-limited", message: detail ?? "xAI rate limit hit.", retryable: true };
  if (status >= 500)
    return { code: "provider-error", message: detail ?? `xAI upstream failure (HTTP ${status}).`, retryable: true };
  return { code: "request-failed", message: detail ?? `xAI request failed (HTTP ${status}).`, retryable: false };
}

function modelRecordFor(entry: unknown, retrievedAt: string): ModelRecord | null {
  if (typeof entry !== "object" || entry === null) return null;
  const record = entry as Record<string, unknown>;
  if (typeof record["id"] !== "string" || record["id"].trim() === "") return null;
  // The xAI /models envelope carries no pricing, modality, or
  // context-window fields: unknown stays unknown, never zeroed, and no
  // pricing is ever invented.
  return {
    provider: XAI_PROVIDER_ID,
    id: record["id"],
    ...cloudCatalogMetadata("xai", record["id"]),
    input: ["text"],
    output: ["text"],
    prices: [],
    priceClass: "unknown",
    retrievedAt,
    entitlement: "untested",
  };
}

export function createXaiAdapter(options: XaiAdapterOptions): ProviderAdapter {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);

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

    const apiKey = await options.getApiKey();
    if (request.signal.aborted) {
      yield { kind: "phase", phase: "cancelled", attempt } as const;
      yield { kind: "done", attempt, stopReason: "cancelled" } as const;
      return;
    }
    if (apiKey === null || apiKey === "") {
      yield {
        kind: "error",
        attempt,
        code: "auth-missing",
        message: "No xAI API key is configured for this account.",
        retryable: false,
      } as const;
      yield { kind: "done", attempt, stopReason: "error" } as const;
      return;
    }

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
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    };

    let res: Response;
    try {
      res = await fetchImpl(XAI_COMPLETIONS_URL, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: request.selection.modelId,
          messages,
          ...(maxOutputTokens === undefined ? {} : { max_tokens: maxOutputTokens }),
          stream: true,
          stream_options: { include_usage: true },
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
        message: "xAI returned an empty stream body.",
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
            : "xAI reported a mid-stream error.";
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
          message: "xAI ended the stream with an error.",
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

  async function listModels(signal?: AbortSignal): Promise<readonly ModelRecord[]> {
    const apiKey = await options.getApiKey();
    const headers: Record<string, string> = { Accept: "application/json" };
    if (apiKey !== null && apiKey !== "") {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }
    const res = await fetchImpl(XAI_MODELS_URL, { headers, signal });
    if (!res.ok) {
      throw new Error(`xai-models-http-${res.status}`);
    }
    let body: unknown = null;
    try {
      body = await readJsonBounded(res);
    } catch {
      throw new Error("xai-models-invalid");
    }
    if (typeof body !== "object" || body === null || !Array.isArray((body as { data?: unknown }).data)) {
      throw new Error("xai-models-invalid");
    }
    const retrievedAt = new Date().toISOString();
    const records: ModelRecord[] = [];
    for (const entry of (body as { data: unknown[] }).data) {
      if (records.length >= MAX_MODELS) break;
      const record = modelRecordFor(entry, retrievedAt);
      if (record !== null) records.push(record);
    }
    return records;
  }

  function capabilities(): ProviderCapabilities {
    // xAI serves Grok models with varying vision/context support and the
    // /models envelope carries no capability fields, so only streaming
    // (SSE for chat completions) is known.
    return {
      vision: { state: "unknown" },
      maxImagesPerCall: { state: "unknown" },
      contextTokens: { state: "unknown" },
      maxOutputTokens: { state: "unknown" },
      streaming: { state: "known", value: true },
    };
  }

  return { id: XAI_PROVIDER_ID, capabilities, listModels, complete };
}
