/**
 * Cohere BYOK provider adapter tests (packet AI-020d).
 *
 * Fixtures are hand-built wire captures shaped by Cohere's OpenAI-compatible
 * Chat API v2 (`POST https://api.cohere.com/v2/chat`, `Authorization: Bearer
 * <key>`, SSE `data:` chunks with `choices[0].delta.content`, `data: [DONE]`
 * terminator, usage as `prompt_tokens` / `completion_tokens`).
 *
 * No real key is ever constructed or sent: `fetchImpl` is always stubbed, so
 * every live network path remains NOT TESTED LIVE until an owner key exists.
 * `listModels` is intentionally absent (unverified catalogue shape), so no
 * pricing is asserted anywhere in this file.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { COHERE_CHAT_URL, createCohereAdapter } from "./cohere";
import type {
  ChatCheckpoint,
  NormalizedRequest,
  ProviderId,
  StreamEvent,
} from "../providerContract";

/** Deliberately not a Cohere key shape — safe for a repo secret scan. */
const TEST_KEY = "test-key-not-a-real-cohere-credential";
const COHERE_PROVIDER = "cohere" as ProviderId;
const enc = new TextEncoder();

type FetchCall = { url: string; init: RequestInit };

function makeFetchStub(response: Response): {
  calls: FetchCall[];
  fetchImpl: typeof fetch;
} {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return response;
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
        provider: COHERE_PROVIDER,
        modelId: "command-r-plus",
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

function sseResponse(chunks: (string | Uint8Array)[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(
          typeof chunk === "string" ? enc.encode(chunk) : chunk,
        );
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** A response whose bytes we can push after construction (abort races). */
function pushableResponse(): {
  response: Response;
  push: (chunk: string | Uint8Array) => void;
  close: () => void;
} {
  let ctrl: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      ctrl = controller;
    },
  });
  return {
    response: new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }),
    push: (chunk) =>
      ctrl?.enqueue(typeof chunk === "string" ? enc.encode(chunk) : chunk),
    close: () => ctrl?.close(),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function collect(
  iterable: AsyncIterable<StreamEvent>,
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function texts(events: StreamEvent[]): string {
  return events
    .map((event) => (event.kind === "text" ? event.delta : ""))
    .join("");
}

function phases(events: StreamEvent[]): string[] {
  return events
    .filter((event) => event.kind === "phase")
    .map((event) => (event.kind === "phase" ? event.phase : ""));
}

/* ---- Cohere OpenAI-compatible SSE fixtures ---- */

function chunk(
  content: string | null,
  finishReason: string | null = null,
): string {
  return (
    `data: ${JSON.stringify({
      id: "chatcmpl-cohere-01",
      object: "chat.completion.chunk",
      created: 1790000000,
      model: "command-r-plus",
      choices: [
        {
          index: 0,
          delta:
            content === null ? {} : { role: "assistant", content },
          finish_reason: finishReason,
        },
      ],
    })}\n\n`
  );
}

function usageChunk(promptTokens: number, completionTokens: number): string {
  return (
    `data: ${JSON.stringify({
      id: "chatcmpl-cohere-01",
      object: "chat.completion.chunk",
      created: 1790000000,
      model: "command-r-plus",
      choices: [],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
      },
    })}\n\n`
  );
}

const DONE = "data: [DONE]\n\n";

function happyStream(delta = "Hi from Cohere"): string {
  return chunk(delta) + usageChunk(12, 7) + DONE;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("cohere capabilities", () => {
  it("reports known streaming and model-scoped facts as unknown, with no catalogue", () => {
    const adapter = createCohereAdapter({
      getApiKey: async () => TEST_KEY,
    });
    expect(adapter.id).toBe("cohere");
    const caps = adapter.capabilities();
    // Model-varying facts stay unknown — never 0 and never a free default.
    expect(caps.vision).toEqual({ state: "unknown" });
    expect(caps.maxImagesPerCall).toEqual({ state: "unknown" });
    expect(caps.contextTokens).toEqual({ state: "unknown" });
    expect(caps.maxOutputTokens).toEqual({ state: "unknown" });
    expect(caps.streaming).toEqual({ state: "known", value: true });
    // Unverified catalogue shape: no listModels, no invented pricing.
    expect(adapter.listModels).toBeUndefined();
  });
});

describe("cohere complete — official request wire format", () => {
  it("posts the Chat API v2 body with Bearer auth", async () => {
    const { calls, fetchImpl } = makeFetchStub(sseResponse([happyStream()]));
    const adapter = createCohereAdapter({
      getApiKey: async () => TEST_KEY,
      fetchImpl,
    });
    const { request } = baseRequest();
    const events = await collect(adapter.complete(request));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.cohere.com/v2/chat");
    expect(calls[0]!.url).toBe(COHERE_CHAT_URL);
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.signal).toBe(request.signal);

    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${TEST_KEY}`);
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["x-api-key"]).toBeUndefined();

    const raw = String(calls[0]!.init.body);
    const body = JSON.parse(raw) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "command-r-plus",
      max_tokens: 128,
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "user", content: "Hello" }],
    });
    // The key stays in headers only.
    expect(raw).not.toContain(TEST_KEY);

    expect(events.at(-1)).toMatchObject({
      kind: "done",
      stopReason: "complete",
    });
    expect(phases(events).slice(0, 2)).toEqual(["queued", "sending"]);
    expect(events.every((event) => event.attempt === 1)).toBe(true);
  });

  it("parses CRLF framing, split UTF-8, multiline data:, keepalives and usage", async () => {
    const fullText = "h\u00e9llo \u{1F30D}!";
    const payload = JSON.stringify({
      id: "chatcmpl-cohere-01",
      object: "chat.completion.chunk",
      created: 1790000000,
      model: "command-r-plus",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: fullText },
          finish_reason: null,
        },
      ],
    });
    // Multiline `data:` frame: continuation lines rejoin into one JSON
    // document; `\r\n` framing, keepalives and unknown fields are skipped.
    // Split at a structural boundary so the newline-joined frame stays valid.
    const boundary = payload.indexOf(',"choices"');
    expect(boundary).toBeGreaterThan(0);
    const mid = boundary;
    const sseText =
      ": cohere keepalive\r\n\r\n" +
      `data: ${payload.slice(0, mid)}\r\n` +
      `data: ${payload.slice(mid)}\r\n\r\n` +
      "event: ignored-field\r\n" +
      'data: {"id":"x","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":5}}\r\n\r\n' +
      "data: [DONE]\r\n\r\n";

    // Split inside the 4-byte emoji so the decoder must carry bytes across
    // network chunks.
    const bytes = enc.encode(sseText);
    const emojiFirstByte = enc.encode("\u{1F30D}")[0]!;
    const at = bytes.lastIndexOf(emojiFirstByte);
    expect(at).toBeGreaterThan(0);
    const splitAt = at + 2;

    const { fetchImpl } = makeFetchStub(
      sseResponse([bytes.slice(0, splitAt), bytes.slice(splitAt)]),
    );
    const adapter = createCohereAdapter({
      getApiKey: async () => TEST_KEY,
      fetchImpl,
    });
    const { request } = baseRequest();
    const events = await collect(adapter.complete(request));

    expect(texts(events)).toBe(fullText);
    expect(phases(events)).toEqual([
      "queued",
      "sending",
      "first-token",
      "complete",
    ]);
    expect(events.at(-1)).toMatchObject({
      kind: "done",
      stopReason: "complete",
    });
    const usageEvents = events.filter((event) => event.kind === "usage");
    expect(usageEvents.at(-1)).toMatchObject({
      kind: "usage",
      attempt: 1,
      inputTokens: 12,
      outputTokens: 5,
    });
  });

  it("accounts usage from the trailing usage chunk", async () => {
    const { fetchImpl } = makeFetchStub(sseResponse([happyStream("ok")]));
    const adapter = createCohereAdapter({
      getApiKey: async () => TEST_KEY,
      fetchImpl,
    });
    const { request } = baseRequest();
    const events = await collect(adapter.complete(request));

    const usageEvents = events.filter((event) => event.kind === "usage");
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({
      kind: "usage",
      attempt: 1,
      inputTokens: 12,
      outputTokens: 7,
    });
  });

  it("completes cleanly on EOF without a [DONE] terminator", async () => {
    const { fetchImpl } = makeFetchStub(
      sseResponse([chunk("trailing text") + usageChunk(3, 2)]),
    );
    const adapter = createCohereAdapter({
      getApiKey: async () => TEST_KEY,
      fetchImpl,
    });
    const { request } = baseRequest();
    const events = await collect(adapter.complete(request));

    expect(texts(events)).toBe("trailing text");
    expect(events.at(-1)).toMatchObject({
      kind: "done",
      stopReason: "complete",
    });
    expect(phases(events).at(-1)).toBe("complete");
  });
});

describe("cohere message mapping", () => {
  it("sends the summary as system and preserves turn order", async () => {
    const { calls, fetchImpl } = makeFetchStub(sseResponse([happyStream()]));
    const adapter = createCohereAdapter({
      getApiKey: async () => TEST_KEY,
      fetchImpl,
    });
    const summary: ChatCheckpoint = {
      schemaVersion: 1,
      coveredThroughTurnId: "turn-1",
      sourceTurnIds: ["turn-1"],
      summaryText: "User lost a grey cat near the park.",
      generatedBy: "local-extractive",
      estimatedTokens: 40,
      updatedAt: "2026-09-25T10:00:00.000Z",
    };
    const { request } = baseRequest({
      summary,
      recentTurns: [
        {
          id: "turn-1",
          role: "user",
          text: "My cat is missing",
          attachmentIds: [],
          createdAt: "2026-09-25T09:00:00.000Z",
        },
        {
          id: "turn-2",
          role: "assistant",
          text: "I can help.",
          attachmentIds: [],
          createdAt: "2026-09-25T09:01:00.000Z",
        },
      ],
      currentText: "Thanks",
    });
    await collect(adapter.complete(request));

    const body = JSON.parse(String(calls[0]!.init.body)) as {
      messages: { role: string; content: string | unknown[] }[];
    };
    expect(body.messages).toEqual([
      { role: "system", content: "User lost a grey cat near the park." },
      { role: "user", content: "My cat is missing" },
      { role: "assistant", content: "I can help." },
      { role: "user", content: "Thanks" },
    ]);
  });

  it("sends approved images as image_url parts, never dropping them", async () => {
    const resolved: string[] = [];
    const { calls, fetchImpl } = makeFetchStub(sseResponse([happyStream()]));
    const adapter = createCohereAdapter({
      getApiKey: async () => TEST_KEY,
      fetchImpl,
      resolveImageUrl: async (imageId: string) => {
        resolved.push(imageId);
        return `https://images.example/${imageId}.jpg`;
      },
    });
    const { request } = baseRequest({
      approvedImageIds: ["photo-1", "photo-2"],
    });
    await collect(adapter.complete(request));

    expect(resolved).toEqual(["photo-1", "photo-2"]);
    const body = JSON.parse(String(calls[0]!.init.body)) as {
      messages: { role: string; content: unknown[] }[];
    };
    const lastMessage = body.messages.at(-1)!;
    expect(lastMessage.role).toBe("user");
    expect(lastMessage.content).toEqual([
      { type: "text", text: "Hello" },
      {
        type: "image_url",
        image_url: { url: "https://images.example/photo-1.jpg" },
      },
      {
        type: "image_url",
        image_url: { url: "https://images.example/photo-2.jpg" },
      },
    ]);
  });

  it("never logs prompt or photo content through console", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

    const { fetchImpl } = makeFetchStub(
      sseResponse([happyStream("PROMPT_MARKER_REPLY")]),
    );
    const adapter = createCohereAdapter({
      getApiKey: async () => TEST_KEY,
      fetchImpl,
      resolveImageUrl: async () => "https://images.example/photo-1.jpg",
    });
    const { request } = baseRequest({
      currentText: "SECRET_PROMPT_MARKER",
      approvedImageIds: ["photo-1"],
    });
    await collect(adapter.complete(request));

    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it("scrubs the key when an upstream error body echoes it", async () => {
    const { fetchImpl } = makeFetchStub(
      jsonResponse(
        { error: { message: `bad key ${TEST_KEY} rejected` } },
        401,
      ),
    );
    const adapter = createCohereAdapter({
      getApiKey: async () => TEST_KEY,
      fetchImpl,
    });
    const { request } = baseRequest();
    const events = await collect(adapter.complete(request));

    expect(events.at(-2)).toMatchObject({
      kind: "error",
      code: "auth-invalid",
      retryable: false,
    });
    const message = (events.at(-2) as { message: string }).message;
    expect(message).not.toContain(TEST_KEY);
  });
});

describe("cohere complete — cancellation", () => {
  it("cancels without touching the network when the signal is already aborted", async () => {
    const { calls, fetchImpl } = makeFetchStub(sseResponse([happyStream()]));
    const adapter = createCohereAdapter({
      getApiKey: async () => TEST_KEY,
      fetchImpl,
    });
    const { controller, request } = baseRequest();
    controller.abort();
    const events = await collect(adapter.complete(request));

    expect(calls).toHaveLength(0);
    expect(phases(events).at(-1)).toBe("cancelled");
    expect(events.at(-1)).toMatchObject({
      kind: "done",
      stopReason: "cancelled",
    });
    expect(events.some((event) => event.kind === "error")).toBe(false);
  });

  it("stops reading after an abort and ignores late chunks", async () => {
    const { response, push, close } = pushableResponse();
    const { calls, fetchImpl } = makeFetchStub(response);
    const adapter = createCohereAdapter({
      getApiKey: async () => TEST_KEY,
      fetchImpl,
    });
    const { controller, request } = baseRequest();

    const iterator = adapter.complete(request)[Symbol.asyncIterator]();
    const seen: StreamEvent[] = [];
    const pull = async (): Promise<void> => {
      const next = await iterator.next();
      if (!next.done) seen.push(next.value);
    };

    await pull(); // queued
    await pull(); // sending
    push(chunk("first part"));
    // Drain until the text lands.
    for (let guard = 0; guard < 8 && texts(seen) === ""; guard += 1) {
      await pull();
    }
    expect(texts(seen)).toBe("first part");

    controller.abort();
    push(chunk("LATE CHUNK"));
    close();

    for (let guard = 0; guard < 50; guard += 1) {
      const next = await iterator.next();
      if (next.done) break;
      seen.push(next.value);
    }

    expect(texts(seen)).toBe("first part");
    expect(
      seen.some(
        (event) => event.kind === "phase" && event.phase === "cancelled",
      ),
    ).toBe(true);
    expect(seen.at(-1)).toMatchObject({
      kind: "done",
      stopReason: "cancelled",
    });
    expect(calls).toHaveLength(1);
  });
});

describe("cohere error mapping", () => {
  const cases = [
    { status: 400, code: "bad-request", retryable: false },
    { status: 401, code: "auth-invalid", retryable: false },
    { status: 403, code: "auth-forbidden", retryable: false },
    { status: 404, code: "not-found", retryable: false },
    { status: 429, code: "rate-limited", retryable: true },
    { status: 500, code: "provider-error", retryable: true },
    { status: 503, code: "provider-error", retryable: true },
  ] as const;

  for (const testCase of cases) {
    it(`maps HTTP ${testCase.status} to ${testCase.code} (retryable=${testCase.retryable})`, async () => {
      const { fetchImpl } = makeFetchStub(
        jsonResponse(
          { error: { message: `provider said ${testCase.code}` } },
          testCase.status,
        ),
      );
      const adapter = createCohereAdapter({
        getApiKey: async () => TEST_KEY,
        fetchImpl,
      });
      const { request } = baseRequest();
      const events = await collect(adapter.complete(request));

      expect(events.at(-2)).toMatchObject({
        kind: "error",
        attempt: 1,
        code: testCase.code,
        retryable: testCase.retryable,
        message: `provider said ${testCase.code}`,
      });
      expect(events.at(-3)).toMatchObject({
        kind: "phase",
        phase: "failed",
      });
      expect(events.at(-1)).toMatchObject({
        kind: "done",
        stopReason: "error",
      });
      expect(events.some((event) => event.kind === "text")).toBe(false);
      const message = (events.at(-2) as { message: string }).message;
      expect(message).not.toContain(TEST_KEY);
    });
  }

  it("maps an unrecognised HTTP status to request-failed, non-retryable", async () => {
    const { fetchImpl } = makeFetchStub(jsonResponse({ nope: true }, 418));
    const adapter = createCohereAdapter({
      getApiKey: async () => TEST_KEY,
      fetchImpl,
    });
    const { request } = baseRequest();
    const events = await collect(adapter.complete(request));
    expect(events.at(-2)).toMatchObject({
      kind: "error",
      code: "request-failed",
      retryable: false,
    });
  });

  it("maps a thrown fetch to a retryable network-error", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("network down");
    }) as typeof fetch;
    const adapter = createCohereAdapter({
      getApiKey: async () => TEST_KEY,
      fetchImpl,
    });
    const { request } = baseRequest();
    const events = await collect(adapter.complete(request));
    expect(events.at(-2)).toMatchObject({
      kind: "error",
      code: "network-error",
      retryable: true,
    });
    expect(events.at(-1)).toMatchObject({
      kind: "done",
      stopReason: "error",
    });
  });

  it("surfaces a mid-stream error event and stops the stream", async () => {
    const { fetchImpl } = makeFetchStub(
      sseResponse([
        chunk("partial answer") +
          `data: ${JSON.stringify({ error: { message: "Upstream blew up" } })}\n\n` +
          chunk("MUST NOT APPEAR"),
      ]),
    );
    const adapter = createCohereAdapter({
      getApiKey: async () => TEST_KEY,
      fetchImpl,
    });
    const { request } = baseRequest();
    const events = await collect(adapter.complete(request));

    expect(texts(events)).toBe("partial answer");
    // Mid-stream order is error, then failed phase, then done.
    expect(events.at(-3)).toMatchObject({
      kind: "error",
      code: "stream-error",
      retryable: false,
    });
    expect(events.at(-2)).toMatchObject({
      kind: "phase",
      phase: "failed",
    });
    expect(events.at(-1)).toMatchObject({
      kind: "done",
      stopReason: "error",
    });
    expect(phases(events).at(-1)).toBe("failed");
  });

  it("surfaces finish_reason error and stops the stream", async () => {
    const { fetchImpl } = makeFetchStub(
      sseResponse([
        chunk("partial answer") +
          chunk(null, "error") +
          chunk("MUST NOT APPEAR"),
      ]),
    );
    const adapter = createCohereAdapter({
      getApiKey: async () => TEST_KEY,
      fetchImpl,
    });
    const { request } = baseRequest();
    const events = await collect(adapter.complete(request));

    expect(texts(events)).toBe("partial answer");
    expect(events.at(-3)).toMatchObject({
      kind: "error",
      code: "stream-error",
      retryable: false,
    });
    expect(events.at(-2)).toMatchObject({
      kind: "phase",
      phase: "failed",
    });
    expect(events.at(-1)).toMatchObject({
      kind: "done",
      stopReason: "error",
    });
  });
});

describe("cohere preflight — rejects before any network call", () => {
  it("rejects a request addressed to another provider", async () => {
    const { calls, fetchImpl } = makeFetchStub(sseResponse([happyStream()]));
    const adapter = createCohereAdapter({
      getApiKey: async () => TEST_KEY,
      fetchImpl,
    });
    const { request } = baseRequest();
    request.selection.provider = "openai";
    const events = await collect(adapter.complete(request));
    expect(calls).toHaveLength(0);
    expect(events.at(-2)).toMatchObject({
      kind: "error",
      code: "invalid_provider",
      retryable: false,
    });
  });

  it("rejects inline image data URLs smuggled into id lists", async () => {
    const { calls, fetchImpl } = makeFetchStub(sseResponse([happyStream()]));
    const adapter = createCohereAdapter({
      getApiKey: async () => TEST_KEY,
      fetchImpl,
    });
    const { request } = baseRequest({
      approvedImageIds: ["data:image/png;base64,AAAA"],
    });
    const events = await collect(adapter.complete(request));
    expect(calls).toHaveLength(0);
    expect(events.at(-2)).toMatchObject({
      kind: "error",
      code: "request_not_allowed",
      retryable: false,
    });
  });

  it("refuses image ids when no resolver is configured", async () => {
    const { calls, fetchImpl } = makeFetchStub(sseResponse([happyStream()]));
    const adapter = createCohereAdapter({
      getApiKey: async () => TEST_KEY,
      fetchImpl,
    });
    const { request } = baseRequest({ approvedImageIds: ["photo-1"] });
    const events = await collect(adapter.complete(request));
    expect(calls).toHaveLength(0);
    expect(events.at(-2)).toMatchObject({
      kind: "error",
      code: "unsupported-images",
      retryable: false,
    });
  });

  it("reports an unresolvable image without retrying", async () => {
    const { calls, fetchImpl } = makeFetchStub(sseResponse([happyStream()]));
    const adapter = createCohereAdapter({
      getApiKey: async () => TEST_KEY,
      fetchImpl,
      resolveImageUrl: async () => null,
    });
    const { request } = baseRequest({ approvedImageIds: ["photo-1"] });
    const events = await collect(adapter.complete(request));
    expect(calls).toHaveLength(0);
    expect(events.at(-2)).toMatchObject({
      kind: "error",
      code: "unresolvable-image",
      retryable: false,
    });
  });

  it("reports a throwing image resolver as an unresolvable image", async () => {
    const { calls, fetchImpl } = makeFetchStub(sseResponse([happyStream()]));
    const adapter = createCohereAdapter({
      getApiKey: async () => TEST_KEY,
      fetchImpl,
      resolveImageUrl: async () => {
        throw new Error("media store unavailable");
      },
    });
    const { request } = baseRequest({ approvedImageIds: ["photo-1"] });
    const events = await collect(adapter.complete(request));
    expect(calls).toHaveLength(0);
    expect(events.at(-2)).toMatchObject({
      kind: "error",
      code: "unresolvable-image",
      retryable: false,
    });
    const message = (events.at(-2) as { message: string }).message;
    expect(message).not.toContain("media store unavailable");
  });

  it("reports a missing account key as a non-retryable error", async () => {
    const { calls, fetchImpl } = makeFetchStub(sseResponse([happyStream()]));
    const adapter = createCohereAdapter({
      getApiKey: async () => null,
      fetchImpl,
    });
    const { request } = baseRequest();
    const events = await collect(adapter.complete(request));
    expect(calls).toHaveLength(0);
    expect(events.at(-2)).toMatchObject({
      kind: "error",
      code: "auth-missing",
      retryable: false,
    });
    expect(events.at(-1)).toMatchObject({
      kind: "done",
      stopReason: "error",
    });
  });

  it("reports a credential read failure as a non-retryable error", async () => {
    const { calls, fetchImpl } = makeFetchStub(sseResponse([happyStream()]));
    const adapter = createCohereAdapter({
      getApiKey: async () => {
        throw new Error("vault locked");
      },
      fetchImpl,
    });
    const { request } = baseRequest();
    const events = await collect(adapter.complete(request));
    expect(calls).toHaveLength(0);
    expect(events.at(-2)).toMatchObject({
      kind: "error",
      code: "credential_unavailable",
      retryable: false,
    });
    const message = (events.at(-2) as { message: string }).message;
    expect(message).not.toContain("vault locked");
    expect(message).not.toContain(TEST_KEY);
  });

  it("rejects a request that carries no message content at all", async () => {
    const { calls, fetchImpl } = makeFetchStub(sseResponse([happyStream()]));
    const adapter = createCohereAdapter({
      getApiKey: async () => TEST_KEY,
      fetchImpl,
    });
    const { request } = baseRequest({ currentText: "   " });
    const events = await collect(adapter.complete(request));
    expect(calls).toHaveLength(0);
    expect(events.at(-2)).toMatchObject({
      kind: "error",
      code: "no_messages",
      retryable: false,
    });
  });
});
