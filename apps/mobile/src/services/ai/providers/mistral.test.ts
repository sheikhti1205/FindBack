/**
 * Mistral BYOK provider adapter tests (packet AI-020a).
 *
 * Fixtures are hand-built wire captures shaped by the official Mistral La
 * Plateforme docs (OpenAI-compatible `POST /v1/chat/completions` with SSE
 * `data:` chunks, `choices[0].delta.content`, terminator `data: [DONE]`;
 * catalogue `GET /v1/models` -> `{data:[{id,...}]}` with no price fields).
 * No real key is ever used and no live call is made — every live path is
 * NOT TESTED LIVE.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMistralAdapter, MISTRAL_PROVIDER_ID } from "./mistral";
import type { NormalizedRequest, StreamEvent } from "../providerContract";

const COMPLETIONS_URL = "https://api.mistral.ai/v1/chat/completions";
const MODELS_URL = "https://api.mistral.ai/v1/models";

type FetchCall = { url: string; init: RequestInit };

function makeFetchStub(response: Response | Response[]) {
  const calls: FetchCall[] = [];
  const queue = Array.isArray(response) ? [...response] : [response];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = queue.length > 1 ? queue.shift()! : queue[0];
    return next;
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function baseRequest(overrides: Partial<NormalizedRequest> = {}): {
  request: NormalizedRequest;
  controller: AbortController;
} {
  const controller = new AbortController();
  return {
    controller,
    request: {
      selection: {
        accountId: "acct-1",
        provider: MISTRAL_PROVIDER_ID,
        modelId: "mistral-large-latest",
        mode: "free-only",
      },
      task: "app-help",
      policyVersion: "p1",
      knowledgeVersion: "k1",
      recentTurns: [],
      currentText: "Hello",
      approvedImageIds: [],
      authorizedResultIds: [],
      maxOutputTokens: 128,
      signal: controller.signal,
      ...overrides,
    },
  };
}

function streamResponse(byteChunks: Uint8Array[], status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of byteChunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { "content-type": "text/event-stream" },
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const enc = new TextEncoder();

async function collect(
  iterable: AsyncIterable<StreamEvent>,
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function texts(events: StreamEvent[]): string {
  return events
    .filter((e) => e.kind === "text")
    .map((e) => (e.kind === "text" ? e.delta : ""))
    .join("");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("mistral capabilities", () => {
  it("reports streaming known-true and model-varying limits as unknown", () => {
    const adapter = createMistralAdapter({
      getApiKey: async () => "test-key",
    });
    expect(adapter.id).toBe("mistral");
    const caps = adapter.capabilities();
    expect(caps.streaming).toEqual({ state: "known", value: true });
    // Mixed text/vision catalogue: unknown stays unknown, never 0/"free".
    expect(caps.vision).toEqual({ state: "unknown" });
    expect(caps.maxImagesPerCall).toEqual({ state: "unknown" });
    expect(caps.contextTokens).toEqual({ state: "unknown" });
    expect(caps.maxOutputTokens).toEqual({ state: "unknown" });
  });
});

describe("mistral complete — happy path wire format", () => {
  it("parses split UTF-8, keepalives, usage chunk, [DONE]", async () => {
    // "héllo 🌍!" split mid-codepoint across network chunks.
    const full = "h\u00e9llo \u{1F30D}!";
    const helloBytes = enc.encode("h\u00e9llo ");
    const emojiBytes = enc.encode("\u{1F30D}");
    const bangBytes = enc.encode("!");

    const chunkA = (line: string) => enc.encode(line);
    const part1 = concat([
      chunkA(": keep-alive\r\n"),
      chunkA("\r\n"),
      chunkA('data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"role":"assistant","content":"'),
      helloBytes.subarray(0, 3),
    ]);
    const part2 = concat([
      helloBytes.subarray(3),
      emojiBytes.subarray(0, 2),
    ]);
    const part3 = concat([
      emojiBytes.subarray(2),
      chunkA('"}}],"model":"mistral-large-latest"}\r\n'),
      chunkA("\r\n"),
      chunkA('data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"content":"'),
      bangBytes,
      chunkA('"}}]}\r\n'),
      chunkA("\r\n"),
      // Final usage chunk.
      chunkA(
        'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":4,"total_tokens":14}}\r\n',
      ),
      chunkA("data: [DONE]\r\n"),
    ]);

    const { calls, fetchImpl } = makeFetchStub(
      streamResponse([part1, part2, part3]),
    );
    const adapter = createMistralAdapter({
      getApiKey: async () => "test-key",
      fetchImpl,
    });
    const { request } = baseRequest();

    const events = await collect(adapter.complete(request));

    expect(texts(events)).toBe(full);
    const usage = events.find((e) => e.kind === "usage");
    expect(usage).toMatchObject({
      kind: "usage",
      attempt: 1,
      inputTokens: 10,
      outputTokens: 4,
    });
    expect(events[events.length - 1]).toMatchObject({
      kind: "done",
      attempt: 1,
      stopReason: "complete",
    });
    expect(events.some((e) => e.kind === "phase" && e.phase === "first-token")).toBe(true);

    // Wire assertions: endpoint, auth, OpenAI-compatible body.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(COMPLETIONS_URL);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-key");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toMatchObject({
      model: "mistral-large-latest",
      stream: true,
      max_tokens: 128,
      messages: [{ role: "user", content: "Hello" }],
    });
  });

  it("includes recent turns and summary without prompt/photo logging", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { calls, fetchImpl } = makeFetchStub(
      streamResponse([enc.encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n')]),
    );
    const adapter = createMistralAdapter({
      getApiKey: async () => "test-key",
      fetchImpl,
    });
    const { request } = baseRequest({
      summary: {
        schemaVersion: 1,
        coveredThroughTurnId: "t1",
        sourceTurnIds: ["t1"],
        summaryText: "prior summary",
        generatedBy: "local-extractive",
        estimatedTokens: 12,
        updatedAt: "2026-09-25T00:00:00.000Z",
      },
      recentTurns: [
        { id: "t1", role: "user", text: "q", attachmentIds: [], createdAt: "2026-09-25T00:00:00.000Z" },
        { id: "t2", role: "assistant", text: "a", attachmentIds: [], createdAt: "2026-09-25T00:00:01.000Z" },
      ],
      currentText: "follow-up",
    });

    const events = await collect(adapter.complete(request));
    expect(texts(events)).toBe("ok");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.messages).toEqual([
      { role: "system", content: "prior summary" },
      { role: "user", content: "q" },
      { role: "assistant", content: "a" },
      { role: "user", content: "follow-up" },
    ]);
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("ends complete when the stream closes without [DONE]", async () => {
    const { fetchImpl } = makeFetchStub(
      streamResponse([enc.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')]),
    );
    const adapter = createMistralAdapter({
      getApiKey: async () => "test-key",
      fetchImpl,
    });
    const { request } = baseRequest();
    const events = await collect(adapter.complete(request));
    expect(texts(events)).toBe("partial");
    expect(events[events.length - 1]).toMatchObject({
      kind: "done",
      stopReason: "complete",
    });
  });
});

describe("mistral complete — errors", () => {
  it("maps a pre-stream 401 to a non-retryable auth error", async () => {
    const { calls, fetchImpl } = makeFetchStub(
      jsonResponse({ message: "Unauthorized" }, 401),
    );
    const adapter = createMistralAdapter({
      getApiKey: async () => "bad-key",
      fetchImpl,
    });
    const { request } = baseRequest();
    const events = await collect(adapter.complete(request));
    const error = events.find((e) => e.kind === "error");
    expect(error).toMatchObject({ kind: "error", attempt: 1, retryable: false });
    expect((error as { code: string }).code).toMatch(/auth/i);
    expect(events[events.length - 1]).toMatchObject({ kind: "done", stopReason: "error" });
    expect(calls).toHaveLength(1);
  });

  it("maps a pre-stream 429 to a retryable rate-limit error", async () => {
    const { fetchImpl } = makeFetchStub(
      jsonResponse({ message: "Rate limit exceeded" }, 429),
    );
    const adapter = createMistralAdapter({
      getApiKey: async () => "test-key",
      fetchImpl,
    });
    const { request } = baseRequest();
    const events = await collect(adapter.complete(request));
    const error = events.find((e) => e.kind === "error");
    expect(error).toMatchObject({ kind: "error", retryable: true });
    expect((error as { code: string }).code).toMatch(/rate/i);
  });

  it("maps a pre-stream 404 to a non-retryable model-not-found error", async () => {
    const { fetchImpl } = makeFetchStub(
      jsonResponse({ message: "Model not found", code: 2402 }, 404),
    );
    const adapter = createMistralAdapter({
      getApiKey: async () => "test-key",
      fetchImpl,
    });
    const { request } = baseRequest({
      selection: {
        accountId: "acct-1",
        provider: MISTRAL_PROVIDER_ID,
        modelId: "no-such-model",
        mode: "free-only",
      },
    });
    const events = await collect(adapter.complete(request));
    const error = events.find((e) => e.kind === "error");
    expect(error).toMatchObject({ kind: "error", retryable: false });
    expect((error as { code: string }).code).toMatch(/model|not-found/i);
  });

  it("surfaces a mid-stream error event and stops", async () => {
    const { fetchImpl } = makeFetchStub(
      streamResponse([
        enc.encode('data: {"choices":[{"delta":{"content":"hel"}}]}\n\n'),
        enc.encode(
          'data: {"id":"cmpl-1","error":{"type":"api_error","message":"upstream failure"},"choices":[{"index":0,"delta":{},"finish_reason":"error"}]}\n\n',
        ),
        enc.encode('data: {"choices":[{"delta":{"content":"LATE"}}]}\n\ndata: [DONE]\n\n'),
      ]),
    );
    const adapter = createMistralAdapter({
      getApiKey: async () => "test-key",
      fetchImpl,
    });
    const { request } = baseRequest();
    const events = await collect(adapter.complete(request));
    expect(texts(events)).toBe("hel");
    const error = events.find((e) => e.kind === "error");
    expect(error).toMatchObject({ kind: "error", retryable: false });
    expect(events[events.length - 1]).toMatchObject({ kind: "done", stopReason: "error" });
  });

  it("emits auth-missing without calling fetch when no key resolves", async () => {
    const { calls, fetchImpl } = makeFetchStub(
      streamResponse([enc.encode("data: [DONE]\n\n")]),
    );
    const adapter = createMistralAdapter({
      getApiKey: async () => null,
      fetchImpl,
    });
    const { request } = baseRequest();
    const events = await collect(adapter.complete(request));
    expect(calls).toHaveLength(0);
    expect(events.find((e) => e.kind === "error")).toMatchObject({
      kind: "error",
      retryable: false,
    });
  });
});

describe("mistral complete — abort", () => {
  it("cancels on caller abort and ignores late chunks", async () => {
    let downstream: ReadableStreamDefaultController<Uint8Array> | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        downstream = controller;
      },
    });
    const { calls, fetchImpl } = makeFetchStub(
      new Response(stream, { headers: { "content-type": "text/event-stream" } }),
    );
    const adapter = createMistralAdapter({
      getApiKey: async () => "test-key",
      fetchImpl,
    });
    const { controller, request } = baseRequest();
    const iterator = adapter.complete(request)[Symbol.asyncIterator]();

    downstream!.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"first"}}]}\n\n'));
    const first = await iterator.next();
    expect(first.value).toMatchObject({ kind: "phase", phase: "queued" });
    // Drain until the first text delta arrives.
    let seen = "";
    for (let i = 0; i < 10 && seen === ""; i++) {
      const next = await iterator.next();
      if (next.done) break;
      if (next.value.kind === "text") seen = next.value.delta;
    }
    expect(seen).toBe("first");

    controller.abort();
    // Late chunk after abort must never surface.
    downstream!.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"LATE"}}]}\n\n'));
    downstream!.close();

    const rest: StreamEvent[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      rest.push(next.value);
    }
    expect(texts(rest)).not.toContain("LATE");
    expect(rest[rest.length - 1]).toMatchObject({ kind: "done", stopReason: "cancelled" });
    expect(calls).toHaveLength(1);
    // Caller signal is forwarded to fetch.
    expect(calls[0]!.init.signal).toBe(controller.signal);
  });

  it("reports cancelled immediately when already aborted", async () => {
    const { calls, fetchImpl } = makeFetchStub(
      streamResponse([enc.encode("data: [DONE]\n\n")]),
    );
    const adapter = createMistralAdapter({
      getApiKey: async () => "test-key",
      fetchImpl,
    });
    const { controller, request } = baseRequest();
    controller.abort();
    const events = await collect(adapter.complete(request));
    expect(calls).toHaveLength(0);
    expect(events[events.length - 1]).toMatchObject({
      kind: "done",
      stopReason: "cancelled",
    });
  });
});

describe("mistral complete — images", () => {
  it("refuses image ids without a resolver instead of dropping photos silently", async () => {
    const { calls, fetchImpl } = makeFetchStub(
      streamResponse([enc.encode("data: [DONE]\n\n")]),
    );
    const adapter = createMistralAdapter({
      getApiKey: async () => "test-key",
      fetchImpl,
    });
    const { request } = baseRequest({ approvedImageIds: ["photo-1"] });
    const events = await collect(adapter.complete(request));
    expect(calls).toHaveLength(0);
    const error = events.find((e) => e.kind === "error");
    expect(error).toMatchObject({ kind: "error", retryable: false });
    expect((error as { code: string }).code).toMatch(/image/i);
  });

  it("sends image_url parts when a resolver supplies URLs (vision-capable route)", async () => {
    const { calls, fetchImpl } = makeFetchStub(
      streamResponse([enc.encode('data: {"choices":[{"delta":{"content":"seen"}}]}\n\ndata: [DONE]\n\n')]),
    );
    const adapter = createMistralAdapter({
      getApiKey: async () => "test-key",
      fetchImpl,
      resolveImageUrl: async (id: string) => `https://example-cdn.test/${id}.jpg`,
    });
    const { request } = baseRequest({ approvedImageIds: ["photo-1"] });
    const events = await collect(adapter.complete(request));
    expect(texts(events)).toBe("seen");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.messages[body.messages.length - 1]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "Hello" },
        {
          type: "image_url",
          image_url: { url: "https://example-cdn.test/photo-1.jpg" },
        },
      ],
    });
  });
});

describe("mistral listModels", () => {
  it("maps the /v1/models envelope with unknown pricing (never invented)", async () => {
    const { calls, fetchImpl } = makeFetchStub(
      jsonResponse({
        object: "list",
        data: [
          { id: "mistral-large-latest", object: "model", created: 1750000000, owned_by: "mistralai" },
          { id: "pixtral-12b-2409", object: "model", created: 1750000000, owned_by: "mistralai" },
          { id: 42 }, // malformed entry is skipped
        ],
      }),
    );
    const adapter = createMistralAdapter({
      getApiKey: async () => "test-key",
      fetchImpl,
    });
    const models = await adapter.listModels!();
    expect(calls[0]!.url).toBe(MODELS_URL);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-key");
    expect(models).toHaveLength(2);

    expect(models[0]).toMatchObject({
      provider: "mistral",
      id: "mistral-large-latest",
      input: ["text"],
      output: ["text"],
      entitlement: "untested",
    });
    // No price fields in the endpoint: unknown, never 0, never "free".
    expect(models[0]!.prices).toEqual([]);
    expect(models[0]!.priceClass).toBe("unknown");
    expect(models[0]!.contextTokens).toBeUndefined();
    expect(models[0]!.maxOutputTokens).toBeUndefined();
  });

  it("throws on non-OK models responses", async () => {
    const { fetchImpl } = makeFetchStub(jsonResponse({ message: "Unauthorized" }, 401));
    const adapter = createMistralAdapter({
      getApiKey: async () => "bad-key",
      fetchImpl,
    });
    await expect(adapter.listModels!()).rejects.toThrow(/401/);
  });
});

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
