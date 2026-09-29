/**
 * ai-relay unit tests (AI-021). Run with `deno test supabase/functions/ai-relay/`.
 * Pure validation/routing only: no network, no secrets, no deploy.
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";
import {
  buildUpstreamBody,
  handleRelayRequest,
  isRelayProvider,
  mapUpstreamFailure,
  parseRelayBody,
  readChatText,
  RelayHttpError,
  resolveRoute,
} from "./index.ts";

Deno.test("relay providers are exactly openai + deepseek", () => {
  assert(isRelayProvider("openai"));
  assert(isRelayProvider("deepseek"));
  assert(!isRelayProvider("other"));
  assert(!isRelayProvider("ai-help"));
});

Deno.test("parseRelayBody accepts a minimal chat request", () => {
  const request = parseRelayBody({
    provider: "openai",
    messages: [{ role: "user", content: "Hello" }],
  });
  assertEquals(request.provider, "openai");
  assertEquals(request.stream, false);
  assertEquals(request.maxTokens, 300);
});

Deno.test("parseRelayBody rejects unknown providers and bad shapes", () => {
  for (const body of [
    { provider: "other", messages: [{ role: "user", content: "hi" }] },
    { provider: "openai", messages: [] },
    { provider: "deepseek", messages: [{ role: "user", content: "" }] },
    { provider: "deepseek", messages: [{ role: "user", content: "x".repeat(4001) }] },
    { provider: "openai", messages: [{ role: "user", content: "x".repeat(5000) }] },
    null,
  ]) {
    let status = 0;
    try {
      parseRelayBody(body);
    } catch (error) {
      assert(error instanceof RelayHttpError);
      status = error.status;
    }
    assert(status === 400 || status === 413, `expected rejection for ${JSON.stringify(body)?.slice(0, 40)}`);
  }
});

Deno.test("resolveRoute reads the secret from server env only", () => {
  const openai = resolveRoute("openai", { AI_RELAY_OPENAI_API_KEY: "s3cret" });
  assertEquals(openai.apiKey, "s3cret");
  assertEquals(openai.baseUrl, "https://api.openai.com/v1");
  assertEquals(openai.model, "gpt-4o-mini");
  const missing = resolveRoute("deepseek", {});
  assertEquals(missing.apiKey, null);
  assertEquals(missing.model, "deepseek-chat");
});

Deno.test("upstream body carries no secret and clamps max tokens", () => {
  const body = buildUpstreamBody(
    parseRelayBody({
      provider: "deepseek",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 99_999,
    }),
    "deepseek-chat",
  );
  assertEquals(body, {
    model: "deepseek-chat",
    messages: [{ role: "user", content: "hi" }],
    stream: false,
    max_tokens: 1024,
  });
  assert(!JSON.stringify(body).toLowerCase().includes("s3cret"));
});

Deno.test("mapUpstreamFailure keeps rate limits distinct, hides the rest", () => {
  assertEquals(mapUpstreamFailure(429), { status: 429, code: "rate_limited" });
  assertEquals(mapUpstreamFailure(500), { status: 502, code: "provider_error" });
});

Deno.test("readChatText clips long answers and rejects empties", () => {
  assertEquals(readChatText({ choices: [{ message: { content: "hi" } }] }), "hi");
  assertEquals(readChatText({ choices: [] }), null);
  const long = readChatText({ choices: [{ message: { content: "y".repeat(9000) } }] });
  assertEquals(long?.length, 6000);
});

Deno.test("handler requires a session and never echoes the secret", async () => {
  const res = await handleRelayRequest(
    new Request("https://relay.test/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "openai", messages: [{ role: "user", content: "hi" }] }),
    }),
    { AI_RELAY_OPENAI_API_KEY: "s3cret" },
  );
  assertEquals(res.status, 401);
  const text = await res.text();
  assert(!text.includes("s3cret"));
  assertStringIncludes(text, "unauthorized");
});

Deno.test("handler answers 503 (no secret echo) when the provider is unconfigured", async () => {
  const originalFetch = globalThis.fetch;
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async () =>
    new Response(JSON.stringify({ id: "user-1" }), { status: 200 })) as typeof fetch;
  try {
    const res = await handleRelayRequest(
      new Request("https://relay.test/", {
        method: "POST",
        headers: { authorization: "Bearer session-jwt", "content-type": "application/json" },
        body: JSON.stringify({ provider: "deepseek", messages: [{ role: "user", content: "hi" }] }),
      }),
      { SUPABASE_URL: "https://project.test", SUPABASE_ANON_KEY: "anon" },
    );
    assertEquals(res.status, 503);
    const body = (await res.json()) as { code?: string };
    assertEquals(body.code, "provider_not_configured");
  } finally {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
  }
});
