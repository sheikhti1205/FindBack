/**
 * AI Relay — Supabase Edge Function (AI-021).
 *
 * Authenticated mobile callers reach OpenAI / DeepSeek through this relay
 * because on-device keys for those providers stay blocked (see
 * `apps/mobile/src/services/ai/providers/openai.ts` and `deepseek.ts`
 * `DIRECT_KEY_POLICY`). The provider secret lives ONLY in this function's
 * environment and is never logged, never echoed, and never sent to the
 * caller. The caller sends `{ provider, messages }` over its Supabase
 * session; this function validates, routes per provider, and returns
 * either buffered JSON (`stream: false`) or an SSE passthrough
 * (`stream: true`).
 *
 * Required server environment (set with `supabase secrets set`, never in
 * mobile source):
 * - `SUPABASE_URL`, `SUPABASE_ANON_KEY` — session verification only.
 * - `AI_RELAY_OPENAI_API_KEY` — OpenAI provider secret (required to serve
 *   `provider: "openai"`; when absent that provider answers 503).
 * - `AI_RELAY_DEEPSEEK_API_KEY` — DeepSeek provider secret (same contract).
 *
 * Optional server environment (sane defaults shown):
 * - `AI_RELAY_OPENAI_BASE_URL` (default `https://api.openai.com/v1`)
 * - `AI_RELAY_OPENAI_MODEL` (default `gpt-4o-mini`)
 * - `AI_RELAY_DEEPSEEK_BASE_URL` (default `https://api.deepseek.com`)
 * - `AI_RELAY_DEEPSEEK_MODEL` (default `deepseek-chat`)
 *
 * Deploy (docs only — owner-gated, do NOT run from implementation workers):
 * - `supabase secrets set AI_RELAY_OPENAI_API_KEY=... AI_RELAY_DEEPSEEK_API_KEY=...`
 * - `supabase functions deploy ai-relay`
 *
 * Bounds mirror `ai-help`: at most 20 messages, 4_000 chars per message,
 * 16_000 chars total, 15 s upstream timeout, answers clipped to 6_000 chars.
 */

export const RELAY_PROVIDERS = ["openai", "deepseek"] as const;
export type RelayProvider = (typeof RELAY_PROVIDERS)[number];

export const MAX_MESSAGES = 20;
export const MAX_MESSAGE_CHARS = 4_000;
export const MAX_TOTAL_CHARS = 16_000;
export const MAX_RESPONSE_CHARS = 6_000;
export const UPSTREAM_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_TOKENS = 300;
const MAX_MAX_TOKENS = 1_024;

export interface RelayMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface RelayRequest {
  provider: RelayProvider;
  messages: RelayMessage[];
  stream: boolean;
  maxTokens: number;
}

export interface ProviderRoute {
  baseUrl: string;
  model: string;
  apiKey: string | null;
}

const ROLES: ReadonlySet<string> = new Set(["user", "assistant", "system"]);

export class RelayHttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "RelayHttpError";
    this.status = status;
    this.code = code;
  }
}

export function isRelayProvider(value: unknown): value is RelayProvider {
  return value === "openai" || value === "deepseek";
}

/** Strict body validation — rejects before any secret or network is touched. */
export function parseRelayBody(body: unknown): RelayRequest {
  if (typeof body !== "object" || body === null) {
    throw new RelayHttpError(400, "request_invalid", "A JSON body with provider and messages is required.");
  }
  const { provider, messages, stream, max_tokens } = body as Record<string, unknown>;
  if (!isRelayProvider(provider)) {
    throw new RelayHttpError(400, "request_invalid", "Use a supported relay provider.");
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new RelayHttpError(400, "request_invalid", "Provide at least one message.");
  }
  if (messages.length > MAX_MESSAGES) {
    throw new RelayHttpError(400, "request_invalid", "Too many messages.");
  }
  let total = 0;
  const clean: RelayMessage[] = [];
  for (const message of messages) {
    if (typeof message !== "object" || message === null) {
      throw new RelayHttpError(400, "request_invalid", "Each message needs a role and text.");
    }
    const { role, content } = message as { role?: unknown; content?: unknown };
    if (typeof role !== "string" || !ROLES.has(role)) {
      throw new RelayHttpError(400, "request_invalid", "Each message needs a supported role.");
    }
    if (typeof content !== "string" || content.trim().length === 0) {
      throw new RelayHttpError(400, "request_invalid", "Each message needs non-empty text.");
    }
    if (content.length > MAX_MESSAGE_CHARS) {
      throw new RelayHttpError(413, "request_too_large", "A message is too long.");
    }
    total += content.length;
    if (total > MAX_TOTAL_CHARS) {
      throw new RelayHttpError(413, "request_too_large", "Messages are too long in total.");
    }
    clean.push({ role: role as RelayMessage["role"], content });
  }
  let maxTokens = DEFAULT_MAX_TOKENS;
  if (max_tokens !== undefined) {
    if (typeof max_tokens !== "number" || !Number.isFinite(max_tokens) || max_tokens < 1) {
      throw new RelayHttpError(400, "request_invalid", "max_tokens must be a positive number.");
    }
    maxTokens = Math.min(Math.floor(max_tokens), MAX_MAX_TOKENS);
  }
  return { provider, messages: clean, stream: stream === true, maxTokens };
}

type Env = Record<string, string | undefined>;

/** Per-provider routing. The secret is read here and only here. */
export function resolveRoute(provider: RelayProvider, env: Env): ProviderRoute {
  if (provider === "openai") {
    return {
      baseUrl: (env.AI_RELAY_OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, ""),
      model: env.AI_RELAY_OPENAI_MODEL ?? "gpt-4o-mini",
      apiKey: env.AI_RELAY_OPENAI_API_KEY ?? null,
    };
  }
  return {
    baseUrl: (env.AI_RELAY_DEEPSEEK_BASE_URL ?? "https://api.deepseek.com").replace(/\/$/, ""),
    model: env.AI_RELAY_DEEPSEEK_MODEL ?? "deepseek-chat",
    apiKey: env.AI_RELAY_DEEPSEEK_API_KEY ?? null,
  };
}

export function buildUpstreamBody(request: RelayRequest, model: string): Record<string, unknown> {
  return {
    model,
    messages: request.messages,
    stream: request.stream,
    max_tokens: request.maxTokens,
  };
}

/** Upstream failures map to relay statuses; upstream bodies are never echoed. */
export function mapUpstreamFailure(status: number): { status: number; code: string } {
  if (status === 429) return { status: 429, code: "rate_limited" };
  if (status === 408 || status === 504) return { status: 504, code: "request_timeout" };
  return { status: 502, code: "provider_error" };
}

export function readChatText(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const message = (choices[0] as { message?: unknown })?.message;
  if (typeof message !== "object" || message === null) return null;
  const content = (message as { content?: unknown }).content;
  if (typeof content !== "string" || content.trim().length === 0) return null;
  return content.length > MAX_RESPONSE_CHARS ? content.slice(0, MAX_RESPONSE_CHARS) : content;
}

function jsonResponse(body: Record<string, unknown>, status: number): Response {
  return Response.json(body, {
    status,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization, content-type",
      "access-control-allow-methods": "POST, OPTIONS",
    },
  });
}

function readEnv(): Env {
  return {
    SUPABASE_URL: Deno.env.get("SUPABASE_URL"),
    SUPABASE_ANON_KEY: Deno.env.get("SUPABASE_ANON_KEY"),
    AI_RELAY_OPENAI_API_KEY: Deno.env.get("AI_RELAY_OPENAI_API_KEY"),
    AI_RELAY_DEEPSEEK_API_KEY: Deno.env.get("AI_RELAY_DEEPSEEK_API_KEY"),
    AI_RELAY_OPENAI_BASE_URL: Deno.env.get("AI_RELAY_OPENAI_BASE_URL"),
    AI_RELAY_OPENAI_MODEL: Deno.env.get("AI_RELAY_OPENAI_MODEL"),
    AI_RELAY_DEEPSEEK_BASE_URL: Deno.env.get("AI_RELAY_DEEPSEEK_BASE_URL"),
    AI_RELAY_DEEPSEEK_MODEL: Deno.env.get("AI_RELAY_DEEPSEEK_MODEL"),
  };
}

/** Session verification only — the provider secret is never involved here. */
async function verifySession(req: Request, env: Env): Promise<boolean> {
  const auth = req.headers.get("authorization");
  if (!auth || !auth.toLowerCase().startsWith("bearer ")) return false;
  const url = env.SUPABASE_URL;
  const anonKey = env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) return false;
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/auth/v1/user`, {
      headers: { apikey: anonKey, authorization: auth },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function handleRelayRequest(req: Request, env: Env = readEnv()): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "authorization, content-type",
        "access-control-allow-methods": "POST, OPTIONS",
      },
    });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Use POST.", code: "request_invalid" }, 405);
  }
  if (!(await verifySession(req, env))) {
    return jsonResponse({ error: "Sign in to use the relay.", code: "unauthorized" }, 401);
  }
  let request: RelayRequest;
  try {
    request = parseRelayBody(await req.json());
  } catch (error) {
    if (error instanceof RelayHttpError) {
      return jsonResponse({ error: error.message, code: error.code }, error.status);
    }
    return jsonResponse({ error: "A JSON body with provider and messages is required.", code: "request_invalid" }, 400);
  }
  const route = resolveRoute(request.provider, env);
  if (!route.apiKey) {
    return jsonResponse({ error: "This provider is not configured.", code: "provider_not_configured" }, 503);
  }
  let upstream: Response;
  try {
    upstream = await fetch(`${route.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${route.apiKey}` },
      body: JSON.stringify(buildUpstreamBody(request, route.model)),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    return jsonResponse({ error: "The provider took too long.", code: "request_timeout" }, 504);
  }
  if (!upstream.ok) {
    const mapped = mapUpstreamFailure(upstream.status);
    return jsonResponse({ error: "The provider request failed.", code: mapped.code }, mapped.status);
  }
  if (request.stream) {
    if (!upstream.body) {
      return jsonResponse({ error: "The provider returned no stream.", code: "provider_error" }, 502);
    }
    return new Response(upstream.body, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "access-control-allow-origin": "*",
      },
    });
  }
  let payload: unknown;
  try {
    payload = await upstream.json();
  } catch {
    return jsonResponse({ error: "The provider reply was unreadable.", code: "provider_error" }, 502);
  }
  const text = readChatText(payload);
  if (!text) {
    return jsonResponse({ error: "The provider reply was unreadable.", code: "provider_error" }, 502);
  }
  // The provider secret is never part of any response.
  return jsonResponse({ text, provider: request.provider, model: route.model }, 200);
}

if (import.meta.main) {
  Deno.serve((req) => handleRelayRequest(req));
}
