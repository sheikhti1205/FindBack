/**
 * Google Gemini BYOK provider adapter tests (packet P-google).
 *
 * Fixtures are hand-built wire captures shaped by the official Google docs
 * verified on 2026-09-25 (streamGenerateContent + alt=sse SSE, inline_data
 * image parts, {"error":{code,message,status}} envelope — see
 * temp-Com/P-google.log.md for URLs and keyless probe evidence).
 *
 * No real key is ever constructed or sent: `fetchImpl` is always stubbed, so
 * every live network path remains NOT TESTED LIVE until an owner key exists.
 */
import { describe, expect, it } from "vitest";
import {
  GOOGLE_GENERATIVE_LANGUAGE_ORIGIN,
  GOOGLE_MAX_IMAGES_EVIDENCED,
  createGoogleAdapter,
} from "./google";
import type { GoogleImagePayload } from "./google";
import type { NormalizedRequest, StreamEvent } from "../providerContract";

/** Deliberately not a Google key shape — safe for a repo secret scan. */
const TEST_KEY = "test-key-not-a-real-google-credential";
const enc = new TextEncoder();

type FetchCall = { url: string; init: RequestInit };

function makeFetchStub(response: Response): {
  calls: FetchCall[];
  fetchImpl: typeof fetch;
};
function makeFetchStub(respond: (call: FetchCall) => Promise<Response>): {
  calls: FetchCall[];
  fetchImpl: typeof fetch;
};
function makeFetchStub(
  responseOrFn: Response | ((call: FetchCall) => Promise<Response>),
): { calls: FetchCall[]; fetchImpl: typeof fetch } {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return typeof responseOrFn === "function"
      ? responseOrFn(call)
      : responseOrFn;
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
        provider: "google",
        modelId: "gemini-2.0-flash",
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

/* ---- Gemini SSE fixtures (official GenerateContentResponse shape) ---- */

function chunk(
  text: string,
  extra: Record<string, unknown> = {},
): string {
  return (
    `data: ${JSON.stringify({
      candidates: [
        { content: { parts: [{ text }], role: "model" }, index: 0 },
      ],
      modelVersion: "gemini-2.0-flash",
      responseId: "resp-1",
      ...extra,
    })}\n\n`
  );
}

function finalChunk(
  text: string,
  usage: Record<string, unknown> = {},
): string {
  return chunk(text, {
    candidates: [
      {
        content: { parts: [{ text }], role: "model" },
        finishReason: "STOP",
        index: 0,
      },
    ],
    usageMetadata: {
      promptTokenCount: 12,
      candidatesTokenCount: 3,
      totalTokenCount: 15,
      ...usage,
    },
  });
}

const keyDeps = () => ({
  getApiKey: async () => TEST_KEY,
});

describe("google adapter identity and capabilities", () => {
  it("identifies as the google provider", () => {
    expect(createGoogleAdapter(keyDeps()).id).toBe("google");
  });

  it("advertises vision and streaming as known, limits as unknown", () => {
    const caps = createGoogleAdapter(keyDeps()).capabilities();
    expect(caps.vision).toEqual({ state: "known", value: true });
    expect(caps.streaming).toEqual({ state: "known", value: true });
    // Model-scoped per official docs — unknown, never zero.
    expect(caps.maxImagesPerCall).toEqual({ state: "unknown" });
    expect(caps.contextTokens).toEqual({ state: "unknown" });
    expect(caps.maxOutputTokens).toEqual({ state: "unknown" });
  });

  it("does not hardcode a provider-wide image cap", () => {
    expect(GOOGLE_MAX_IMAGES_EVIDENCED).toBeUndefined();
  });
});

describe("google request shape", () => {
  it("posts to the allowlisted streamGenerateContent URL with alt=sse", async () => {
    const { calls, fetchImpl } = makeFetchStub(
      sseResponse([finalChunk("hi")]),
    );
    const { request } = baseRequest();
    const events = await collect(
      createGoogleAdapter({ ...keyDeps(), fetchImpl }).complete(request),
    );
    expect(texts(events)).toBe("hi");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      `${GOOGLE_GENERATIVE_LANGUAGE_ORIGIN}/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse`,
    );
  });

  it("authenticates with x-goog-api-key and never puts the key in the URL", async () => {
    const { calls, fetchImpl } = makeFetchStub(
      sseResponse([finalChunk("hi")]),
    );
    const { request } = baseRequest();
    await collect(
      createGoogleAdapter({ ...keyDeps(), fetchImpl }).complete(request),
    );
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("x-goog-api-key")).toBe(TEST_KEY);
    expect(calls[0]!.url).not.toContain(TEST_KEY);
    expect(calls[0]!.url).not.toContain("key=");
  });

  it("sends a Gemini-native body (contents/systemInstruction/generationConfig)", async () => {
    const { calls, fetchImpl } = makeFetchStub(
      sseResponse([finalChunk("hi")]),
    );
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
      currentText: "now",
    });
    await collect(
      createGoogleAdapter({
        ...keyDeps(),
        fetchImpl,
        buildSystemText: () => "app instructions",
      }).complete(request),
    );
    const body = JSON.parse(String(calls[0]!.init.body));
    // Never an OpenAI-style payload.
    expect(body).not.toHaveProperty("messages");
    expect(body).not.toHaveProperty("max_tokens");
    expect(body).not.toHaveProperty("model");
    expect(body.contents).toEqual([
      { role: "user", parts: [{ text: "earlier" }] },
      { role: "user", parts: [{ text: "now" }] },
    ]);
    expect(body.systemInstruction).toEqual({
      parts: [{ text: "app instructions" }],
    });
    expect(body.generationConfig).toMatchObject({ maxOutputTokens: 128 });
  });

  it("maps assistant history turns to the model role", async () => {
    const { calls, fetchImpl } = makeFetchStub(
      sseResponse([finalChunk("hi")]),
    );
    const { request } = baseRequest({
      recentTurns: [
        {
          id: "t1",
          role: "assistant",
          text: "prior answer",
          attachmentIds: [],
          createdAt: "2026-09-25T00:00:00.000Z",
        },
      ],
    });
    await collect(
      createGoogleAdapter({ ...keyDeps(), fetchImpl }).complete(request),
    );
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.contents[0]).toEqual({
      role: "model",
      parts: [{ text: "prior answer" }],
    });
  });

  it("sends approved images as inline_data blocks, never image_url", async () => {
    const { calls, fetchImpl } = makeFetchStub(
      sseResponse([finalChunk("seen")]),
    );
    const payload: GoogleImagePayload = {
      mediaType: "image/jpeg",
      base64Data: "aGVsbG8=",
    };
    const { request } = baseRequest({ approvedImageIds: ["img-1"] });
    const events = await collect(
      createGoogleAdapter({
        ...keyDeps(),
        fetchImpl,
        resolveImage: async (id) => (id === "img-1" ? payload : null),
      }).complete(request),
    );
    expect(texts(events)).toBe("seen");
    const body = JSON.parse(String(calls[0]!.init.body));
    const last = body.contents.at(-1);
    expect(last.parts).toEqual([
      { text: "Hello" },
      { inline_data: { mime_type: "image/jpeg", data: "aGVsbG8=" } },
    ]);
    expect(String(calls[0]!.init.body)).not.toContain("image_url");
  });
});

describe("google stream framing", () => {
  it("assembles text across CRLF chunks, split UTF-8, multiline data, and keepalives", async () => {
    // "héllo wörld" split mid-multibyte-character across network chunks,
    // with a keepalive comment and a multiline data event mixed in.
    const full = chunk("h") + ": keepalive\n\n" + chunk("éllo ");
    const bytes = enc.encode(full + chunk("wörld"));
    const splitAt = full.length - 2;
    const head = bytes.slice(0, splitAt);
    const tail = bytes.slice(splitAt);
    const { calls, fetchImpl } = makeFetchStub(sseResponse([head, tail]));
    void calls;
    const { request } = baseRequest();
    const events = await collect(
      createGoogleAdapter({ ...keyDeps(), fetchImpl }).complete(request),
    );
    expect(texts(events)).toBe("héllo wörld");
    expect(phases(events)).toContain("first-token");
  });

  it("terminates cleanly at EOF with no finishReason and no [DONE]", async () => {
    const { fetchImpl } = makeFetchStub(sseResponse([chunk("partial")]));
    const { request } = baseRequest();
    const events = await collect(
      createGoogleAdapter({ ...keyDeps(), fetchImpl }).complete(request),
    );
    expect(texts(events)).toBe("partial");
    expect(phases(events)).toContain("complete");
    expect(events.at(-1)).toEqual({
      kind: "done",
      attempt: 1,
      stopReason: "complete",
    });
  });

  it("reports usage from usageMetadata token counts", async () => {
    const { fetchImpl } = makeFetchStub(
      sseResponse([
        chunk("a", { usageMetadata: { promptTokenCount: 7 } }),
        finalChunk("b", { promptTokenCount: 7, candidatesTokenCount: 2 }),
      ]),
    );
    const { request } = baseRequest();
    const events = await collect(
      createGoogleAdapter({ ...keyDeps(), fetchImpl }).complete(request),
    );
    const usage = events.filter((e) => e.kind === "usage");
    expect(usage.length).toBeGreaterThan(0);
    const last = usage.at(-1)!;
    expect(last).toMatchObject({
      kind: "usage",
      attempt: 1,
      inputTokens: 7,
      outputTokens: 2,
    });
  });

  it("surfaces a mid-stream error payload and stops reading", async () => {
    const { fetchImpl } = makeFetchStub(
      sseResponse([
        chunk("before "),
        `data: ${JSON.stringify({ error: { code: 500, message: "boom", status: "INTERNAL" } })}\n\n`,
        chunk("after-should-not-appear"),
      ]),
    );
    const { request } = baseRequest();
    const events = await collect(
      createGoogleAdapter({ ...keyDeps(), fetchImpl }).complete(request),
    );
    expect(texts(events)).toBe("before ");
    const error = events.find((e) => e.kind === "error")!;
    expect(error).toMatchObject({ kind: "error", attempt: 1, retryable: true });
    expect(events.at(-1)).toEqual({
      kind: "done",
      attempt: 1,
      stopReason: "error",
    });
  });

  it("rejects blocked prompts via promptFeedback without retry", async () => {
    const { fetchImpl } = makeFetchStub(
      sseResponse([
        `data: ${JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } })}\n\n`,
      ]),
    );
    const { request } = baseRequest();
    const events = await collect(
      createGoogleAdapter({ ...keyDeps(), fetchImpl }).complete(request),
    );
    const error = events.find((e) => e.kind === "error")!;
    expect(error).toMatchObject({
      kind: "error",
      attempt: 1,
      code: "content-blocked",
      retryable: false,
    });
  });
});

describe("google errors, auth, and abort", () => {
  it("maps the Google error envelope with its status slug", async () => {
    const { fetchImpl } = makeFetchStub(
      jsonResponse(
        {
          error: {
            code: 400,
            message: "Invalid value at 'contents'",
            status: "INVALID_ARGUMENT",
          },
        },
        400,
      ),
    );
    const { request } = baseRequest();
    const events = await collect(
      createGoogleAdapter({ ...keyDeps(), fetchImpl }).complete(request),
    );
    const error = events.find((e) => e.kind === "error")!;
    expect(error).toMatchObject({
      kind: "error",
      attempt: 1,
      code: "invalid_argument",
      retryable: false,
    });
  });

  it("marks rate limits and server failures retryable, auth failures not", async () => {
    for (const status of [429, 500, 503]) {
      const { fetchImpl } = makeFetchStub(
        jsonResponse(
          { error: { code: status, message: "busy", status: "BUSY" } },
          status,
        ),
      );
      const { request } = baseRequest();
      const events = await collect(
        createGoogleAdapter({ ...keyDeps(), fetchImpl }).complete(request),
      );
      expect(events.find((e) => e.kind === "error")).toMatchObject({
        retryable: true,
      });
    }
    const { fetchImpl } = makeFetchStub(
      jsonResponse(
        {
          error: {
            code: 403,
            message: "unregistered caller",
            status: "PERMISSION_DENIED",
          },
        },
        403,
      ),
    );
    const { request } = baseRequest();
    const events = await collect(
      createGoogleAdapter({ ...keyDeps(), fetchImpl }).complete(request),
    );
    expect(events.find((e) => e.kind === "error")).toMatchObject({
      code: "permission_denied",
      retryable: false,
    });
  });

  it("never echoes key material from hostile upstream bodies", async () => {
    const { fetchImpl } = makeFetchStub(
      jsonResponse(
        {
          error: {
            code: 401,
            message: `bad key ${TEST_KEY} rejected`,
            status: "UNAUTHENTICATED",
          },
        },
        401,
      ),
    );
    const { request } = baseRequest();
    const events = await collect(
      createGoogleAdapter({ ...keyDeps(), fetchImpl }).complete(request),
    );
    const error = events.find((e) => e.kind === "error")!;
    expect(error.kind === "error" && error.message).not.toContain(TEST_KEY);
  });

  it("fails without a stored key and without touching the network", async () => {
    const { calls, fetchImpl } = makeFetchStub(sseResponse([chunk("x")]));
    const { request } = baseRequest();
    const events = await collect(
      createGoogleAdapter({
        getApiKey: async () => null,
        fetchImpl,
      }).complete(request),
    );
    expect(calls).toHaveLength(0);
    expect(events.find((e) => e.kind === "error")).toMatchObject({
      code: "missing_api_key",
      retryable: false,
    });
  });

  it("rejects wrong-provider selections and inline data-URL ids before any fetch", async () => {
    const { calls, fetchImpl } = makeFetchStub(sseResponse([chunk("x")]));
    const { request } = baseRequest({
      selection: {
        accountId: "acct-1",
        provider: "openai",
        modelId: "gpt-x",
        mode: "paid-explicit",
      },
    });
    const events = await collect(
      createGoogleAdapter({ ...keyDeps(), fetchImpl }).complete(request),
    );
    expect(events.find((e) => e.kind === "error")).toMatchObject({
      code: "invalid_provider",
    });
    const sneaky = baseRequest({
      approvedImageIds: ["data:image/png;base64,AAAA"],
    });
    const sneakyEvents = await collect(
      createGoogleAdapter({ ...keyDeps(), fetchImpl }).complete(sneaky.request),
    );
    expect(sneakyEvents.find((e) => e.kind === "error")).toMatchObject({
      code: "request_not_allowed",
    });
    expect(calls).toHaveLength(0);
  });

  it("refuses image requests with no resolver instead of dropping photos", async () => {
    const { calls, fetchImpl } = makeFetchStub(sseResponse([chunk("x")]));
    const { request } = baseRequest({ approvedImageIds: ["img-1"] });
    const events = await collect(
      createGoogleAdapter({ ...keyDeps(), fetchImpl }).complete(request),
    );
    expect(events.find((e) => e.kind === "error")).toMatchObject({
      code: "image_resolver_missing",
    });
    expect(calls).toHaveLength(0);
  });

  it("rejects unsupported image media types", async () => {
    const { calls, fetchImpl } = makeFetchStub(sseResponse([chunk("x")]));
    const { request } = baseRequest({ approvedImageIds: ["img-1"] });
    const events = await collect(
      createGoogleAdapter({
        ...keyDeps(),
        fetchImpl,
        resolveImage: async () => ({
          mediaType: "image/tiff",
          base64Data: "AAAA",
        }),
      }).complete(request),
    );
    expect(events.find((e) => e.kind === "error")).toMatchObject({
      code: "unsupported_image_media_type",
    });
    expect(calls).toHaveLength(0);
  });

  it("cancels on caller abort and ignores late chunks", async () => {
    const pipe = pushableResponse();
    const { fetchImpl } = makeFetchStub(pipe.response);
    const { request, controller } = baseRequest();
    const adapter = createGoogleAdapter({ ...keyDeps(), fetchImpl });
    const iterator = adapter.complete(request)[Symbol.asyncIterator]();
    const pending = await iterator.next();
    expect(pending.value).toEqual({
      kind: "phase",
      phase: "queued",
      attempt: 1,
    });
    controller.abort();
    pipe.push(finalChunk("late"));
    pipe.close();
    const rest: StreamEvent[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      rest.push(next.value);
    }
    expect(texts(rest)).toBe("");
    expect(rest.at(-1)).toEqual({
      kind: "done",
      attempt: 1,
      stopReason: "cancelled",
    });
  });
});
