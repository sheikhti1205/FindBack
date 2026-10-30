import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  init: vi.fn(),
  browserTracingIntegration: vi.fn(() => ({ name: "BrowserTracing" })),
}));
vi.mock("@sentry/capacitor", () => sdk);
vi.mock("@sentry/react", () => ({ init: vi.fn() }));

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("VITE_SENTRY_DSN", "https://public-test@monitoring.example.test/1");
  sdk.init.mockClear();
  sdk.browserTracingIntegration.mockClear();
});
afterEach(() => vi.unstubAllEnvs());

describe("real monitoring init", () => {
  it("installs browser tracing once through the existing Capacitor/React init owner", async () => {
    const { initMonitoring } = await import("./sentry");
    initMonitoring();
    initMonitoring();
    await vi.waitFor(() => expect(sdk.init).toHaveBeenCalledOnce());
    expect(sdk.browserTracingIntegration).toHaveBeenCalledOnce();
    expect(sdk.init.mock.calls[0]?.[0]).toMatchObject({
      integrations: [{ name: "BrowserTracing" }],
      sendDefaultPii: false,
      replaysSessionSampleRate: 0,
      replaysOnErrorSampleRate: 0,
    });
  });

  it("keeps valid SDK identifiers while scrubbing AI payloads on root and child spans", async () => {
    const { sanitizeSentryEvent } = await import("./sentry");
    const metadata = {
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "openrouter",
      "gen_ai.request.model": "openai/gpt-4o-mini",
      "gen_ai.conversation.id": "fbai-12345678-1234-4234-8234-123456789abc",
      "gen_ai.input.messages": "a private ordinary sentence",
      "gen_ai.output.messages": "a private answer without secret patterns",
      "gen_ai.system_instructions": "private policy",
      "gen_ai.tool.call.arguments": "private tool input",
    };
    const event = {
      event_id: "11111111111111111111111111111111",
      type: "transaction",
      transaction: "chat openai/gpt-4o-mini",
      contexts: { trace: { trace_id: "22222222222222222222222222222222", span_id: "3333333333333333", op: "gen_ai.chat", data: metadata } },
      spans: [{ trace_id: "22222222222222222222222222222222", span_id: "4444444444444444", parent_span_id: "3333333333333333", op: "gen_ai.chat", data: metadata }],
      extra: { token: "55555555555555555555555555555555" },
    };
    const clean = sanitizeSentryEvent(event);
    expect(clean).not.toBeNull();
    expect(clean).toMatchObject({
      event_id: event.event_id,
      contexts: { trace: { trace_id: "22222222222222222222222222222222", span_id: "3333333333333333", data: {
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": "openrouter",
        "gen_ai.request.model": "openai/gpt-4o-mini",
        "gen_ai.conversation.id": "fbai-12345678-1234-4234-8234-123456789abc",
      } } },
      spans: [{ trace_id: "22222222222222222222222222222222", parent_span_id: "3333333333333333" }],
    });
    const encoded = JSON.stringify(clean);
    for (const privateText of ["private ordinary", "private answer", "private policy", "private tool", "55555555555555555555555555555555"]) {
      expect(encoded).not.toContain(privateText);
    }
    expect(event.contexts.trace.data).toEqual(metadata); // Never mutate SDK input.
  });

  it("does not let SDK ID exceptions exempt unknown fields or raw chat IDs", async () => {
    const { sanitizeSentryEvent } = await import("./sentry");
    expect(sanitizeSentryEvent({ event_id: "11111111111111111111111111111111", unexpected: "22222222222222222222222222222222" })).toBeNull();
    const clean = sanitizeSentryEvent({ type: "transaction", contexts: { trace: { data: {
      "gen_ai.conversation.id": "chat-account-private",
      "gen_ai.request.model": "private@example.test",
      "gen_ai.usage.input_tokens": "private token string",
    } } } });
    expect(JSON.stringify(clean)).not.toContain("chat-account-private");
    expect(JSON.stringify(clean)).not.toContain("private@example.test");
    expect(JSON.stringify(clean)).not.toContain("private token string");
  });

  it("does not mistake a request URL and a separate release field for URL credentials", async () => {
    const { sanitizeSentryEvent } = await import("./sentry");
    expect(sanitizeSentryEvent({ request: { url: "http://127.0.0.1:4197/" }, release: "findback-mobile@0.11.0-beta.2+ffbbd4f73a7b" })).toMatchObject({
      request: { url: "http://127.0.0.1:4197/" }, release: "findback-mobile@0.11.0-beta.2+ffbbd4f73a7b",
    });
    expect(sanitizeSentryEvent({ unexpected: "https://user:pass@host.example/" })).toBeNull();
    expect(sanitizeSentryEvent({ unexpected: "https://host.example/?private=value" })).toBeNull();
  });
});
