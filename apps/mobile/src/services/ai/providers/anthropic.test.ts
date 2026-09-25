/**
 * Anthropic BYOK provider adapter tests (packet P-anthropic / P3).
 *
 * Fixtures are hand-built wire captures shaped by the official Anthropic
 * docs verified on 2026-09-25 (Messages API, streaming events, vision image
 * blocks, error envelope — see temp-Com/P-anthropic.log.md for URLs).
 *
 * No real key is ever constructed or sent: `fetchImpl` is always stubbed, so
 * every live network path remains NOT TESTED LIVE until an owner key exists.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ANTHROPIC_MESSAGES_URL, createAnthropicAdapter } from "./anthropic";
import type { AnthropicImagePayload } from "./anthropic";
import type { ChatCheckpoint, NormalizedRequest, StreamEvent } from "../providerContract";

/** Deliberately not an Anthropic key shape — safe for a repo secret scan. */
const TEST_KEY = "test-key-not-a-real-anthropic-credential";
const ANTHROPIC_VERSION = "2023-06-01";
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
        provider: "anthropic",
        modelId: "claude-sonnet-5",
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
    push: (chunk) => ctrl?.enqueue(typeof chunk === "string" ? enc.encode(chunk) : chunk),
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

/* ---- Anthropic SSE fixtures (official event names, 2026-09-25 docs) ---- */

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function messageStart(inputTokens = 42): string {
  return frame("message_start", {
    type: "message_start",
    message: {
      id: "msg_01",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    },
  });
}

function contentBlockStart(): string {
  return frame("content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });
}

function textDelta(text: string): string {
  return frame("content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text },
  });
}

function contentBlockStop(): string {
  return frame("content_block_stop", { type: "content_block_stop", index: 0 });
}

function messageDelta(stopReason: string, outputTokens: number): string {
  return frame("message_delta", {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens },
  });
}

const MESSAGE_STOP = "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n";

function happyStream(delta = "Hi from Claude"): string {
  return (
    messageStart() +
    contentBlockStart() +
    textDelta(delta) +
    contentBlockStop() +
    messageDelta("end_turn", 7) +
    MESSAGE_STOP
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("anthropic capabilities", () => {
  it("reports known vision/streaming and model-scoped limits as unknown", () => {
    const adapter = createAnthropicAdapter({
      getApiKey: async () => TEST_KEY,
    });
    expect(adapter.id).toBe("anthropic");
    const caps = adapter.capabilities();
    expect(caps.vision).toEqual({ state: "known", value: true });
    // Documented per-request floor across current Claude models (vision docs).
    expect(caps.maxImagesPerCall).toEqual({ state: "known", value: 100 });
    // Context/output windows are model-scoped, so they stay unknown —
    // never 0 and never a free default.
    expect(caps.contextTokens).toEqual({ state: "unknown" });
    expect(caps.maxOutputTokens).toEqual({ state: "unknown" });
    expect(caps.streaming).toEqual({ state: "known", value: true });
    // No hardcoded catalogue: prices/limits come from the catalog packet.
    expect(adapter.listModels).toBeUndefined();
  });
});

describe("anthropic complete — official request wire format", () => {
  it("posts the Anthropic Messages body with Anthropic headers and auth", async () => {
    const { calls, fetchImpl } = makeFetchStub(sseResponse([happyStream()]));
    const adapter = createAnthropicAdapter({
      getApiKey: async () => TEST_KEY,
      fetchImpl,
      buildSystemText: () => "IMMUTABLE SYSTEM RULES",
    });
    const { request } = baseRequest();
    const events = await collect(adapter.complete(request));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0]!.url).toBe(ANTHROPIC_MESSAGES_URL);
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.signal).toBe(request.signal);

    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe(TEST_KEY);
    expect(headers["anthropic-version"]).toBe(ANTHROPIC_VERSION);
    expect(headers["content-type"]).toBe("application/json");
    // Required for a browser/WebView origin, inert otherwise.
    expect(headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
    expect(headers["authorization"]).toBeUndefined();

    const raw = String(calls[0]!.init.body);
    const body = JSON.parse(raw) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "claude-sonnet-5",
      max_tokens: 128,
      stream: true,
      system: "IMMUTABLE SYSTEM RULES",
      messages: [{ role: "user", content: "Hello" }],
    });
    // Never the generic OpenAI multimodal/Chat Completions payload.
    expect(raw).not.toContain("image_url");
    expect(raw).not.toContain("chat/completions");
    expect(raw).not.toContain("maxCompletionTokens");
    // The key stays in headers only.
    expect(raw).not.toContain(TEST_KEY);

    expect(events.at(-1)).toMatchObject({
      kind: "done",
      stopReason: "complete",
    });
    expect(phases(events).slice(0, 2)).toEqual(["queued", "sending"]);
    expect(events.every((event) => event.attempt === 1)).toBe(true);
  });

  it("parses CRLF framing, split UTF-8, multiline data:, keepalives and ping", async () => {
    const fullText = "h\u00e9llo \u{1F30D}";
    // Multiline `data:` frame: two data lines joined with a newline are one
    // JSON document per the SSE spec.
    const sseText =
      ": anthropic keepalive\r\n\r\n" +
      messageStart().replace(/\n/g, "\r\n") +
      "event: ping\r\n" +
      'data: {"type":"ping"}\r\n\r\n' +
      contentBlockStart().replace(/\n/g, "\r\n") +
      "event: content_block_delta\r\n" +
      'data: {"type":"content_block_delta",\r\n' +
      `data: "index":0,"delta":{"type":"text_delta","text":"${fullText}"}}\r\n\r\n` +
      contentBlockStop().replace(/\n/g, "\r\n") +
      messageDelta("end_turn", 3).replace(/\n/g, "\r\n") +
      MESSAGE_STOP.replace(/\n/g, "\r\n");

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
    const adapter = createAnthropicAdapter({
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
      "streaming",
      "complete",
    ]);
    expect(events.at(-1)).toMatchObject({
      kind: "done",
      stopReason: "complete",
    });
  });

  it("accounts usage from message_start.input_tokens then message_delta.output_tokens", async () => {
    const { fetchImpl } = makeFetchStub(
      sseResponse([happyStream("ok")]),
    );
    const adapter = createAnthropicAdapter({
      getApiKey: async () => TEST_KEY,
      fetchImpl,
    });
    const { request } = baseRequest();
    const events = await collect(adapter.complete(request));

    const usageEvents = events.filter((event) => event.kind === "usage");
    expect(usageEvents.length).toBeGreaterThanOrEqual(2);
    expect(usageEvents[0]).toMatchObject({
      kind: "usage",
      attempt: 1,
      inputTokens: 42,
    });
    const last = usageEvents.at(-1);
    expect(last).toMatchObject({
      kind: "usage",
      attempt: 1,
      inputTokens: 42,
      outputTokens: 7,
    });
  });

});

describe("anthropic message mapping", () => {
  it("keeps summary out of system and merges consecutive same-role turns", async () => {
    const { calls, fetchImpl } = makeFetchStub(sseResponse([happyStream()]));
    const adapter = createAnthropicAdapter({
      getApiKey: async () => TEST_KEY,
      fetchImpl,
      buildSystemText: () => "IMMUTABLE SYSTEM RULES",
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
          role: "user",
          text: "Second question",
          attachmentIds: [],
          createdAt: "2026-09-25T09:01:00.000Z",
        },
        {
          id: "turn-3",
          role: "assistant",
          text: "I can help.",
          attachmentIds: [],
          createdAt: "2026-09-25T09:02:00.000Z",
        },
      ],
      currentText: "Thanks",
    });
    await collect(adapter.complete(request));

    const body = JSON.parse(String(calls[0]!.init.body)) as {
      system: string;
      messages: { role: string; content: string | unknown[] }[];
    };
    expect(body.system).toBe("IMMUTABLE SYSTEM RULES");
    expect(body.system).not.toContain("grey cat");

    expect(body.messages).toHaveLength(3);
    expect(body.messages[0]!.role).toBe("user");
    const first = String(body.messages[0]!.content);
    expect(first).toContain("Conversation summary");
    expect(first).toContain("User lost a grey cat near the park.");
    expect(first).toContain("My cat is missing");
    // Consecutive user turns merged: Anthropic needs strict alternation.
    expect(first).toContain("Second question");
    expect(body.messages[1]).toEqual({
      role: "assistant",
      content: "I can help.",
    });
    expect(body.messages[2]).toEqual({ role: "user", content: "Thanks" });
  });

  it("sends Anthropic base64 image blocks, never an OpenAI image_url part", async () => {
    const resolved: string[] = [];
    const { calls, fetchImpl } = makeFetchStub(sseResponse([happyStream()]));
    const adapter = createAnthropicAdapter({
      getApiKey: async () => TEST_KEY,
      fetchImpl,
      resolveImage: async (imageId: string) => {
        resolved.push(imageId);
        return { mediaType: "image/jpeg", base64Data: "SU1BR0U=" };
      },
    });
    const { request } = baseRequest({
      approvedImageIds: ["photo-1", "photo-2"],
    });
    await collect(adapter.complete(request));

    expect(resolved).toEqual(["photo-1", "photo-2"]);
    const raw = String(calls[0]!.init.body);
    expect(raw).not.toContain("image_url");
    const body = JSON.parse(raw) as {
      messages: { role: string; content: unknown[] }[];
    };
    const lastMessage = body.messages.at(-1)!;
    expect(lastMessage.role).toBe("user");
    expect(lastMessage.content).toEqual([
      { type: "text", text: "Hello" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: "SU1BR0U=" },
      },
      {
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: "SU1BR0U=" },
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
    const adapter = createAnthropicAdapter({
      getApiKey: async () => TEST_KEY,
      fetchImpl,
      resolveImage: async () => ({ mediaType: "image/png", base64Data: "UE5H" }),
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
});

describe("anthropic complete — cancellation", () => {
  it("cancels without touching the network when the signal is already aborted", async () => {
    const { calls, fetchImpl } = makeFetchStub(sseResponse([happyStream()]));
    const adapter = createAnthropicAdapter({
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
    const adapter = createAnthropicAdapter({
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
    push(messageStart() + contentBlockStart() + textDelta("first part"));
    // message_start also yields a usage event, so drain until the text lands.
    for (let guard = 0; guard < 8 && texts(seen) === ""; guard += 1) {
      await pull();
    }
    expect(texts(seen)).toBe("first part");

    controller.abort();
    push(textDelta("LATE CHUNK"));
    close();

    for (let guard = 0; guard < 50; guard += 1) {
      const next = await iterator.next();
      if (next.done) break;
      seen.push(next.value);
    }

    expect(texts(seen)).toBe("first part");
    expect(seen.some((event) => event.kind === "phase" && event.phase === "cancelled")).toBe(
      true,
    );
    expect(seen.at(-1)).toMatchObject({
      kind: "done",
      stopReason: "cancelled",
    });
    expect(calls).toHaveLength(1);
  });
});

describe("anthropic error mapping", () => {
  const cases = [
    { status: 400, type: "invalid_request_error", retryable: false },
    { status: 401, type: "authentication_error", retryable: false },
    { status: 402, type: "billing_error", retryable: false },
    { status: 403, type: "permission_error", retryable: false },
    { status: 404, type: "not_found_error", retryable: false },
    { status: 413, type: "request_too_large", retryable: false },
    { status: 429, type: "rate_limit_error", retryable: true },
    { status: 500, type: "api_error", retryable: true },
    { status: 529, type: "overloaded_error", retryable: true },
  ] as const;

  for (const testCase of cases) {
    it(`maps HTTP ${testCase.status} to ${testCase.type} (retryable=${testCase.retryable})`, async () => {
      const { fetchImpl } = makeFetchStub(
        jsonResponse(
          {
            type: "error",
            error: { type: testCase.type, message: `provider said ${testCase.type}` },
          },
          testCase.status,
        ),
      );
      const adapter = createAnthropicAdapter({
        getApiKey: async () => TEST_KEY,
        fetchImpl,
      });
      const { request } = baseRequest();
      const events = await collect(adapter.complete(request));

      expect(events.at(-2)).toMatchObject({
        kind: "error",
        attempt: 1,
        code: testCase.type,
        retryable: testCase.retryable,
        message: `provider said ${testCase.type}`,
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

  it("maps an unrecognised HTTP status to http_<status>, non-retryable", async () => {
    const { fetchImpl } = makeFetchStub(jsonResponse({ nope: true }, 418));
    const adapter = createAnthropicAdapter({
      getApiKey: async () => TEST_KEY,
      fetchImpl,
    });
    const { request } = baseRequest();
    const events = await collect(adapter.complete(request));
    expect(events.at(-2)).toMatchObject({
      kind: "error",
      code: "http_418",
      retryable: false,
    });
  });

  it("maps a thrown fetch to a retryable network_error", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("network down");
    }) as typeof fetch;
    const adapter = createAnthropicAdapter({
      getApiKey: async () => TEST_KEY,
      fetchImpl,
    });
    const { request } = baseRequest();
    const events = await collect(adapter.complete(request));
    expect(events.at(-2)).toMatchObject({
      kind: "error",
      code: "network_error",
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
        messageStart() +
          contentBlockStart() +
          textDelta("partial answer") +
          frame("error", {
            type: "error",
            error: { type: "overloaded_error", message: "Overloaded" },
          }) +
          textDelta("MUST NOT APPEAR"),
      ]),
    );
    const adapter = createAnthropicAdapter({
      getApiKey: async () => TEST_KEY,
      fetchImpl,
    });
    const { request } = baseRequest();
    const events = await collect(adapter.complete(request));

    expect(texts(events)).toBe("partial answer");
    expect(events.at(-2)).toMatchObject({
      kind: "error",
      code: "overloaded_error",
      retryable: true,
    });
    expect(events.at(-1)).toMatchObject({
      kind: "done",
      stopReason: "error",
    });
    expect(phases(events).at(-1)).toBe("failed");
  });

  it("treats a stream that never reaches message_stop as truncated", async () => {
    const { fetchImpl } = makeFetchStub(
      sseResponse([
        messageStart() +
          contentBlockStart() +
          textDelta("cut short") +
          contentBlockStop(),
      ]),
    );
    const adapter = createAnthropicAdapter({
      getApiKey: async () => TEST_KEY,
      fetchImpl,
    });
    const { request } = baseRequest();
    const events = await collect(adapter.complete(request));

    expect(texts(events)).toBe("cut short");
    expect(events.at(-2)).toMatchObject({
      kind: "error",
      code: "stream_truncated",
      retryable: true,
    });
    expect(events.at(-1)).toMatchObject({
      kind: "done",
      stopReason: "error",
    });
  });
});

describe("anthropic preflight — rejects before any network call", () => {
  it("rejects a request addressed to another provider", async () => {
    const { calls, fetchImpl } = makeFetchStub(sseResponse([happyStream()]));
    const adapter = createAnthropicAdapter({
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
    const adapter = createAnthropicAdapter({
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

  it("rejects more images than the documented per-call capability", async () => {
    const { calls, fetchImpl } = makeFetchStub(sseResponse([happyStream()]));
    let resolvedCount = 0;
    const adapter = createAnthropicAdapter({
      getApiKey: async () => TEST_KEY,
      fetchImpl,
      resolveImage: async () => {
        resolvedCount += 1;
        return { mediaType: "image/jpeg", base64Data: "QQ==" };
      },
    });
    const approvedImageIds = Array.from(
      { length: 101 },
      (_, index) => `photo-${index}`,
    );
    const { request } = baseRequest({ approvedImageIds });
    const events = await collect(adapter.complete(request));

    const caps = adapter.capabilities();
    expect(caps.maxImagesPerCall).toEqual({ state: "known", value: 100 });
    expect(calls).toHaveLength(0);
    expect(resolvedCount).toBe(0);
    expect(events.at(-2)).toMatchObject({
      kind: "error",
      code: "image_count_exceeded",
      retryable: false,
    });
  });

  it("refuses image ids when no resolver is configured", async () => {
    const { calls, fetchImpl } = makeFetchStub(sseResponse([happyStream()]));
    const adapter = createAnthropicAdapter({
      getApiKey: async () => TEST_KEY,
      fetchImpl,
    });
    const { request } = baseRequest({ approvedImageIds: ["photo-1"] });
    const events = await collect(adapter.complete(request));
    expect(calls).toHaveLength(0);
    expect(events.at(-2)).toMatchObject({
      kind: "error",
      code: "image_resolver_missing",
      retryable: false,
    });
  });

  it("rejects an unsupported image media type", async () => {
    const { calls, fetchImpl } = makeFetchStub(sseResponse([happyStream()]));
    const adapter = createAnthropicAdapter({
      getApiKey: async () => TEST_KEY,
      fetchImpl,
      resolveImage: async () =>
        ({
          mediaType: "image/tiff",
          base64Data: "VElGRg==",
        }) as unknown as AnthropicImagePayload,
    });
    const { request } = baseRequest({ approvedImageIds: ["photo-1"] });
    const events = await collect(adapter.complete(request));
    expect(calls).toHaveLength(0);
    expect(events.at(-2)).toMatchObject({
      kind: "error",
      code: "unsupported_image_media_type",
      retryable: false,
    });
  });

  it("reports a throwing image resolver as a resolve failure", async () => {
    const { calls, fetchImpl } = makeFetchStub(sseResponse([happyStream()]));
    const adapter = createAnthropicAdapter({
      getApiKey: async () => TEST_KEY,
      fetchImpl,
      resolveImage: async () => {
        throw new Error("media store unavailable");
      },
    });
    const { request } = baseRequest({ approvedImageIds: ["photo-1"] });
    const events = await collect(adapter.complete(request));
    expect(calls).toHaveLength(0);
    expect(events.at(-2)).toMatchObject({
      kind: "error",
      code: "image_resolve_failed",
      retryable: false,
    });
    const message = (events.at(-2) as { message: string }).message;
    expect(message).not.toContain("media store unavailable");
  });

  it("reports a missing account key as a non-retryable error", async () => {
    const { calls, fetchImpl } = makeFetchStub(sseResponse([happyStream()]));
    const adapter = createAnthropicAdapter({
      getApiKey: async () => null,
      fetchImpl,
    });
    const { request } = baseRequest();
    const events = await collect(adapter.complete(request));
    expect(calls).toHaveLength(0);
    expect(events.at(-2)).toMatchObject({
      kind: "error",
      code: "missing_api_key",
      retryable: false,
    });
    expect(events.at(-1)).toMatchObject({
      kind: "done",
      stopReason: "error",
    });
  });

  it("reports a credential read failure as a non-retryable error", async () => {
    const { calls, fetchImpl } = makeFetchStub(sseResponse([happyStream()]));
    const adapter = createAnthropicAdapter({
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

  it("rejects a non-positive maxOutputTokens bound", async () => {
    const { calls, fetchImpl } = makeFetchStub(sseResponse([happyStream()]));
    const adapter = createAnthropicAdapter({
      getApiKey: async () => TEST_KEY,
      fetchImpl,
    });
    const { request } = baseRequest({ maxOutputTokens: 0 });
    const events = await collect(adapter.complete(request));
    expect(calls).toHaveLength(0);
    expect(events.at(-2)).toMatchObject({
      kind: "error",
      code: "invalid_max_output_tokens",
      retryable: false,
    });
  });

  it("rejects an assistant-first turn sequence Anthropic cannot accept", async () => {
    const { calls, fetchImpl } = makeFetchStub(sseResponse([happyStream()]));
    const adapter = createAnthropicAdapter({
      getApiKey: async () => TEST_KEY,
      fetchImpl,
    });
    const { request } = baseRequest({
      recentTurns: [
        {
          id: "turn-1",
          role: "assistant",
          text: "I spoke first",
          attachmentIds: [],
          createdAt: "2026-09-25T09:00:00.000Z",
        },
      ],
      currentText: "",
    });
    const events = await collect(adapter.complete(request));
    expect(calls).toHaveLength(0);
    expect(events.at(-2)).toMatchObject({
      kind: "error",
      code: "invalid_message_sequence",
      retryable: false,
    });
  });

  it("rejects a request that carries no message content at all", async () => {
    const { calls, fetchImpl } = makeFetchStub(sseResponse([happyStream()]));
    const adapter = createAnthropicAdapter({
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
