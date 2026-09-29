/**
 * Generic OpenAI-compatible provider adapter tests (AI-020e).
 *
 * Fixtures are hand-built OpenAI-compatible wire captures (same SSE shape as
 * the OpenRouter adapter); no real key is ever used and no live call is
 * made — every live path is NOT TESTED LIVE.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGenericAdapter } from "./generic";
import type { NormalizedRequest, StreamEvent } from "../providerContract";

const BASE_URL = "http://localhost:11434/v1";
const COMPLETIONS_URL = `${BASE_URL}/chat/completions`;
const MODELS_URL = `${BASE_URL}/models`;

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
        provider: "openai",
        modelId: "llama3",
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

describe("generic baseURL validation", () => {
  it("rejects non-http(s) schemes", () => {
    expect(() =>
      createGenericAdapter({ baseURL: "ftp://lan/test", getApiKey: async () => null }),
    ).toThrow(/generic-invalid-base-url/);
    expect(() =>
      createGenericAdapter({ baseURL: "file:///models", getApiKey: async () => null }),
    ).toThrow(/generic-invalid-base-url/);
    expect(() =>
      createGenericAdapter({ baseURL: "javascript:alert(1)", getApiKey: async () => null }),
    ).toThrow(/generic-invalid-base-url/);
  });

  it("rejects credentials embedded in the URL", () => {
    expect(() =>
      createGenericAdapter({
        baseURL: "http://user:secret@localhost:11434/v1",
        getApiKey: async () => null,
      }),
    ).toThrow(/credentials/);
  });

  it("rejects empty and unparseable input", () => {
    expect(() =>
      createGenericAdapter({ baseURL: "   ", getApiKey: async () => null }),
    ).toThrow(/generic-invalid-base-url/);
    expect(() =>
      createGenericAdapter({ baseURL: "not a url", getApiKey: async () => null }),
    ).toThrow(/generic-invalid-base-url/);
  });

  it("strips trailing slashes so paths join cleanly", async () => {
    const { calls, fetchImpl } = makeFetchStub(
      streamResponse([enc.encode("data: [DONE]\n\n")]),
    );
    const adapter = createGenericAdapter({
      baseURL: "http://localhost:11434/v1///",
      getApiKey: async () => null,
      fetchImpl,
    });
    const { request } = baseRequest();
    await collect(adapter.complete(request));
    expect(calls[0]!.url).toBe(COMPLETIONS_URL);
  });

  it("never performs network I/O during construction", () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    createGenericAdapter({ baseURL: BASE_URL, getApiKey: async () => null, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("generic capabilities", () => {
  it("reports streaming known-true and model-varying limits as unknown", () => {
    const adapter = createGenericAdapter({
      baseURL: BASE_URL,
      getApiKey: async () => "test-key",
    });
    expect(adapter.id).toBe("generic");
    const caps = adapter.capabilities();
    expect(caps.streaming).toEqual({ state: "known", value: true });
    expect(caps.vision).toEqual({ state: "unknown" });
    expect(caps.maxImagesPerCall).toEqual({ state: "unknown" });
    expect(caps.contextTokens).toEqual({ state: "unknown" });
    expect(caps.maxOutputTokens).toEqual({ state: "unknown" });
  });
});

describe("generic complete — happy path wire format", () => {
  it("parses CRLF framing, split UTF-8, multiline data:, keepalives, usage chunk, [DONE]", async () => {
    const full = "h\u00e9llo \u{1F30D}!";
    const fullBytes = enc.encode(full);
    void fullBytes;
    const helloBytes = enc.encode("h\u00e9llo ");
    const emojiBytes = enc.encode("\u{1F30D}");
    const bangBytes = enc.encode("!");

    const chunkA = (line: string) => enc.encode(line);
    const part1 = concat([
      chunkA(": PROCESSING\r\n"),
      chunkA("\r\n"),
      chunkA('data: {"id":"gen-1","choices":[{"index":0,"delta":{"role":"assistant","content":"'),
      helloBytes.subarray(0, 3),
    ]);
    const part2 = concat([
      helloBytes.subarray(3),
      emojiBytes.subarray(0, 2),
    ]);
    const part3 = concat([
      emojiBytes.subarray(2),
      chunkA('"}}],"model":"llama3"}\r\n'),
      chunkA("data: {\"id\":\"gen-1\",\r\ndata: \"choices\":[{\"index\":0,\"delta\":{\"content\":\""),
      bangBytes,
      chunkA('"}}]}\r\n'),
      chunkA("\r\n"),
      chunkA(": keepalive\r\n"),
      chunkA(
        'data: {"id":"gen-1","choices":[{"index":0,"delta":{"content":"","role":"assistant"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":4,"total_tokens":14}}\r\n',
      ),
      chunkA("data: [DONE]\r\n"),
    ]);

    const { calls, fetchImpl } = makeFetchStub(
      streamResponse([part1, part2, part3]),
    );
    const adapter = createGenericAdapter({
      baseURL: BASE_URL,
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

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(COMPLETIONS_URL);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-key");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toMatchObject({
      model: "llama3",
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
    const adapter = createGenericAdapter({
      baseURL: BASE_URL,
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
    const adapter = createGenericAdapter({
      baseURL: BASE_URL,
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

  it("sends configured extra headers and keyless LAN requests omit Authorization", async () => {
    const { calls, fetchImpl } = makeFetchStub(
      streamResponse([enc.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n')]),
    );
    const adapter = createGenericAdapter({
      baseURL: BASE_URL,
      getApiKey: async () => null,
      fetchImpl,
      extraHeaders: { "HTTP-Referer": "https://example.test", "X-Title": "FindBack" },
    });
    const { request } = baseRequest();
    const events = await collect(adapter.complete(request));
    expect(texts(events)).toBe("hi");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
    expect(headers["HTTP-Referer"]).toBe("https://example.test");
    expect(headers["X-Title"]).toBe("FindBack");
  });
});

describe("generic complete — errors", () => {
  it("maps a pre-stream 401 to a non-retryable auth error", async () => {
    const { calls, fetchImpl } = makeFetchStub(
      jsonResponse({ error: { code: 401, message: "Invalid API key" } }, 401),
    );
    const adapter = createGenericAdapter({
      baseURL: BASE_URL,
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
      jsonResponse({ error: { code: 429, message: "slow down" } }, 429),
    );
    const adapter = createGenericAdapter({
      baseURL: BASE_URL,
      getApiKey: async () => "test-key",
      fetchImpl,
    });
    const { request } = baseRequest();
    const events = await collect(adapter.complete(request));
    expect(events.find((e) => e.kind === "error")).toMatchObject({
      kind: "error",
      retryable: true,
    });
  });

  it("surfaces a mid-stream error event and stops", async () => {
    const { fetchImpl } = makeFetchStub(
      streamResponse([
        enc.encode('data: {"choices":[{"delta":{"content":"hel"}}]}\n\n'),
        enc.encode(
          'data: {"id":"cmpl-1","error":{"code":"server_error","message":"Provider disconnected unexpectedly"},"choices":[{"index":0,"delta":{"content":""},"finish_reason":"error"}]}\n\n',
        ),
        enc.encode('data: {"choices":[{"delta":{"content":"LATE"}}]}\n\ndata: [DONE]\n\n'),
      ]),
    );
    const adapter = createGenericAdapter({
      baseURL: BASE_URL,
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
});

describe("generic complete — abort", () => {
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
    const adapter = createGenericAdapter({
      baseURL: BASE_URL,
      getApiKey: async () => "test-key",
      fetchImpl,
    });
    const { controller, request } = baseRequest();
    const iterator = adapter.complete(request)[Symbol.asyncIterator]();

    downstream!.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"first"}}]}\n\n'));
    const first = await iterator.next();
    expect(first.value).toMatchObject({ kind: "phase", phase: "queued" });
    let seen = "";
    for (let i = 0; i < 10 && seen === ""; i++) {
      const next = await iterator.next();
      if (next.done) break;
      if (next.value.kind === "text") seen = next.value.delta;
    }
    expect(seen).toBe("first");

    controller.abort();
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
    expect(calls[0]!.init.signal).toBe(controller.signal);
  });

  it("reports cancelled immediately when already aborted", async () => {
    const { calls, fetchImpl } = makeFetchStub(
      streamResponse([enc.encode("data: [DONE]\n\n")]),
    );
    const adapter = createGenericAdapter({
      baseURL: BASE_URL,
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

describe("generic complete — images", () => {
  it("refuses image ids without a resolver instead of dropping photos silently", async () => {
    const { calls, fetchImpl } = makeFetchStub(
      streamResponse([enc.encode("data: [DONE]\n\n")]),
    );
    const adapter = createGenericAdapter({
      baseURL: BASE_URL,
      getApiKey: async () => null,
      fetchImpl,
    });
    const { request } = baseRequest({ approvedImageIds: ["photo-1"] });
    const events = await collect(adapter.complete(request));
    expect(calls).toHaveLength(0);
    const error = events.find((e) => e.kind === "error");
    expect(error).toMatchObject({ kind: "error", retryable: false });
    expect((error as { code: string }).code).toMatch(/image/i);
  });

  it("sends image_url parts when a resolver supplies URLs", async () => {
    const { calls, fetchImpl } = makeFetchStub(
      streamResponse([enc.encode('data: {"choices":[{"delta":{"content":"seen"}}]}\n\ndata: [DONE]\n\n')]),
    );
    const adapter = createGenericAdapter({
      baseURL: BASE_URL,
      getApiKey: async () => null,
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

describe("generic listModels", () => {
  it("maps the /models envelope with unknown pricing (never invented)", async () => {
    const { calls, fetchImpl } = makeFetchStub(
      jsonResponse({
        data: [
          { id: "llama3" },
          { id: "mistral", pricing: { prompt: "0.1" } },
          { id: 42 },
        ],
      }),
    );
    const adapter = createGenericAdapter({
      baseURL: BASE_URL,
      getApiKey: async () => "test-key",
      fetchImpl,
    });
    const models = await adapter.listModels!();
    expect(calls[0]!.url).toBe(MODELS_URL);
    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({
      provider: "generic",
      id: "llama3",
      entitlement: "untested",
    });
    for (const model of models) {
      expect(model.prices).toEqual([]);
      expect(model.priceClass).toBe("unknown");
      expect(model.contextTokens).toBeUndefined();
      expect(model.maxOutputTokens).toBeUndefined();
    }
  });

  it("falls back to an empty catalogue on non-OK models responses", async () => {
    const { calls, fetchImpl } = makeFetchStub(jsonResponse({ error: "nope" }, 500));
    const adapter = createGenericAdapter({
      baseURL: BASE_URL,
      getApiKey: async () => "test-key",
      fetchImpl,
    });
    await expect(adapter.listModels!()).resolves.toEqual([]);
    expect(calls[0]!.url).toBe(MODELS_URL);
  });

  it("falls back to an empty catalogue on network failure", async () => {
    const fetchImpl = (async () => {
      throw new Error("connection refused");
    }) as typeof fetch;
    const adapter = createGenericAdapter({
      baseURL: BASE_URL,
      getApiKey: async () => null,
      fetchImpl,
    });
    await expect(adapter.listModels!()).resolves.toEqual([]);
  });

  it("falls back to an empty catalogue on malformed payloads", async () => {
    const { fetchImpl } = makeFetchStub(jsonResponse({ data: "nope" }));
    const adapter = createGenericAdapter({
      baseURL: BASE_URL,
      getApiKey: async () => null,
      fetchImpl,
    });
    await expect(adapter.listModels!()).resolves.toEqual([]);
  });

  it("omits Authorization on keyless models calls", async () => {
    const { calls, fetchImpl } = makeFetchStub(jsonResponse({ data: [] }));
    const adapter = createGenericAdapter({
      baseURL: BASE_URL,
      getApiKey: async () => null,
      fetchImpl,
    });
    await adapter.listModels!();
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
    expect(calls[0]!.url).toBe(MODELS_URL);
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
