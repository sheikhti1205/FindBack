/**
 * Incremental server-sent-event parser for provider text streams (packet R1).
 *
 * The parser owns byte framing only: UTF-8 decoding across chunk boundaries,
 * CRLF/LF tolerance, comment and keepalive filtering, multiline `data:`
 * joining, and terminal handling. It never assumes one network chunk carries
 * one event, and it performs no network, credential, or pricing work.
 *
 * Payload semantics follow the OpenAI-compatible streaming shape used by the
 * provider adapters: `choices[0].delta.content` text deltas, `usage` frames,
 * mid-stream `{error}` payloads, and a `[DONE]` terminator. A stream that
 * ends without `[DONE]` still terminates cleanly via {@link SseStreamParser.flush}.
 */
export type ParsedStreamEvent =
  | { readonly type: "text"; readonly delta: string }
  | { readonly type: "usage"; readonly promptTokens?: number; readonly completionTokens?: number }
  | { readonly type: "stream-error"; readonly code: "stream-error"; readonly message: string }
  | { readonly type: "done" };

const DONE_SENTINEL = "[DONE]";
const DATA_PREFIX = "data:";
const ERROR_MESSAGE_MAX = 500;

function positiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function errorMessage(payload: Record<string, unknown>): string {
  const field = payload["error"];
  if (typeof field === "object" && field !== null) {
    const message = (field as { message?: unknown }).message;
    if (typeof message === "string" && message.trim() !== "") {
      return truncate(message, ERROR_MESSAGE_MAX);
    }
  }
  if (typeof field === "string" && field.trim() !== "") {
    return truncate(field, ERROR_MESSAGE_MAX);
  }
  return "Provider reported a mid-stream error.";
}

/** Parse one complete SSE data payload into zero or more content events. */
function parsePayload(payload: string): ParsedStreamEvent[] {
  if (payload === DONE_SENTINEL) return [{ type: "done" }];
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const chunk = parsed as Record<string, unknown>;
  const events: ParsedStreamEvent[] = [];
  if (chunk["error"] !== undefined) {
    events.push({ type: "stream-error", code: "stream-error", message: errorMessage(chunk) });
  }
  const choices = chunk["choices"];
  const first = Array.isArray(choices) ? choices[0] : undefined;
  const delta =
    typeof first === "object" && first !== null
      ? ((first as { delta?: unknown }).delta as { content?: unknown } | undefined)
      : undefined;
  if (typeof delta?.content === "string" && delta.content !== "") {
    events.push({ type: "text", delta: delta.content });
  }
  const usage = chunk["usage"];
  if (typeof usage === "object" && usage !== null) {
    const record = usage as Record<string, unknown>;
    const promptTokens = positiveInt(record["prompt_tokens"]);
    const completionTokens = positiveInt(record["completion_tokens"]);
    if (promptTokens !== undefined || completionTokens !== undefined) {
      events.push({
        type: "usage",
        ...(promptTokens === undefined ? {} : { promptTokens }),
        ...(completionTokens === undefined ? {} : { completionTokens }),
      });
    }
  }
  const finishReason =
    typeof first === "object" && first !== null
      ? (first as { finish_reason?: unknown }).finish_reason
      : undefined;
  if (finishReason === "error" && chunk["error"] === undefined) {
    events.push({
      type: "stream-error",
      code: "stream-error",
      message: "Provider ended the stream with an error.",
    });
  }
  return events;
}

function tryParseObject(payload: string): boolean {
  try {
    const parsed: unknown = JSON.parse(payload);
    return typeof parsed === "object" && parsed !== null;
  } catch {
    return false;
  }
}

export class SseStreamParser {
  private readonly decoder = new TextDecoder();
  private carry = "";
  private pendingData: string[] = [];
  private terminated = false;

  /**
   * Feed one network chunk; returns the content events completed by it.
   * Chunks arriving after the terminal marker are ignored.
   */
  push(chunk: Uint8Array): ParsedStreamEvent[] {
    if (this.terminated) return [];
    return this.consumeText(this.decoder.decode(chunk, { stream: true }));
  }

  /**
   * Signal end of stream. Flushes any pending event and always terminates
   * exactly once, so a missing `[DONE]` cannot hang the consumer.
   */
  flush(): ParsedStreamEvent[] {
    if (this.terminated) return [];
    const events = this.consumeText(this.decoder.decode());
    events.push(...this.flushPending());
    this.terminated = true;
    if (!events.some((event) => event.type === "done")) {
      events.push({ type: "done" });
    }
    return events;
  }

  private consumeText(text: string): ParsedStreamEvent[] {
    this.carry += text;
    const lines = this.carry.split("\n");
    this.carry = lines.pop() ?? "";
    const events: ParsedStreamEvent[] = [];
    for (const raw of lines) {
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      events.push(...this.handleLine(line));
      if (this.terminated) break;
    }
    return events;
  }

  private handleLine(line: string): ParsedStreamEvent[] {
    if (line === "") return this.flushPending();
    if (line.startsWith(":")) return [];
    if (line.startsWith(DATA_PREFIX)) {
      const value = line.slice(DATA_PREFIX.length);
      const stripped = value.startsWith(" ") ? value.slice(1) : value;
      // Dual-flush framing: a new data line completes already-complete
      // pending JSON first, otherwise it continues the pending event.
      if (this.pendingData.length > 0) {
        const joined = this.pendingData.join("\n");
        if (joined === DONE_SENTINEL || tryParseObject(joined)) {
          const pending = this.pendingData.splice(0, this.pendingData.length);
          const flushed = this.dispatchPayload(pending.join("\n"));
          this.pendingData.push(stripped);
          return flushed;
        }
      }
      this.pendingData.push(stripped);
      return [];
    }
    return [];
  }

  private flushPending(): ParsedStreamEvent[] {
    if (this.pendingData.length === 0) return [];
    const pending = this.pendingData.splice(0, this.pendingData.length);
    const joined = pending.join("\n");
    if (joined === DONE_SENTINEL || tryParseObject(joined)) {
      return this.dispatchPayload(joined);
    }
    const events: ParsedStreamEvent[] = [];
    for (const single of pending) events.push(...this.dispatchPayload(single));
    return events;
  }

  private dispatchPayload(payload: string): ParsedStreamEvent[] {
    const events = parsePayload(payload);
    if (events.some((event) => event.type === "done")) this.terminated = true;
    return events;
  }
}
