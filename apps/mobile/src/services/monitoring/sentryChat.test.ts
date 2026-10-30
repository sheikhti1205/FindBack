import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => {
  const spans: { options: Record<string, unknown>; statuses: unknown[]; ended: number }[] = [];
  return {
    spans,
    init: vi.fn(),
    browserTracingIntegration: () => ({ name: "BrowserTracing" }),
    startInactiveSpan: vi.fn((options: Record<string, unknown>) => {
      const item = { options, statuses: [] as unknown[], ended: 0 };
      spans.push(item);
      return { setStatus: (status: unknown) => item.statuses.push(status), setAttribute: (key: string, value: unknown) => { (options["attributes"] as Record<string, unknown>)[key] = value; }, end: () => { item.ended += 1; } };
    }),
  };
});
vi.mock("@sentry/capacitor", () => sdk);
vi.mock("@sentry/react", () => ({ init: vi.fn() }));

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("VITE_SENTRY_DSN", "https://public-test@monitoring.example.test/1");
  sdk.spans.length = 0;
  sdk.init.mockClear();
});
afterEach(() => vi.unstubAllEnvs());

async function ready() {
  const monitoring = await import("./sentry");
  monitoring.initMonitoring();
  await vi.waitFor(() => expect(sdk.init).toHaveBeenCalledOnce());
  return monitoring;
}

describe("cloud chat monitoring lifetime and privacy", () => {
  it("groups multiple turns without transmitting account/chat IDs and separates accounts and owners", async () => {
    const { beginCloudChatSpan } = await ready();
    const owner = {};
    const options = { owner, accountId: "private-account", chatId: "private-chat", provider: "openrouter", modelId: "openai/gpt-4o-mini", signal: new AbortController().signal };
    beginCloudChatSpan(options).finish("complete");
    beginCloudChatSpan(options).finish("complete");
    beginCloudChatSpan({ ...options, accountId: "other-private-account" }).finish("complete");
    beginCloudChatSpan({ ...options, chatId: "other-private-chat" }).finish("complete");
    beginCloudChatSpan({ ...options, owner: {} }).finish("complete");
    const ids = sdk.spans.map((s) => (s.options["attributes"] as Record<string, unknown>)["gen_ai.conversation.id"]);
    expect(ids[0]).toMatch(/^fbai-[0-9a-f-]{36}$/);
    expect(ids[1]).toBe(ids[0]);
    expect(new Set([ids[0], ...ids.slice(2)]).size).toBe(4);
    expect(JSON.stringify(sdk.spans)).not.toContain("private-account");
    expect(JSON.stringify(sdk.spans)).not.toContain("private-chat");
    expect(sdk.spans[0]?.options).toMatchObject({ op: "gen_ai.chat", name: "chat openai/gpt-4o-mini", attributes: {
      "gen_ai.operation.name": "chat", "gen_ai.provider.name": "openrouter", "gen_ai.request.model": "openai/gpt-4o-mini", "gen_ai.response.streaming": true,
    } });
  });

  it("ends once, immediately on abort, and never captures a raw error", async () => {
    const { beginCloudChatSpan } = await ready();
    const abort = new AbortController();
    const options = { owner: {}, accountId: "a", chatId: "c", provider: "openai", modelId: "gpt-4o-mini", signal: abort.signal };
    const trace = beginCloudChatSpan(options);
    expect(sdk.spans[0]?.ended).toBe(0);
    abort.abort();
    expect(sdk.spans[0]?.ended).toBe(1);
    trace.finish("error");
    expect(sdk.spans[0]?.ended).toBe(1);
    expect(sdk.spans[0]?.statuses).toEqual([{ code: 2, message: "cancelled" }]);
    beginCloudChatSpan({ ...options, signal: new AbortController().signal }).finish("error");
    expect(sdk.spans[1]?.statuses).toEqual([{ code: 2, message: "internal_error" }]);
  });

  it("exports only provider-reported valid token counts, never estimates or malformed usage", async () => {
    const { beginCloudChatSpan, sanitizeSentryEvent } = await ready();
    const options = { owner: {}, accountId: "a", chatId: "c", provider: "openai", modelId: "gpt-4o-mini", signal: new AbortController().signal };
    beginCloudChatSpan(options).finish("complete", { inputTokens: 123, outputTokens: 27 });
    const data = sdk.spans[0]?.options["attributes"];
    expect(data).toMatchObject({ "gen_ai.usage.input_tokens": 123, "gen_ai.usage.output_tokens": 27 });
    expect(sanitizeSentryEvent({ contexts: { trace: { data } } })).toMatchObject({ contexts: { trace: { data: { "gen_ai.usage.input_tokens": 123, "gen_ai.usage.output_tokens": 27 } } } });
    beginCloudChatSpan(options).finish("complete", { inputTokens: NaN, outputTokens: -1 });
    expect(sdk.spans[1]?.options["attributes"]).not.toHaveProperty("gen_ai.usage.input_tokens");
    expect(sdk.spans[1]?.options["attributes"]).not.toHaveProperty("gen_ai.usage.output_tokens");
  });

  it("stays inert without a DSN, for offline or invalid metadata, and when the SDK throws", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", "");
    const monitoring = await import("./sentry");
    monitoring.initMonitoring();
    const options = { owner: {}, accountId: "a", chatId: "c", provider: "openai", modelId: "gpt-4o-mini", signal: new AbortController().signal };
    monitoring.beginCloudChatSpan(options).finish("complete");
    expect(sdk.spans).toHaveLength(0);
    vi.resetModules();
    vi.stubEnv("VITE_SENTRY_DSN", "https://public-test@monitoring.example.test/1");
    const { beginCloudChatSpan } = await ready();
    beginCloudChatSpan({ ...options, provider: "offline" }).finish("complete");
    beginCloudChatSpan({ ...options, modelId: "private@example.test" }).finish("complete");
    expect(sdk.spans).toHaveLength(0);
    sdk.startInactiveSpan.mockImplementationOnce(() => { throw new Error("SDK unavailable"); });
    expect(() => beginCloudChatSpan(options).finish("error")).not.toThrow();
  });
});
