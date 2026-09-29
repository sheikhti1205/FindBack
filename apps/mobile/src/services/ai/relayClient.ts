/**
 * AI-021 secure relay caller (mobile side).
 *
 * OpenAI and DeepSeek stay blocked for on-device keys (see
 * `providers/openai.ts` and `providers/deepseek.ts` `DIRECT_KEY_POLICY`):
 * the adapters are untouched and no key material may ever travel with a
 * relay request. The provider secret lives only in the server function's
 * environment; this module sends `{ provider, messages }` over the
 * signed-in Supabase session (the session token authenticates the call)
 * and supports caller abort via `AbortSignal`.
 *
 * Bounds mirror the server relay (`supabase/functions/ai-relay/`):
 * at most 20 messages, 4_000 chars per message, 16_000 chars total.
 * Error messages are generic on purpose: they never echo message content.
 */

import { getSupabase } from "../supabaseClient";

/** The single approved server-key route for OpenAI + DeepSeek traffic. */
export const RELAY_FUNCTION_NAME = "ai-relay" as const;

/** Providers the relay serves. Anything else is rejected before any I/O. */
export const RELAY_PROVIDERS = ["openai", "deepseek"] as const;

export type RelayProvider = (typeof RELAY_PROVIDERS)[number];

export type RelayRole = "user" | "assistant" | "system";

export interface RelayMessage {
  readonly role: RelayRole;
  readonly content: string;
}

export interface RelayChatInput {
  readonly provider: RelayProvider;
  readonly messages: readonly RelayMessage[];
  readonly signal?: AbortSignal;
}

export interface RelayChatResult {
  readonly text: string;
  readonly provider: RelayProvider;
  readonly model?: string;
}

export type RelayErrorCode =
  | "request_invalid"
  | "request_cancelled"
  | "relay_unauthorized"
  | "relay_forbidden"
  | "rate_limited"
  | "request_timeout"
  | "network_error"
  | "provider_error"
  | "response_malformed";

export class RelayError extends Error {
  readonly code: RelayErrorCode;

  constructor(code: RelayErrorCode, message: string) {
    super(message);
    this.name = "RelayError";
    this.code = code;
  }
}

/**
 * Minimal invoke surface (shaped like `supabase.functions.invoke`).
 * Injected in tests so no network is touched; the default below wires the
 * live session client.
 */
export type RelayInvokeFn = (
  fn: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<{ data?: unknown; error?: unknown }>;

/** Client-side request bounds (kept at or under the server's limits). */
export const RELAY_MAX_MESSAGES = 20;
export const RELAY_MAX_MESSAGE_CHARS = 4_000;
export const RELAY_MAX_TOTAL_CHARS = 16_000;
const RELAY_MAX_RESPONSE_CHARS = 6_000;

const RELAY_ROLES: ReadonlySet<string> = new Set(["user", "assistant", "system"]);

function isRelayProvider(value: unknown): value is RelayProvider {
  return value === "openai" || value === "deepseek";
}

function invalid(message: string): RelayError {
  return new RelayError("request_invalid", message);
}

function sanitizeMessages(messages: readonly RelayMessage[]): Array<{ role: RelayRole; content: string }> {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw invalid("Provide at least one message.");
  }
  if (messages.length > RELAY_MAX_MESSAGES) {
    throw invalid(`Provide at most ${RELAY_MAX_MESSAGES} messages.`);
  }
  let total = 0;
  const clean: Array<{ role: RelayRole; content: string }> = [];
  for (const message of messages) {
    if (typeof message !== "object" || message === null) throw invalid("Each message needs a role and text.");
    const { role, content } = message as { role?: unknown; content?: unknown };
    if (typeof role !== "string" || !RELAY_ROLES.has(role)) {
      throw invalid("Each message needs a supported role.");
    }
    if (typeof content !== "string" || content.trim().length === 0) {
      throw invalid("Each message needs non-empty text.");
    }
    if (content.length > RELAY_MAX_MESSAGE_CHARS) {
      throw invalid(`Each message must stay under ${RELAY_MAX_MESSAGE_CHARS} characters.`);
    }
    total += content.length;
    if (total > RELAY_MAX_TOTAL_CHARS) {
      throw invalid(`Messages must stay under ${RELAY_MAX_TOTAL_CHARS} characters in total.`);
    }
    clean.push({ role: role as RelayRole, content });
  }
  return clean;
}

function errorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const direct = (error as { status?: unknown }).status;
  if (typeof direct === "number") return direct;
  const context = (error as { context?: unknown }).context;
  if (typeof context === "object" && context !== null) {
    const nested = (context as { status?: unknown }).status;
    if (typeof nested === "number") return nested;
  }
  return undefined;
}

function mapInvokeError(error: unknown): RelayError {
  const status = errorStatus(error);
  if (status === 400) return new RelayError("request_invalid", "The relay rejected the request.");
  if (status === 401) return new RelayError("relay_unauthorized", "Sign in again to use the relay.");
  if (status === 403) return new RelayError("relay_forbidden", "This account may not use the relay.");
  if (status === 408) return new RelayError("request_timeout", "The relay took too long. Try again.");
  if (status === 429) return new RelayError("rate_limited", "The relay is busy. Try again shortly.");
  return new RelayError("provider_error", "The relay is unavailable right now. Try again later.");
}

function readResult(data: unknown, provider: RelayProvider): RelayChatResult {
  if (typeof data !== "object" || data === null) {
    throw new RelayError("response_malformed", "The relay returned an unreadable reply.");
  }
  const { text, model } = data as { text?: unknown; model?: unknown };
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new RelayError("response_malformed", "The relay returned an unreadable reply.");
  }
  const clipped = text.length > RELAY_MAX_RESPONSE_CHARS ? text.slice(0, RELAY_MAX_RESPONSE_CHARS) : text;
  if (typeof model === "string" && model.length > 0 && model.length <= 128) {
    return { text: clipped, provider, model };
  }
  return { text: clipped, provider };
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

export interface RelayClient {
  chat(input: RelayChatInput): Promise<RelayChatResult>;
}

async function defaultInvoke(
  fn: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ data?: unknown; error?: unknown }> {
  return getSupabase().functions.invoke(fn, { body, ...(signal ? { signal } : {}) });
}

export function createRelayClient(deps: { invoke?: RelayInvokeFn } = {}): RelayClient {
  const invoke = deps.invoke ?? defaultInvoke;
  return {
    async chat(input: RelayChatInput): Promise<RelayChatResult> {
      if (typeof input !== "object" || input === null || !isRelayProvider(input.provider)) {
        throw invalid("Use a supported relay provider.");
      }
      if (input.signal?.aborted) {
        throw new RelayError("request_cancelled", "The relay request was cancelled.");
      }
      // Fresh `{ role, content }` copies only: no key material, no model
      // override, and no caller extras ever leave the device.
      const messages = sanitizeMessages(input.messages);
      const body: Record<string, unknown> = { provider: input.provider, messages };
      let outcome: { data?: unknown; error?: unknown };
      try {
        outcome = await invoke(RELAY_FUNCTION_NAME, body, input.signal);
      } catch (error) {
        if (isAbort(error, input.signal)) {
          throw new RelayError("request_cancelled", "The relay request was cancelled.");
        }
        throw new RelayError("network_error", "Cannot reach the relay. Check your connection.");
      }
      if (input.signal?.aborted) {
        throw new RelayError("request_cancelled", "The relay request was cancelled.");
      }
      if (outcome.error !== null && outcome.error !== undefined) {
        throw mapInvokeError(outcome.error);
      }
      return readResult(outcome.data, input.provider);
    },
  };
}

/** Live client: session-authenticated invoke, no key material held here. */
export const relayClient: RelayClient = createRelayClient();
