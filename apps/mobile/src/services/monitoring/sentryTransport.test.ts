import { afterEach, expect, it, vi } from "vitest";
import type { Envelope } from "@sentry/core";

const sent = vi.hoisted(() => [] as Envelope[]);
const dropped = vi.hoisted(() => [] as unknown[]);
vi.mock("@sentry/capacitor", async () => {
  const capacitor = await vi.importActual<typeof import("@sentry/capacitor")>("@sentry/capacitor");
  return {
    ...capacitor,
    init: (options: Parameters<typeof capacitor.init>[0], siblingInit: Parameters<typeof capacitor.init>[1]) => capacitor.init({
      ...options,
      tracesSampleRate: 1,
      beforeSendTransaction: (event, hint) => {
        const result = options?.beforeSendTransaction?.(event, hint) ?? null;
        if (!result) dropped.push(event);
        return result;
      },
      transport: () => ({
        send: async (envelope) => { sent.push(envelope); return { statusCode: 200 }; },
        flush: async () => true,
      }),
    }, siblingInit),
  };
});

afterEach(async () => {
  const react = await import("@sentry/react");
  await react.close(1000);
  vi.unstubAllEnvs();
});

it("delivers real SDK cloud and browser transaction envelopes through production privacy hooks", async () => {
  vi.stubEnv("VITE_SENTRY_DSN", "https://0123456789abcdef@monitoring.example.test/1");
  vi.stubEnv("VITE_SENTRY_RELEASE", "findback-mobile@0.11.0-beta.2+ffbbd4f73a7b");
  const { initMonitoring, beginCloudChatSpan } = await import("./sentry");
  initMonitoring();
  const react = await import("@sentry/react");
  await vi.waitFor(() => expect(react.getClient()).toBeDefined());
  const trace = beginCloudChatSpan({ owner: {}, accountId: "private-account", chatId: "private-chat", provider: "openai", modelId: "gpt-4o-mini", signal: new AbortController().signal });
  trace.finish("complete", { inputTokens: 50, outputTokens: 10 });
  const browserSpan = react.startInactiveSpan({ name: "browser-test", op: "navigation", forceTransaction: true, parentSpan: null });
  browserSpan.end();
  react.captureMessage("FindBack telemetry integration test (synthetic)");
  await react.flush(2000);
  expect(dropped).toEqual([]);
  const events = sent.flatMap((envelope) => envelope[1].filter(([header]) => header.type === "transaction").map(([, payload]) => payload as Record<string, unknown>));
  expect(events.map((event) => event["transaction"])).toContain("chat gpt-4o-mini");
  expect(events.map((event) => event["transaction"])).toContain("browser-test");
  const aiEvent = events.find((event) => event["transaction"] === "chat gpt-4o-mini");
  expect(aiEvent).toMatchObject({ contexts: { trace: { op: "gen_ai.chat", data: {
    "gen_ai.provider.name": "openai", "gen_ai.request.model": "gpt-4o-mini", "gen_ai.operation.name": "chat",
    "gen_ai.usage.input_tokens": 50, "gen_ai.usage.output_tokens": 10,
  } } } });
  expect(JSON.stringify(sent)).not.toContain("private-account");
  expect(JSON.stringify(sent)).not.toContain("private-chat");
  expect(sent.some((envelope) => envelope[1].some(([header]) => header.type === "event"))).toBe(true);
});
