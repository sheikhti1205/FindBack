/**
 * DeepSeek BYOK provider adapter tests (packet P-deepseek).
 *
 * Fixtures are hand-built wire captures shaped by the official DeepSeek docs
 * verified on 2026-09-25 (`api-docs.deepseek.com`: Your First API Call, Chat
 * Completions API, Vision, Models & Pricing, Lists Models, Error Codes).
 * No real key is ever used and no live call is made — every live path is
 * NOT TESTED LIVE.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { DIRECT_KEY_POLICY, createDeepSeekAdapter, directKeyEntitlement } from "./deepseek";
import type { NormalizedRequest, StreamEvent } from "../providerContract";

const COMPLETIONS_URL = "https://api.deepseek.com/chat/completions";
const MODELS_URL = "https://api.deepseek.com/models";
/** Deliberately not shaped like a real DeepSeek key. Never a live credential. */
const TEST_KEY = "test-key-not-a-real-deepseek-credential";

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
        provider: "deepseek",
        modelId: "deepseek-flash",
        mode: "paid-explicit",
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

function last(events: StreamEvent[]): StreamEvent {
  return events[events.length - 1] as StreamEvent;
}

function bodyOf(call: FetchCall): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("deepseek capabilities", () => {
  it("reports streaming/vision known, model-scoped limits unknown", () => {
    const adapter = createDeepSeekAdapter({
      getApiKey: async () => TEST_KEY,
    });
    expect(adapter.id).toBe("deepseek");
    const caps = adapter.capabilities();
    expect(caps.streaming).toEqual({ state: "known", value: true });
    // Vision guide: deepseek-flash accepts images; deepseek-v4-pro does not —
    // per-model capability belongs to the catalogue, never a zero/default here.
    expect(caps.vision).toEqual({ state: "known", value: true });
    // Vision > Limits: "Max images per request: 600".
    expect(caps.maxImagesPerCall).toEqual({ state: "known", value: 600 });
    // Model-scoped (1M / 393216 observed on Models & Pricing + /models):
    // unknown stays unknown, never 0, never "free".
    expect(caps.contextTokens).toEqual({ state: "unknown" });
    expect(caps.maxOutputTokens).toEqual({ state: "unknown" });
  });
});

describe("deepseek complete — wire format", () => {
  it("parses CRLF, split UTF-8, multiline data:, comments, event: lines, null usage, final usage, [DONE]", async () => {
    const hello = enc.encode("h\u00e9llo ");
    const emoji = enc.encode("\u{1F30D}");
    const part1 = concat([
      enc.encode(": ping\r\n"),
      enc.encode("\r\n"),
      enc.encode(
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"',
      ),
      hello.subarray(0, 3),
    ]);
    const part2 = concat([hello.subarray(3), emoji.subarray(0, 2)]);
    const part3 = concat([
      emoji.subarray(2),
      enc.encode('"},"finish_reason":null,"usage":null}]}\r\n'),
      // Non-data SSE fields are ignored, never parsed as JSON.
      enc.encode("event: message\r\n"),
      // Multiline data: — joined with "\n" per SSE, must still parse.
      enc.encode('data: {"id":"chatcmpl-1",\r\n'),
      enc.encode(
        'data: "choices":[{"index":0,"delta":{"content":"!"},"finish_reason":null}]}\r\n',
      ),
      enc.encode("\r\n"),
      // include_usage:true → usage null on every non-final chunk (ignored).
      enc.encode(
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":null}],"usage":null}\r\n',
      ),
      // Final content chunk before [DONE] carries the usage statistics.
      enc.encode(
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":17,"completion_tokens":9,"total_tokens":26,"prompt_cache_hit_tokens":16}}\r\n',
      ),
      enc.encode("data: [DONE]\r\n"),
    ]);

    const { calls, fetchImpl } = makeFetchStub(
      streamResponse([part1, part2, part3]),
    );
    const adapter = createDeepSeekAdapter({
      getApiKey: async () => TEST_KEY,
      fetchImpl,
    });
    const { request } = baseRequest();

    const events = await collect(adapter.complete(request));

    expect(texts(events)).toBe("h\u00e9llo \u{1F30D}!");
    const usages = events.filter((e) => e.kind === "usage");
    expect(usages).toHaveLength(1);
    expect(usages[0]).toMatchObject({
      kind: "usage",
      attempt: 1,
      inputTokens: 17,
      outputTokens: 9,
    });
    expect(events.some((e) => e.kind === "phase" && e.phase === "first-token")).toBe(
      true,
    );
    expect(last(events)).toMatchObject({
      kind: "done",
      attempt: 1,
      stopReason: "complete",
    });
    expect(events.every((e) => e.attempt === 1)).toBe(true);

    // Wire assertions: allowlisted endpoint, DeepSeek auth, official body.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(COMPLETIONS_URL);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${TEST_KEY}`);
    expect(headers["Content-Type"]).toBe("application/json");
    const body = bodyOf(calls[0]!);
    expect(body).toMatchObject({
      model: "deepseek-flash",
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 128,
      messages: [{ role: "user", content: "Hello" }],
    });
    // No OpenAI-only fields DeepSeek does not document.
    expect(body).not.toHaveProperty("max_completion_tokens");
    expect(calls[0]!.init.signal).toBe(request.signal);
  });

  it("builds system only from buildSystemText and keeps the summary as labelled untrusted user data", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { calls, fetchImpl } = makeFetchStub(
      streamResponse([
        enc.encode(
          'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
        ),
      ]),
    );
    const adapter = createDeepSeekAdapter({
      getApiKey: async () => TEST_KEY,
      fetchImpl,
      buildSystemText: () => "APP POLICY v1",
    });
    const { request } = baseRequest({
      summary: {
        schemaVersion: 1,
        coveredThroughTurnId: "t1",
        sourceTurnIds: ["t1"],
        summaryText: "user prefers compact answers",
        generatedBy: "local-extractive",
        estimatedTokens: 12,
        updatedAt: "2026-09-25T00:00:00.000Z",
      },
      recentTurns: [
        {
          id: "t1",
          role: "user",
          text: "q",
          attachmentIds: [],
          createdAt: "2026-09-25T00:00:00.000Z",
        },
        {
          id: "t2",
          role: "assistant",
          text: "a",
          attachmentIds: [],
          createdAt: "2026-09-25T00:00:01.000Z",
        },
      ],
      currentText: "follow-up",
    });

    const events = await collect(adapter.complete(request));
    expect(texts(events)).toBe("ok");

    const body = bodyOf(calls[0]!);
    const messages = body["messages"] as Array<{
      role: string;
      content: unknown;
    }>;
    expect(messages[0]).toEqual({ role: "system", content: "APP POLICY v1" });
    // Exactly one system message, and it never carries the summary.
    expect(messages.filter((m) => m.role === "system")).toHaveLength(1);
    const firstUser = messages[1]!;
    expect(firstUser.role).toBe("user");
    expect(typeof firstUser.content).toBe("string");
    const firstUserText = String(firstUser.content);
    expect(firstUserText).toContain("user prefers compact answers");
    expect(firstUserText.toLowerCase()).toContain("untrusted");
    expect(firstUserText.endsWith("q")).toBe(true);
    expect(messages[2]).toEqual({ role: "assistant", content: "a" });
    expect(messages[3]).toEqual({ role: "user", content: "follow-up" });

    // No prompt/summary content leaves the process through the console.
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("ends complete when the stream closes without [DONE]", async () => {
    const { fetchImpl } = makeFetchStub(
      streamResponse([
        enc.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'),
      ]),
    );
    const adapter = createDeepSeekAdapter({
      getApiKey: async () => TEST_KEY,
      fetchImpl,
    });
    const { request } = baseRequest();
    const events = await collect(adapter.complete(request));
    expect(texts(events)).toBe("partial");
    expect(last(events)).toMatchObject({
      kind: "done",
      stopReason: "complete",
    });
  });
});

const STATUS_CASES: Array<[number, string, boolean]> = [
  [400, "bad-request", false],
  [401, "auth-invalid", false],
  [402, "payment-required", false],
  [422, "invalid-parameters", false],
  [429, "rate-limited", true],
  [503, "server-error", true],
];

describe("deepseek complete — errors", () => {
  it.each(STATUS_CASES)(
    "maps HTTP %i to %s (retryable=%s)",
    async (status, code, retryable) => {
      const { calls, fetchImpl } = makeFetchStub(
        jsonResponse({ error: { message: "provider says no" } }, status),
      );
      const adapter = createDeepSeekAdapter({
        getApiKey: async () => TEST_KEY,
        fetchImpl,
      });
      const { request } = baseRequest();
      const events = await collect(adapter.complete(request));
      expect(events.find((e) => e.kind === "error")).toMatchObject({
        kind: "error",
        attempt: 1,
        code,
        message: "provider says no",
        retryable,
      });
      expect(events.some((e) => e.kind === "phase" && e.phase === "failed")).toBe(
        true,
      );
      expect(last(events)).toMatchObject({
        kind: "done",
        stopReason: "error",
      });
      expect(calls).toHaveLength(1);
    },
  );

  it("emits auth-missing without calling fetch when no key resolves", async () => {
    const { calls, fetchImpl } = makeFetchStub(
      streamResponse([enc.encode("data: [DONE]\n\n")]),
    );
    const adapter = createDeepSeekAdapter({
      getApiKey: async () => null,
      fetchImpl,
    });
    const { request } = baseRequest();
    const events = await collect(adapter.complete(request));
    expect(calls).toHaveLength(0);
    expect(events.find((e) => e.kind === "error")).toMatchObject({
      kind: "error",
      code: "auth-missing",
      retryable: false,
    });
    expect(last(events)).toMatchObject({
      kind: "done",
      stopReason: "error",
    });
  });

  it("rejects another provider's request before any network call", async () => {
    const { calls, fetchImpl } = makeFetchStub(
      streamResponse([enc.encode("data: [DONE]\n\n")]),
    );
    const adapter = createDeepSeekAdapter({
      getApiKey: async () => TEST_KEY,
      fetchImpl,
    });
    const { request } = baseRequest({
      selection: {
        accountId: "acct-1",
        provider: "openai",
        modelId: "gpt-5",
        mode: "paid-explicit",
      },
    });
    const events = await collect(adapter.complete(request));
    expect(calls).toHaveLength(0);
    expect(events.find((e) => e.kind === "error")).toMatchObject({
      kind: "error",
      code: "wrong-provider",
      retryable: false,
    });
  });

  it("rejects inline data-URL image ids before any network call", async () => {
    const { calls, fetchImpl } = makeFetchStub(
      streamResponse([enc.encode("data: [DONE]\n\n")]),
    );
    const adapter = createDeepSeekAdapter({
      getApiKey: async () => TEST_KEY,
      fetchImpl,
    });
    const { request } = baseRequest({
      approvedImageIds: ["data:image/png;base64,AAAA"],
    });
    const events = await collect(adapter.complete(request));
    expect(calls).toHaveLength(0);
    expect(events.find((e) => e.kind === "error")).toMatchObject({
      kind: "error",
      code: "invalid-request",
      retryable: false,
    });
  });

  const MAX_OUTPUT_CASES: Array<[number, string]> = [
    [0, "zero"],
    [393217, "above-the-documented-384K-maximum"],
  ];
  it.each(MAX_OUTPUT_CASES)(
    "rejects maxOutputTokens=%i (%s) before any network call",
    async (maxOutputTokens) => {
      const { calls, fetchImpl } = makeFetchStub(
        streamResponse([enc.encode("data: [DONE]\n\n")]),
      );
      const adapter = createDeepSeekAdapter({
        getApiKey: async () => TEST_KEY,
        fetchImpl,
      });
      const { request } = baseRequest({ maxOutputTokens });
      const events = await collect(adapter.complete(request));
      expect(calls).toHaveLength(0);
      expect(events.find((e) => e.kind === "error")).toMatchObject({
        kind: "error",
        code: "max-output-invalid",
        retryable: false,
      });
    },
  );

  it("surfaces a mid-stream error event and never yields later chunks", async () => {
    const { fetchImpl } = makeFetchStub(
      streamResponse([
        enc.encode('data: {"choices":[{"delta":{"content":"hel"}}]}\n\n'),
        enc.encode(
          'data: {"id":"chatcmpl-1","error":{"message":"upstream exploded"},"choices":[{"index":0,"delta":{},"finish_reason":"error"}]}\n\n',
        ),
        enc.encode(
          'data: {"choices":[{"delta":{"content":"LATE"}}]}\n\ndata: [DONE]\n\n',
        ),
      ]),
    );
    const adapter = createDeepSeekAdapter({
      getApiKey: async () => TEST_KEY,
      fetchImpl,
    });
    const { request } = baseRequest();
    const events = await collect(adapter.complete(request));
    expect(texts(events)).toBe("hel");
    expect(events.find((e) => e.kind === "error")).toMatchObject({
      kind: "error",
      code: "stream-error",
      message: "upstream exploded",
      retryable: false,
    });
    expect(last(events)).toMatchObject({
      kind: "done",
      stopReason: "error",
    });
  });

  it("maps finish_reason content_filter to a non-retryable error but keeps usage", async () => {
    const { fetchImpl } = makeFetchStub(
      streamResponse([
        enc.encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'),
        enc.encode(
          'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"content_filter"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\ndata: [DONE]\n\n',
        ),
      ]),
    );
    const adapter = createDeepSeekAdapter({
      getApiKey: async () => TEST_KEY,
      fetchImpl,
    });
    const { request } = baseRequest();
    const events = await collect(adapter.complete(request));
    expect(texts(events)).toBe("ok");
    expect(events.find((e) => e.kind === "usage")).toMatchObject({
      kind: "usage",
      inputTokens: 5,
      outputTokens: 2,
    });
    expect(events.find((e) => e.kind === "error")).toMatchObject({
      kind: "error",
      code: "content-filter",
      retryable: false,
    });
    expect(last(events)).toMatchObject({
      kind: "done",
      stopReason: "error",
    });
  });

  it("maps a fetch rejection to a retryable network error", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;
    const adapter = createDeepSeekAdapter({
      getApiKey: async () => TEST_KEY,
      fetchImpl,
    });
    const { request } = baseRequest();
    const events = await collect(adapter.complete(request));
    expect(events.find((e) => e.kind === "error")).toMatchObject({
      kind: "error",
      code: "network-error",
      retryable: true,
    });
    expect(last(events)).toMatchObject({
      kind: "done",
      stopReason: "error",
    });
  });
});

describe("deepseek complete — abort", () => {
  it("reports cancelled immediately when already aborted", async () => {
    const { calls, fetchImpl } = makeFetchStub(
      streamResponse([enc.encode("data: [DONE]\n\n")]),
    );
    const adapter = createDeepSeekAdapter({
      getApiKey: async () => TEST_KEY,
      fetchImpl,
    });
    const { controller, request } = baseRequest();
    controller.abort();
    const events = await collect(adapter.complete(request));
    expect(calls).toHaveLength(0);
    expect(events.some((e) => e.kind === "error")).toBe(false);
    expect(last(events)).toMatchObject({
      kind: "done",
      stopReason: "cancelled",
    });
  });

  it("cancels on caller abort and ignores late chunks after abort", async () => {
    let downstream: ReadableStreamDefaultController<Uint8Array> | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        downstream = controller;
      },
    });
    const { calls, fetchImpl } = makeFetchStub(
      new Response(stream, { headers: { "content-type": "text/event-stream" } }),
    );
    const adapter = createDeepSeekAdapter({
      getApiKey: async () => TEST_KEY,
      fetchImpl,
    });
    const { controller, request } = baseRequest();
    const iterator = adapter.complete(request)[Symbol.asyncIterator]();

    downstream!.enqueue(
      enc.encode('data: {"choices":[{"delta":{"content":"first"}}]}\n\n'),
    );
    const first = await iterator.next();
    expect(first.value).toMatchObject({ kind: "phase", phase: "queued" });
    // Drain until the first text delta arrives.
    let seen = "";
    for (let i = 0; i < 12 && seen === ""; i++) {
      const next = await iterator.next();
      if (next.done) break;
      if (next.value.kind === "text") seen = next.value.delta;
    }
    expect(seen).toBe("first");

    controller.abort();
    // Late chunk after abort must never surface.
    downstream!.enqueue(
      enc.encode('data: {"choices":[{"delta":{"content":"LATE"}}]}\n\n'),
    );
    downstream!.close();

    const rest: StreamEvent[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      rest.push(next.value);
    }
    expect(texts(rest)).not.toContain("LATE");
    expect(last(rest)).toMatchObject({
      kind: "done",
      stopReason: "cancelled",
    });
    expect(calls).toHaveLength(1);
    // Caller signal is forwarded to fetch.
    expect(calls[0]!.init.signal).toBe(controller.signal);
  });
});

describe("deepseek complete — images", () => {
  it("refuses image ids without a resolver instead of dropping photos silently", async () => {
    const { calls, fetchImpl } = makeFetchStub(
      streamResponse([enc.encode("data: [DONE]\n\n")]),
    );
    const adapter = createDeepSeekAdapter({
      getApiKey: async () => TEST_KEY,
      fetchImpl,
    });
    const { request } = baseRequest({ approvedImageIds: ["photo-1"] });
    const events = await collect(adapter.complete(request));
    expect(calls).toHaveLength(0);
    expect(events.find((e) => e.kind === "error")).toMatchObject({
      kind: "error",
      retryable: false,
    });
    expect(
      (events.find((e) => e.kind === "error") as { code: string }).code,
    ).toMatch(/image/i);
  });

  it("sends image_url parts on the final user message only", async () => {
    const { calls, fetchImpl } = makeFetchStub(
      streamResponse([
        enc.encode(
          'data: {"choices":[{"delta":{"content":"seen"}}]}\n\ndata: [DONE]\n\n',
        ),
      ]),
    );
    const adapter = createDeepSeekAdapter({
      getApiKey: async () => TEST_KEY,
      fetchImpl,
      resolveImageUrl: async (id: string) => `https://cdn.test/${id}.jpg`,
    });
    const { request } = baseRequest({
      recentTurns: [
        {
          id: "t1",
          role: "user",
          text: "earlier",
          attachmentIds: [],
          createdAt: "2026-09-25T00:00:00.000Z",
        },
      ],
      approvedImageIds: ["photo-1"],
    });
    const events = await collect(adapter.complete(request));
    expect(texts(events)).toBe("seen");
    const body = bodyOf(calls[0]!);
    const messages = body["messages"] as Array<{
      role: string;
      content: unknown;
    }>;
    // Historical turns are plain text: approval is per-request, never replayed.
    expect(messages[0]).toEqual({ role: "user", content: "earlier" });
    expect(messages[messages.length - 1]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "Hello" },
        {
          type: "image_url",
          image_url: { url: "https://cdn.test/photo-1.jpg" },
        },
      ],
    });
  });

  it("rejects more than the documented 600 images before any network call", async () => {
    const { calls, fetchImpl } = makeFetchStub(
      streamResponse([enc.encode("data: [DONE]\n\n")]),
    );
    const adapter = createDeepSeekAdapter({
      getApiKey: async () => TEST_KEY,
      fetchImpl,
      resolveImageUrl: async (id: string) => `https://cdn.test/${id}.jpg`,
    });
    const approvedImageIds = Array.from(
      { length: 601 },
      (_, i) => `photo-${i}`,
    );
    const { request } = baseRequest({ approvedImageIds });
    const events = await collect(adapter.complete(request));
    expect(calls).toHaveLength(0);
    expect(
      (events.find((e) => e.kind === "error") as { code: string }).code,
    ).toMatch(/image-limit/);
  });

  it("rejects a resolver URL that is neither http(s) nor an image data URL", async () => {
    const { calls, fetchImpl } = makeFetchStub(
      streamResponse([enc.encode("data: [DONE]\n\n")]),
    );
    const adapter = createDeepSeekAdapter({
      getApiKey: async () => TEST_KEY,
      fetchImpl,
      resolveImageUrl: async () => "javascript:alert(1)",
    });
    const { request } = baseRequest({ approvedImageIds: ["photo-1"] });
    const events = await collect(adapter.complete(request));
    expect(calls).toHaveLength(0);
    expect(events.find((e) => e.kind === "error")).toMatchObject({
      kind: "error",
      code: "unresolvable-image",
      retryable: false,
    });
  });
});

describe("deepseek listModels", () => {
  it("maps the /models envelope; prices absent → unknown, never free", async () => {
    const { calls, fetchImpl } = makeFetchStub(
      jsonResponse({
        object: "list",
        data: [
          {
            id: "deepseek-flash",
            object: "model",
            owned_by: "deepseek",
            name: "DeepSeek-V4.1-Flash",
            context_window: 1048576,
            max_output_tokens: 393216,
            input_modalities: ["text", "image"],
            output_modalities: ["text"],
          },
          {
            id: "deepseek-v4-pro",
            object: "model",
            owned_by: "deepseek",
            context_window: 1048576,
            max_output_tokens: 393216,
            input_modalities: ["text"],
            output_modalities: ["text"],
          },
          { id: "mystery-model" }, // no limits, no modalities, no prices
          { id: 42 }, // malformed entry is skipped
        ],
      }),
    );
    const adapter = createDeepSeekAdapter({
      getApiKey: async () => TEST_KEY,
      fetchImpl,
    });
    const models = await adapter.listModels!();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(MODELS_URL);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${TEST_KEY}`);
    expect(models).toHaveLength(3);

    expect(models[0]).toMatchObject({
      provider: "deepseek",
      id: "deepseek-flash",
      input: ["text", "image"],
      output: ["text"],
      contextTokens: 1048576,
      maxOutputTokens: 393216,
      entitlement: "untested",
    });
    // The API carries no price fields: unknown price class, never 0, never free.
    expect(models[0]!.prices).toEqual([]);
    expect(models[0]!.priceClass).toBe("unknown");
    // Per-call image ceiling is not in /models either: unknown, not 0.
    expect(models[0]!.maxImagesPerCall).toBeUndefined();
    expect(typeof models[0]!.retrievedAt).toBe("string");

    // Unknown limits stay undefined (unknown), never zeroed.
    expect(models[2]!.contextTokens).toBeUndefined();
    expect(models[2]!.maxOutputTokens).toBeUndefined();
    expect(models[2]!.input).toEqual(["text"]);
    expect(models[2]!.prices).toEqual([]);
    expect(models[2]!.priceClass).toBe("unknown");
  });

  it("throws on non-OK models responses", async () => {
    const { fetchImpl } = makeFetchStub(jsonResponse({ error: "nope" }, 500));
    const adapter = createDeepSeekAdapter({
      getApiKey: async () => TEST_KEY,
      fetchImpl,
    });
    await expect(adapter.listModels!()).rejects.toThrow(
      /deepseek-models-http-500/,
    );
  });

  it("throws on an invalid models payload", async () => {
    const { fetchImpl } = makeFetchStub(jsonResponse({ nope: true }));
    const adapter = createDeepSeekAdapter({
      getApiKey: async () => TEST_KEY,
      fetchImpl,
    });
    await expect(adapter.listModels!()).rejects.toThrow(
      /deepseek-models-invalid/,
    );
  });
});

describe("deepseek hygiene", () => {
  it("never logs prompt, summary, photo or key content", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { fetchImpl } = makeFetchStub(
      streamResponse([
        enc.encode(
          'data: {"choices":[{"delta":{"content":"reply"}}]}\n\ndata: [DONE]\n\n',
        ),
      ]),
    );
    const adapter = createDeepSeekAdapter({
      getApiKey: async () => TEST_KEY,
      fetchImpl,
      resolveImageUrl: async (id: string) => `https://cdn.test/${id}.jpg`,
    });
    const { request } = baseRequest({
      summary: {
        schemaVersion: 1,
        coveredThroughTurnId: "t1",
        sourceTurnIds: ["t1"],
        summaryText: "SECRET-SUMMARY-CONTENT",
        generatedBy: "local-extractive",
        estimatedTokens: 4,
        updatedAt: "2026-09-25T00:00:00.000Z",
      },
      currentText: "SECRET-PROMPT-CONTENT",
      approvedImageIds: ["photo-1"],
    });
    const events = await collect(adapter.complete(request));

    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
    const dump = JSON.stringify(events);
    expect(dump).not.toContain("SECRET-PROMPT-CONTENT");
    expect(dump).not.toContain("SECRET-SUMMARY-CONTENT");
    expect(dump).not.toContain(TEST_KEY);
  });
});

describe("deepseek direct-key policy (BYOK, 2026-10-02 reversal)", () => {
  it("records the direct client-side key policy as allowed with reason, source and date", () => {
    expect(DIRECT_KEY_POLICY.status).toBe("allowed");
    expect(DIRECT_KEY_POLICY.reason.trim().length).toBeGreaterThan(0);
    expect(DIRECT_KEY_POLICY.sourceUrl.startsWith("https://")).toBe(true);
    expect(DIRECT_KEY_POLICY.retrievedAt.trim().length).toBeGreaterThan(0);
  });

  it("reports the direct-key entitlement as allowed for callers/UI", () => {
    expect(directKeyEntitlement()).toBe("allowed");
  });

  it("keeps the wire module free of proxy, embedded-key and base-URL-override routes", async () => {
    const source = await readFile(new URL("./deepseek.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/proxyUrl|baseUrl/i);
    expect(source).not.toMatch(/localhost|127\.0\.0\.1|0\.0\.0\.0/);
    expect(source).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(source).toMatch(/export const DEEPSEEK_API_ORIGIN/);
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
