/**
 * Groq BYOK provider adapter tests (packet AI-020b).
 *
 * Fixtures are hand-built wire captures shaped by Groq's OpenAI-compatible
 * API (`POST https://api.groq.com/openai/v1/chat/completions`, SSE
 * `data:` chunks, `data: [DONE]` terminator,
 * `GET https://api.groq.com/openai/v1/models` returning
 * `{object:"list", data:[{id, ...}]}` with no pricing fields); no real key
 * is ever used and no live call is made — every live path is NOT TESTED
 * LIVE.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGroqAdapter } from "./groq";
import type { NormalizedRequest, StreamEvent } from "../providerContract";

const COMPLETIONS_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODELS_URL = "https://api.groq.com/openai/v1/models";

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
        provider: "openrouter",
        modelId: "llama-3.3-70b-versatile",
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

describe("groq capabilities", () => {
  it("reports streaming known-true and model-varying limits as unknown", () => {
    const adapter = createGroqAdapter({
      getApiKey: async () => "test-key",
    });
    expect(adapter.id).toBe("groq");
    const caps = adapter.capabilities();
    expect(caps.streaming).toEqual({ state: "known", value: true });
    // Model-varying facts stay unknown, never 0/"free".
    expect(caps.vision).toEqual({ state: "unknown" });
    expect(caps.maxImagesPerCall).toEqual({ state: "unknown" });
    expect(caps.contextTokens).toEqual({ state: "unknown" });
    expect(caps.maxOutputTokens).toEqual({ state: "unknown" });
  });
});

describe("groq complete — happy path wire format", () => {
  it("parses CRLF framing, split UTF-8, multiline data:, keepalives, usage chunk, [DONE]", async () => {
    // "héllo 🌍" split mid-codepoint across network chunks.
    const full = "h\u00e9llo \u{1F30D}!";
    const fullBytes = enc.encode(full);
    const splitAt = fullBytes.length - 3; // split inside the final "!"... adjust below
    void splitAt;
    const helloBytes = enc.encode("h\u00e9llo ");
    const emojiBytes = enc.encode("\u{1F30D}");
    const bangBytes = enc.encode("!");

    const chunkA = (line: string) => enc.encode(line);
    const part1 = concat([
      chunkA(": keepalive\r\n"),
      chunkA("\r\n"),
      chunkA('data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"role":"assistant","content":"'),
      helloBytes.subarray(0, 3),
    ]);
    const part2 = concat([
      helloBytes.subarray(3),
      emojiBytes.subarray(0, 2),
    ]);
    const part3 = concat([
      emojiBytes.subarray(2),
      chunkA('"}}],"model":"llama-3.3-70b-versatile"}\r\n'),
      // Multiline data: — joined with "\n" per SSE, must still parse.
      chunkA("data: {\"id\":\"chatcmpl-1\",\r\ndata: \"choices\":[{\"index\":0,\"delta\":{\"content\":\""),
      bangBytes,
      chunkA('"}}]}\r\n'),
      chunkA("\r\n"),
      chunkA(": keepalive\r\n"),
      // Final usage chunk (include_usage stream option).
      chunkA(
        'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"","role":"assistant"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":4,"total_tokens":14}}\r\n',
      ),
      chunkA("data: [DONE]\r\n"),
    ]);

    const { calls, fetchImpl } = makeFetchStub(
      streamResponse([part1, part2, part3]),
    );
    const adapter = createGroqAdapter({
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
      model: "llama-3.3-70b-versatile",
      stream: true,
      max_tokens: 128,
      stream_options: { include_usage: true },
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
    const adapter = createGroqAdapter({
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
        updatedAt: "2026-09-29T00:00:00.000Z",
      },
      recentTurns: [
        { id: "t1", role: "user", text: "q", attachmentIds: [], createdAt: "2026-09-29T00:00:00.000Z" },
        { id: "t2", role: "assistant", text: "a", attachmentIds: [], createdAt: "2026-09-29T00:00:01.000Z" },
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
    const adapter = createGroqAdapter({
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

describe("groq complete — errors", () => {
  it("maps a pre-stream 401 to a non-retryable auth error", async () => {
    const { calls, fetchImpl } = makeFetchStub(
      jsonResponse({ error: { code: 401, message: "Invalid API key" } }, 401),
    );
    const adapter = createGroqAdapter({
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
    const adapter = createGroqAdapter({
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
          'data: {"id":"chatcmpl-1","error":{"code":"server_error","message":"Upstream disconnected unexpectedly"},"choices":[{"index":0,"delta":{"content":""},"finish_reason":"error"}]}\n\n',
        ),
        enc.encode('data: {"choices":[{"delta":{"content":"LATE"}}]}\n\ndata: [DONE]\n\n'),
      ]),
    );
    const adapter = createGroqAdapter({
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
    const adapter = createGroqAdapter({
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

describe("groq complete — abort", () => {
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
    const adapter = createGroqAdapter({
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
    const adapter = createGroqAdapter({
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

describe("groq complete — images", () => {
  it("refuses image ids without a resolver instead of dropping photos silently", async () => {
    const { calls, fetchImpl } = makeFetchStub(
      streamResponse([enc.encode("data: [DONE]\n\n")]),
    );
    const adapter = createGroqAdapter({
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

  it("sends image_url parts when a resolver supplies URLs", async () => {
    const { calls, fetchImpl } = makeFetchStub(
      streamResponse([enc.encode('data: {"choices":[{"delta":{"content":"seen"}}]}\n\ndata: [DONE]\n\n')]),
    );
    const adapter = createGroqAdapter({
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

describe("groq listModels", () => {
  it("maps the /models envelope with unknown pricing — never invented", async () => {
    const { calls, fetchImpl } = makeFetchStub(
      jsonResponse({
        object: "list",
        data: [
          {
            id: "llama-3.3-70b-versatile",
            object: "model",
            created: 1721692800,
            owned_by: "Meta",
          },
          {
            id: "openai/gpt-oss-120b",
            object: "model",
            created: 1754006400,
            owned_by: "OpenAI",
          },
          { id: 42 }, // malformed entry is skipped
        ],
      }),
    );
    const adapter = createGroqAdapter({
      getApiKey: async () => "test-key",
      fetchImpl,
    });
    const models = await adapter.listModels!();
    expect(calls[0]!.url).toBe(MODELS_URL);
    expect(models).toHaveLength(2);

    expect(models[0]).toMatchObject({
      provider: "groq",
      id: "llama-3.3-70b-versatile",
      input: ["text"],
      output: ["text"],
      entitlement: "untested",
    });
    // No pricing in the Groq envelope: unknown, never 0, never "free".
    expect(models[0]!.prices).toEqual([]);
    expect(models[0]!.priceClass).toBe("unknown");
    expect(models[0]!.contextTokens).toBeUndefined();
    expect(models[0]!.maxOutputTokens).toBeUndefined();
  });

  it("throws on non-OK models responses", async () => {
    const { fetchImpl } = makeFetchStub(jsonResponse({ error: "nope" }, 500));
    const adapter = createGroqAdapter({
      getApiKey: async () => "test-key",
      fetchImpl,
    });
    await expect(adapter.listModels!()).rejects.toThrow(/500/);
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
