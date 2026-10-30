import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { ChatController } from "./chatController";
import { ChatStore } from "./chatStore";
import { initMonitoring } from "../monitoring/sentry";
import type { ModelRecord, NormalizedRequest, ProviderAdapter, StreamEvent } from "./providerContract";

const sdk = vi.hoisted(() => {
  const spans: { options: unknown; status?: unknown; ended: boolean }[] = [];
  return { init: vi.fn(), browserTracingIntegration: () => ({ name: "BrowserTracing" }), spans,
    startInactiveSpan: (options: unknown) => {
      const item = { options, ended: false, status: undefined as unknown };
      spans.push(item);
      return { setStatus: (status: unknown) => { item.status = status; }, setAttribute: (key: string, value: unknown) => { ((options as { attributes: Record<string, unknown> }).attributes)[key] = value; }, end: () => { item.ended = true; } };
    },
  };
});
vi.mock("@sentry/capacitor", () => sdk);
vi.mock("@sentry/react", () => ({ init: vi.fn() }));

beforeAll(async () => {
  vi.stubEnv("VITE_SENTRY_DSN", "https://public-test@monitoring.example.test/1");
  initMonitoring();
  await vi.waitFor(() => expect(sdk.init).toHaveBeenCalledOnce());
});
afterAll(() => vi.unstubAllEnvs());

function controller(complete: ProviderAdapter["complete"]) {
  const store = new ChatStore();
  const chatId = store.createChat("private-account", "Private title").id;
  const adapter: ProviderAdapter = { id: "openrouter", capabilities: () => ({
    vision: { state: "unknown" }, maxImagesPerCall: { state: "unknown" }, contextTokens: { state: "known", value: 200_000 },
    maxOutputTokens: { state: "known", value: 4096 }, streaming: { state: "known", value: true },
  }), complete };
  const record: ModelRecord = { provider: "openrouter", id: "openrouter/free", input: ["text"], output: ["text"], contextTokens: 200_000,
    prices: [
      { amountDecimal: "0", currency: "USD", unit: "token", dimension: "input", sourceField: "pricing.prompt" },
      { amountDecimal: "0", currency: "USD", unit: "token", dimension: "output", sourceField: "pricing.completion" },
    ], priceClass: "free", retrievedAt: "2026-10-30T00:00:00.000Z", entitlement: "verified" };
  const instance = new ChatController({ store, adapter, catalog: [record],
    selection: { accountId: "private-account", provider: "openrouter", modelId: "openrouter/free", mode: "free-only" },
    systemPolicy: { version: "p1", text: "Private policy" }, knowledge: { version: "k1", text: "Private knowledge" },
    budget: { verifiedContextWindow: 200_000, reservedOutput: 4096, imageAllowance: 0, protocolOverhead: 1000, safetyMargin: 2000 },
  });
  return { instance, chatId, store };
}

it("covers the actual streaming send lifetime without changing provider input or persisted output", async () => {
  const requests: NormalizedRequest[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { instance, chatId, store } = controller(async function* (request) {
    requests.push(request);
    yield { kind: "text", attempt: 1, delta: "Private answer" };
    await gate;
    yield { kind: "usage", attempt: 1, inputTokens: 30, outputTokens: 12 };
    yield { kind: "done", attempt: 1, stopReason: "complete" };
  });
  const sending = instance.send(chatId, "Private ordinary prompt");
  await vi.waitFor(() => expect(instance.getState().phase).toBe("streaming"));
  expect(sdk.spans).toHaveLength(1);
  expect(sdk.spans[0]?.ended).toBe(false);
  expect(JSON.stringify(requests[0])).toContain("Private ordinary prompt");
  release();
  expect((await sending).answer).toBe("Private answer");
  expect(store.listChats("private-account").find((chat) => chat.id === chatId)?.turns.map((turn) => turn.text)).toEqual(["Private ordinary prompt", "Private answer"]);
  expect(sdk.spans[0]).toMatchObject({ ended: true, status: { code: 1 } });
  expect(sdk.spans[0]?.options).toMatchObject({ attributes: { "gen_ai.usage.input_tokens": 30, "gen_ai.usage.output_tokens": 12 } });
  expect(JSON.stringify(sdk.spans)).not.toContain("Private");
});

it("closes actual failed and cancelled sends without exporting provider error text", async () => {
  sdk.spans.length = 0;
  const failed = controller(async function* (): AsyncIterable<StreamEvent> {
    yield { kind: "error", attempt: 1, code: "provider-failure", message: "Private provider error", retryable: false };
    yield { kind: "done", attempt: 1, stopReason: "error" };
  });
  await expect(failed.instance.send(failed.chatId, "Private prompt")).rejects.toThrow();
  expect(sdk.spans[0]).toMatchObject({ ended: true, status: { code: 2, message: "internal_error" } });
  const abort = new AbortController();
  const cancelled = controller(async function* (): AsyncIterable<StreamEvent> {
    abort.abort();
    yield { kind: "done", attempt: 1, stopReason: "cancelled" };
  });
  await expect(cancelled.instance.send(cancelled.chatId, "Private prompt", { signal: abort.signal })).rejects.toThrow();
  expect(sdk.spans[1]).toMatchObject({ ended: true, status: { code: 2, message: "cancelled" } });
  expect(JSON.stringify(sdk.spans)).not.toContain("Private");
});

it("does not attribute a failed attempt's usage to the successful retry", async () => {
  sdk.spans.length = 0;
  let calls = 0;
  const retry = controller(async function* (): AsyncIterable<StreamEvent> {
    calls += 1;
    if (calls === 1) {
      yield { kind: "usage", attempt: 1, inputTokens: 999, outputTokens: 999 };
      yield { kind: "error", attempt: 1, code: "temporary", message: "retry-after 0", retryable: true };
      yield { kind: "done", attempt: 1, stopReason: "error" };
    } else {
      yield { kind: "text", attempt: 1, delta: "Final reply" };
      yield { kind: "done", attempt: 1, stopReason: "complete" };
    }
  });
  expect((await retry.instance.send(retry.chatId, "Private prompt")).answer).toBe("Final reply");
  expect(calls).toBe(2);
  expect(sdk.spans[0]).toMatchObject({ ended: true, status: { code: 1 } });
  expect(sdk.spans[0]?.options).not.toHaveProperty("attributes.gen_ai.usage.input_tokens");
  expect(JSON.stringify(sdk.spans)).not.toContain("999");
});
