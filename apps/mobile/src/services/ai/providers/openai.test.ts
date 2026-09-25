/**
 * Focused wire tests for the OpenAI BYOK provider adapter.
 *
 * Fixtures mirror the official Chat Completions + SSE shape documented at
 * https://platform.openai.com/docs/api-reference/chat/create and
 * https://platform.openai.com/docs/guides/images-vision (retrieved 2026-09-25).
 *
 * No real key and no network: every test injects a scripted `fetch`. Live
 * provider behaviour is therefore `NOT TESTED LIVE` for this packet.
 */
import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import type { ChatCheckpoint, NormalizedRequest, StreamEvent } from "../providerContract";
import {
  DIRECT_KEY_POLICY,
  OPENAI_API_BASE_URL,
  OpenAiAdapterError,
  createOpenAiAdapter,
  directKeyEntitlement,
  type OpenAiAdapterDeps,
} from "./openai";

const FAKE_KEY = "sk-test-not-a-real-key-0000";
const SYSTEM_TEXT = "You are the FindBack assistant.";

function makeRequest(overrides: Partial<NormalizedRequest> = {}): NormalizedRequest {
  return {
    selection: { accountId: "acct-1", provider: "openai", modelId: "gpt-4o-mini", mode: "free-only" },
    task: "general",
    policyVersion: "policy-1",
    knowledgeVersion: "knowledge-1",
    recentTurns: [],
    currentText: "Hello there",
    approvedImageIds: [],
    authorizedResultIds: [],
    maxOutputTokens: 512,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<OpenAiAdapterDeps> = {}): OpenAiAdapterDeps {
  return {
    resolveCredential: () => FAKE_KEY,
    assembleSystemText: () => SYSTEM_TEXT,
    ...overrides,
  };
}

type FetchCall = { url: string; init?: RequestInit };

function scriptedFetch(script: Array<Response | (() => Response)>) {
  const calls: FetchCall[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init });
    const next = script.shift();
    if (next === undefined) throw new Error("scripted fetch called more times than scripted");
    return typeof next === "function" ? next() : next;
  });
  return { calls, fetchMock, fetchImpl: fetchMock as unknown as typeof fetch };
}

function sseResponse(
  chunks: ReadonlyArray<string | Uint8Array>,
  options: { status?: number; onRead?: (index: number) => void } = {},
): Response {
  const encoder = new TextEncoder();
  const encoded: Uint8Array[] = chunks.map((chunk) =>
    typeof chunk === "string" ? encoder.encode(chunk) : chunk,
  );
  let index = 0;
  const reader = {
    async read(): Promise<{ done: boolean; value?: Uint8Array }> {
      const current = index;
      index += 1;
      options.onRead?.(current);
      const value = encoded[current];
      if (value === undefined) return { done: true };
      return { done: false, value };
    },
    async cancel(): Promise<void> {
      index = encoded.length;
    },
  };
  return {
    ok: true,
    status: options.status ?? 200,
    body: { getReader: () => reader },
    json: async () => {
      throw new Error("sse response has no json body");
    },
    text: async () => "",
  } as unknown as Response;
}

function errorResponse(
  status: number,
  error: { message?: string; type?: string | null; code?: string | null },
): Response {
  const body = JSON.stringify({
    error: {
      message: error.message ?? "boom",
      type: error.type ?? null,
      param: null,
      code: error.code ?? null,
    },
  });
  return {
    ok: false,
    status,
    body: null,
    json: async () => JSON.parse(body) as unknown,
    text: async () => body,
  } as unknown as Response;
}

function deltaFrame(content: string): string {
  return `data: ${JSON.stringify({
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  })}\n\n`;
}

function usageFrame(promptTokens: number, completionTokens: number): string {
  return `data: ${JSON.stringify({
    choices: [],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  })}\n\n`;
}

const DONE_FRAME = "data: [DONE]\n\n";

async function collect(
  adapter: ReturnType<typeof createOpenAiAdapter>,
  request: NormalizedRequest,
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of adapter.complete(request)) events.push(event);
  return events;
}

function textDeltas(events: readonly StreamEvent[]): string {
  return events
    .filter((event): event is Extract<StreamEvent, { kind: "text" }> => event.kind === "text")
    .map((event) => event.delta)
    .join("");
}

function phasesOf(events: readonly StreamEvent[]): string[] {
  return events
    .filter((event): event is Extract<StreamEvent, { kind: "phase" }> => event.kind === "phase")
    .map((event) => event.phase);
}

function errorEvents(events: readonly StreamEvent[]): Extract<StreamEvent, { kind: "error" }>[] {
  return events.filter(
    (event): event is Extract<StreamEvent, { kind: "error" }> => event.kind === "error",
  );
}

function usageEvents(events: readonly StreamEvent[]): Extract<StreamEvent, { kind: "usage" }>[] {
  return events.filter(
    (event): event is Extract<StreamEvent, { kind: "usage" }> => event.kind === "usage",
  );
}

function doneEvents(events: readonly StreamEvent[]): Extract<StreamEvent, { kind: "done" }>[] {
  return events.filter(
    (event): event is Extract<StreamEvent, { kind: "done" }> => event.kind === "done",
  );
}

function parseBody(calls: readonly FetchCall[]): Record<string, unknown> {
  const init = calls[0]?.init;
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

describe("openai adapter — identity and capabilities", () => {
  it("exposes the openai provider id", () => {
    const adapter = createOpenAiAdapter(makeDeps());
    expect(adapter.id).toBe("openai");
  });

  it("keeps model-dependent limits unknown and documents the known slots", () => {
    const capabilities = createOpenAiAdapter(makeDeps()).capabilities();
    expect(capabilities.vision).toEqual({ state: "known", value: true });
    expect(capabilities.streaming).toEqual({ state: "known", value: true });
    // Official vision guide: "Image count: Up to 1,500 images per request".
    expect(capabilities.maxImagesPerCall).toEqual({ state: "known", value: 1500 });
    // Context/output windows are per model on the models page: never invented.
    expect(capabilities.contextTokens).toEqual({ state: "unknown" });
    expect(capabilities.maxOutputTokens).toEqual({ state: "unknown" });
  });
});

describe("openai adapter — request wire (official chat/completions shape)", () => {
  it("POSTs the allowlisted URL with Bearer auth, stream options and no arbitrary base URL", async () => {
    const { calls, fetchImpl } = scriptedFetch([sseResponse([deltaFrame("ok"), DONE_FRAME])]);
    const request = makeRequest();
    await collect(createOpenAiAdapter(makeDeps({ fetchImpl })), request);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${OPENAI_API_BASE_URL}/chat/completions`);
    const init = calls[0]?.init;
    expect(init?.method).toBe("POST");
    expect(init?.signal).toBe(request.signal);
    expect(init?.headers).toMatchObject({
      Authorization: `Bearer ${FAKE_KEY}`,
      "Content-Type": "application/json",
    });

    const body = parseBody(calls);
    expect(body).toMatchObject({
      model: "gpt-4o-mini",
      stream: true,
      stream_options: { include_usage: true },
      max_completion_tokens: 512,
    });
    // max_tokens is deprecated in favour of max_completion_tokens.
    expect(body).not.toHaveProperty("max_tokens");
    expect(body.messages).toEqual([
      { role: "system", content: SYSTEM_TEXT },
      { role: "user", content: "Hello there" },
    ]);
  });

  it("keeps the compaction summary out of the system role and tags it as untrusted data", async () => {
    const { calls, fetchImpl } = scriptedFetch([sseResponse([DONE_FRAME])]);
    const summary: ChatCheckpoint = {
      schemaVersion: 1,
      coveredThroughTurnId: "turn-1",
      sourceTurnIds: ["turn-1"],
      summaryText: "User lost a blue key near Gate 4.",
      generatedBy: "local-extractive",
      estimatedTokens: 42,
      updatedAt: "2026-09-25T00:00:00.000Z",
    };
    await collect(
      createOpenAiAdapter(makeDeps({ fetchImpl })),
      makeRequest({
        summary,
        recentTurns: [{ id: "turn-2", role: "user", text: "Still looking", attachmentIds: [], createdAt: "2026-09-25T00:00:00.000Z" }],
        currentText: "Any update?",
      }),
    );

    const messages = parseBody(calls).messages as Array<{ role: string; content: string }>;
    expect(messages[0]).toEqual({ role: "system", content: SYSTEM_TEXT });
    expect(messages.some((m) => m.role === "system" && m.content.includes("blue key"))).toBe(false);
    const summaryMessage = messages.find((m) => m.content.includes("blue key"));
    expect(summaryMessage?.role).toBe("user");
    expect(summaryMessage?.content.toLowerCase()).toContain("untrusted");
    expect(summaryMessage?.content).toContain("turn-1");
    expect(messages.at(-1)).toEqual({ role: "user", content: "Any update?" });
  });

  it("renders approved images as image_url data parts and re-sends prior-turn attachments", async () => {
    const { calls, fetchImpl } = scriptedFetch([sseResponse([DONE_FRAME])]);
    const resolveImage = vi.fn((imageId: string) => ({
      mediaType: imageId === "img-old" ? "image/png" : "image/jpeg",
      base64: imageId === "img-old" ? "T0xE" : "TkVX",
    }));
    await collect(
      createOpenAiAdapter(makeDeps({ fetchImpl, resolveImage })),
      makeRequest({
        recentTurns: [
          { id: "turn-1", role: "user", text: "Look at this", attachmentIds: ["img-old"], createdAt: "2026-09-25T00:00:00.000Z" },
        ],
        approvedImageIds: ["img-new"],
      }),
    );

    const messages = parseBody(calls).messages as Array<{
      role: string;
      content: string | Array<Record<string, unknown>>;
    }>;
    const past = messages[1];
    expect(past?.role).toBe("user");
    expect(past?.content).toEqual([
      { type: "text", text: "Look at this" },
      { type: "image_url", image_url: { url: "data:image/png;base64,T0xE" } },
    ]);
    const current = messages.at(-1);
    expect(current?.content).toEqual([
      { type: "text", text: "Hello there" },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,TkVX" } },
    ]);
    expect(resolveImage).toHaveBeenCalledTimes(2);
  });

  it("rejects a request whose provider does not match the adapter without touching the network", async () => {
    const { fetchMock, fetchImpl } = scriptedFetch([]);
    const events = await collect(
      createOpenAiAdapter(makeDeps({ fetchImpl })),
      makeRequest({
        selection: { accountId: "acct-1", provider: "anthropic", modelId: "claude", mode: "free-only" },
      }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(errorEvents(events)[0]?.code).toBe("request_invalid");
    expect(doneEvents(events)[0]?.stopReason).toBe("error");
  });

  it("rejects smuggled inline image bytes before any network call", async () => {
    const { fetchMock, fetchImpl } = scriptedFetch([]);
    const events = await collect(
      createOpenAiAdapter(makeDeps({ fetchImpl })),
      makeRequest({ approvedImageIds: ["data:image/png;base64,AAA"] }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(errorEvents(events)[0]?.code).toBe("request_invalid");
    expect(phasesOf(events)).toEqual(["queued", "failed"]);
  });
});

describe("openai adapter — image capability handling", () => {
  it("refuses an image count above the documented per-request limit without a network call", async () => {
    const { fetchMock, fetchImpl } = scriptedFetch([]);
    const images = Array.from({ length: 1501 }, (_, i) => `img-${i}`);
    const events = await collect(
      createOpenAiAdapter(makeDeps({ fetchImpl })),
      makeRequest({ approvedImageIds: images }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(errorEvents(events)[0]?.code).toBe("image_count_exceeded");
    expect(errorEvents(events)[0]?.retryable).toBe(false);
  });

  it("honours a stricter per-model image limit supplied by the caller", async () => {
    const { fetchMock, fetchImpl } = scriptedFetch([]);
    const adapter = createOpenAiAdapter(
      makeDeps({
        fetchImpl,
        modelCapabilities: () => ({ maxImagesPerCall: { state: "known", value: 4 } }),
      }),
    );
    const events = await collect(adapter, makeRequest({ approvedImageIds: ["a", "b", "c", "d", "e"] }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(errorEvents(events)[0]?.code).toBe("image_count_exceeded");
  });

  it("fails honestly when images are requested but no resolver is wired", async () => {
    const { fetchMock, fetchImpl } = scriptedFetch([]);
    const adapter = createOpenAiAdapter(
      makeDeps({ fetchImpl, resolveImage: undefined }),
    );
    const events = await collect(adapter, makeRequest({ approvedImageIds: ["img-1"] }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(errorEvents(events)[0]?.code).toBe("image_unavailable");
  });

  it("maps a credential failure to credential_unavailable without a network call", async () => {
    const { fetchMock, fetchImpl } = scriptedFetch([]);
    const adapter = createOpenAiAdapter(
      makeDeps({
        fetchImpl,
        resolveCredential: () => {
          throw new Error("vault locked");
        },
      }),
    );
    const events = await collect(adapter, makeRequest());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(errorEvents(events)[0]?.code).toBe("credential_unavailable");
  });
});

describe("openai adapter — SSE stream parsing", () => {
  it("handles comments, CRLF, split UTF-8, multiline data and [DONE]", async () => {
    const encoder = new TextEncoder();
    const utf8Frame = deltaFrame("café 🎉");
    const bytes = encoder.encode(utf8Frame);
    const cut = bytes.findIndex((byte) => byte >= 0x80);
    expect(cut).toBeGreaterThan(0);

    // One JSON payload split across two SSE `data:` lines (CRLF framed).
    const multilineFrame = [
      'data: {"choices":[{"index":0,',
      'data: "delta":{"content":" done"},"finish_reason":null}]}',
      "",
      "",
    ].join("\r\n");

    const { fetchImpl } = scriptedFetch([
      sseResponse([
        ": keep-alive comment\n\n",
        bytes.slice(0, cut),
        bytes.slice(cut),
        multilineFrame,
        DONE_FRAME,
      ]),
    ]);
    const events = await collect(createOpenAiAdapter(makeDeps({ fetchImpl })), makeRequest());

    expect(textDeltas(events)).toBe("café 🎉 done");
    expect(errorEvents(events)).toHaveLength(0);
    expect(phasesOf(events)).toEqual(["queued", "sending", "first-token", "streaming", "complete"]);
    expect(doneEvents(events)[0]).toMatchObject({ stopReason: "complete", attempt: 1 });
  });

  it("completes even when the server never sends [DONE]", async () => {
    const { fetchImpl } = scriptedFetch([sseResponse([deltaFrame("bye")])]);
    const events = await collect(createOpenAiAdapter(makeDeps({ fetchImpl })), makeRequest());

    expect(textDeltas(events)).toBe("bye");
    expect(phasesOf(events)).toEqual(["queued", "sending", "first-token", "streaming", "complete"]);
    expect(doneEvents(events)[0]?.stopReason).toBe("complete");
    expect(errorEvents(events)).toHaveLength(0);
  });

  it("emits exactly one usage event from the final usage chunk", async () => {
    const nullUsageFrame = `data: ${JSON.stringify({
      choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }],
      usage: null,
    })}\n\n`;
    const { fetchImpl } = scriptedFetch([
      sseResponse([nullUsageFrame, usageFrame(7, 5), DONE_FRAME]),
    ]);
    const events = await collect(createOpenAiAdapter(makeDeps({ fetchImpl })), makeRequest());

    const usage = usageEvents(events);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ attempt: 1, inputTokens: 7, outputTokens: 5 });

    const usageIndex = events.findIndex((event) => event.kind === "usage");
    const completeIndex = events.findIndex(
      (event) => event.kind === "phase" && event.phase === "complete",
    );
    expect(usageIndex).toBeGreaterThanOrEqual(0);
    expect(completeIndex).toBeGreaterThan(usageIndex);
  });

  it("maps a midstream provider error object to a failed stream", async () => {
    const midstream = `data: ${JSON.stringify({
      error: { message: "The server had an error", type: "server_error", param: null, code: null },
    })}\n\n`;
    const { fetchImpl } = scriptedFetch([sseResponse([deltaFrame("partial"), midstream])]);
    const events = await collect(createOpenAiAdapter(makeDeps({ fetchImpl })), makeRequest());

    expect(textDeltas(events)).toBe("partial");
    const errors = errorEvents(events);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: "server_error", retryable: true, attempt: 1 });
    expect(phasesOf(events)).toContain("failed");
    expect(phasesOf(events)).not.toContain("complete");
    expect(events.at(-1)).toMatchObject({ kind: "done", stopReason: "error" });
  });

  it("fails with stream_malformed on unparseable SSE data", async () => {
    const { fetchImpl } = scriptedFetch([
      sseResponse(['data: {"choices":[\n\n', DONE_FRAME]),
    ]);
    const events = await collect(createOpenAiAdapter(makeDeps({ fetchImpl })), makeRequest());

    const errors = errorEvents(events);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("stream_malformed");
    expect(phasesOf(events)).not.toContain("complete");
    expect(events.at(-1)).toMatchObject({ kind: "done", stopReason: "error" });
  });
});

describe("openai adapter — HTTP error mapping", () => {
  const cases: Array<{
    status: number;
    error: { message?: string; type?: string | null; code?: string | null };
    code: string;
    retryable: boolean;
  }> = [
    {
      status: 400,
      error: { type: "invalid_request_error", message: "Invalid request" },
      code: "request_invalid",
      retryable: false,
    },
    {
      status: 401,
      error: { type: "invalid_request_error", message: "Incorrect API key provided" },
      code: "authentication_failed",
      retryable: false,
    },
    {
      status: 403,
      error: { type: "invalid_request_error", message: "Country, region, or territory not supported" },
      code: "permission_denied",
      retryable: false,
    },
    {
      status: 404,
      error: { type: "invalid_request_error", message: "The model `gpt-4o-mini` does not exist" },
      code: "model_not_found",
      retryable: false,
    },
    {
      status: 408,
      error: { type: "invalid_request_error", message: "Request timed out" },
      code: "request_timeout",
      retryable: true,
    },
    {
      status: 409,
      error: { type: "conflict", message: "A conflict occurred" },
      code: "conflict",
      retryable: true,
    },
    {
      status: 413,
      error: { type: "invalid_request_error", message: "Payload too large" },
      code: "request_too_large",
      retryable: false,
    },
    {
      status: 422,
      error: { type: "invalid_request_error", message: "Unprocessable request" },
      code: "request_invalid",
      retryable: false,
    },
    {
      status: 429,
      error: { type: "rate_limit_error", code: "rate_limit_exceeded", message: "Rate limit reached" },
      code: "rate_limited",
      retryable: true,
    },
    {
      status: 429,
      error: { type: "insufficient_quota", code: "insufficient_quota", message: "You exceeded your current quota" },
      code: "quota_exhausted",
      retryable: false,
    },
    {
      status: 500,
      error: { type: "server_error", message: "The server had an error" },
      code: "server_error",
      retryable: true,
    },
    {
      status: 503,
      error: { type: "server_error", code: "server_is_overloaded", message: "The engine is currently overloaded" },
      code: "server_error",
      retryable: true,
    },
  ];

  it.each(cases)(
    "maps HTTP $status / $error.type to $code (retryable=$retryable)",
    async ({ status, error, code, retryable }) => {
      const { calls, fetchImpl } = scriptedFetch([errorResponse(status, error)]);
      const events = await collect(createOpenAiAdapter(makeDeps({ fetchImpl })), makeRequest());

      // A scripted fetch with a single entry throws on any internal retry.
      expect(calls).toHaveLength(1);
      const errors = errorEvents(events);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ code, retryable, attempt: 1 });
      expect(phasesOf(events)).toEqual(["queued", "sending", "failed"]);
      expect(events.at(-1)).toMatchObject({ kind: "done", stopReason: "error" });
    },
  );

  it("clips long provider messages and never echoes the API key", async () => {
    const { fetchImpl } = scriptedFetch([
      errorResponse(400, {
        type: "invalid_request_error",
        message: `PREFIX_MARKER ${"x".repeat(2000)}`,
      }),
    ]);
    const events = await collect(createOpenAiAdapter(makeDeps({ fetchImpl })), makeRequest());

    const failure = errorEvents(events)[0];
    expect(failure?.message.startsWith("PREFIX_MARKER")).toBe(true);
    expect(failure?.message.length).toBeLessThanOrEqual(500);
    expect(JSON.stringify(events)).not.toContain(FAKE_KEY);
  });

  it("rejects a non-positive output-token bound without touching the network", async () => {
    const { fetchMock, fetchImpl } = scriptedFetch([]);
    const events = await collect(
      createOpenAiAdapter(makeDeps({ fetchImpl })),
      makeRequest({ maxOutputTokens: 0 }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(errorEvents(events)[0]?.code).toBe("request_invalid");
  });

  it("maps a fetch-level failure to a retryable network_error", async () => {
    // An empty script makes any fetch call throw — the failure path under test.
    const { fetchImpl } = scriptedFetch([]);
    const events = await collect(createOpenAiAdapter(makeDeps({ fetchImpl })), makeRequest());

    expect(errorEvents(events)[0]).toMatchObject({
      code: "network_error",
      retryable: true,
      attempt: 1,
    });
    expect(phasesOf(events)).toEqual(["queued", "sending", "failed"]);
    expect(events.at(-1)).toMatchObject({ kind: "done", stopReason: "error" });
  });
});

describe("openai adapter — cancellation", () => {
  it("cancels without touching the network when the signal is already aborted", async () => {
    const { fetchMock, fetchImpl } = scriptedFetch([sseResponse([DONE_FRAME])]);
    const controller = new AbortController();
    controller.abort();
    const events = await collect(
      createOpenAiAdapter(makeDeps({ fetchImpl })),
      makeRequest({ signal: controller.signal }),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(phasesOf(events)).toEqual(["queued", "cancelled"]);
    expect(events.at(-1)).toMatchObject({ kind: "done", stopReason: "cancelled" });
    expect(errorEvents(events)).toHaveLength(0);
  });

  it("stops reading after an abort and ignores late chunks", async () => {
    const controller = new AbortController();
    let reads = 0;
    const { fetchImpl } = scriptedFetch([
      sseResponse([deltaFrame("first part"), deltaFrame("LATE CHUNK")], {
        onRead: (index) => {
          reads = index + 1;
          if (index === 1) controller.abort();
        },
      }),
    ]);
    const events = await collect(
      createOpenAiAdapter(makeDeps({ fetchImpl })),
      makeRequest({ signal: controller.signal }),
    );

    expect(textDeltas(events)).toBe("first part");
    expect(phasesOf(events)).toEqual([
      "queued",
      "sending",
      "first-token",
      "streaming",
      "cancelled",
    ]);
    expect(events.at(-1)).toMatchObject({ kind: "done", stopReason: "cancelled" });
    expect(errorEvents(events)).toHaveLength(0);
    // The reader must stop pulling once cancelled (2 scripted chunks, nothing more).
    expect(reads).toBeLessThanOrEqual(2);
  });
});

describe("openai adapter — hygiene", () => {
  it("never logs prompt, photo or key material through console", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

    const { fetchImpl } = scriptedFetch([sseResponse([deltaFrame("ok"), DONE_FRAME])]);
    const resolveImage = vi.fn(() => ({ mediaType: "image/png", base64: "UE5H" }));
    const events = await collect(
      createOpenAiAdapter(makeDeps({ fetchImpl, resolveImage })),
      makeRequest({ currentText: "SECRET_PROMPT_MARKER", approvedImageIds: ["photo-1"] }),
    );

    expect(events.length).toBeGreaterThan(0);
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
    expect(debugSpy).not.toHaveBeenCalled();

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(FAKE_KEY);
    expect(serialized).not.toContain("SECRET_PROMPT_MARKER");
    expect(serialized).not.toContain("UE5H");
    // No internal retry: every event belongs to attempt 1.
    expect(events.every((event) => event.attempt === 1)).toBe(true);

    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    infoSpy.mockRestore();
    debugSpy.mockRestore();
  });
});

function jsonResponse(status: number, payload: unknown): Response {
  const body = JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    body: null,
    json: async () => JSON.parse(body) as unknown,
    text: async () => body,
  } as unknown as Response;
}

describe("openai adapter — listModels", () => {
  it("maps GET /v1/models into honest, price-free ModelRecords", async () => {
    const { calls, fetchImpl } = scriptedFetch([
      jsonResponse(200, {
        object: "list",
        data: [
          { id: "gpt-4o-mini", object: "model", created: 1715367049, owned_by: "openai" },
          {
            id: "gpt-4o-2024-05-13",
            object: "model",
            created: 1715367049,
            owned_by: "openai",
            shutdown_date: "2025-12-31",
          },
        ],
      }),
    ]);
    const adapter = createOpenAiAdapter(
      makeDeps({ fetchImpl, resolveListCredential: () => FAKE_KEY }),
    );
    expect(adapter.listModels).toBeTypeOf("function");

    const records = await adapter.listModels!();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${OPENAI_API_BASE_URL}/models`);
    expect(calls[0]?.init?.headers).toMatchObject({ Authorization: `Bearer ${FAKE_KEY}` });

    expect(records).toHaveLength(2);
    const first = records[0]!;
    expect(first).toMatchObject({
      provider: "openai",
      id: "gpt-4o-mini",
      prices: [],
      priceClass: "unknown",
      entitlement: "untested",
    });
    expect(first.input).toEqual([]);
    expect(first.output).toEqual([]);
    // The official /models payload carries no pricing or window fields —
    // they stay undefined (unknown), never 0.
    expect(first.contextTokens).toBeUndefined();
    expect(first.maxOutputTokens).toBeUndefined();
    expect(first.maxImagesPerCall).toBeUndefined();
    expect(Number.isNaN(Date.parse(first.retrievedAt))).toBe(false);
  });

  it("caps the model list at 1000 entries", async () => {
    const data = Array.from({ length: 1001 }, (_, index) => ({
      id: `model-${index}`,
      object: "model",
      created: 0,
      owned_by: "openai",
    }));
    const { fetchImpl } = scriptedFetch([jsonResponse(200, { object: "list", data })]);
    const records = await createOpenAiAdapter(
      makeDeps({ fetchImpl, resolveListCredential: () => FAKE_KEY }),
    )
      .listModels!();
    expect(records).toHaveLength(1000);
    expect(records[999]?.id).toBe("model-999");
  });

  it("rejects with a mapped OpenAiAdapterError when listing fails", async () => {
    const { fetchImpl } = scriptedFetch([
      errorResponse(401, { type: "invalid_request_error", message: "Incorrect API key provided" }),
    ]);
    const failure = await createOpenAiAdapter(
      makeDeps({ fetchImpl, resolveListCredential: () => FAKE_KEY }),
    )
      .listModels!()
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(OpenAiAdapterError);
    expect((failure as OpenAiAdapterError).code).toBe("authentication_failed");
    expect((failure as OpenAiAdapterError).retryable).toBe(false);
  });
});

describe("openai adapter — direct-key policy (O1 documented-blocked)", () => {
  it("records the direct client-side key policy as blocked with reason, source and date", () => {
    expect(DIRECT_KEY_POLICY.status).toBe("blocked");
    expect(DIRECT_KEY_POLICY.reason.trim().length).toBeGreaterThan(0);
    expect(DIRECT_KEY_POLICY.sourceUrl.startsWith("https://")).toBe(true);
    expect(DIRECT_KEY_POLICY.retrievedAt.trim().length).toBeGreaterThan(0);
  });

  it("reports the direct-key entitlement as blocked for callers/UI", () => {
    expect(directKeyEntitlement()).toBe("blocked");
  });

  it("keeps the wire module free of proxy, embedded-key and base-URL-override routes", async () => {
    const source = await readFile(new URL("./openai.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/proxyUrl|baseUrl/i);
    expect(source).not.toMatch(/localhost|127\.0\.0\.1|0\.0\.0\.0/);
    expect(source).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(source).toMatch(/export const OPENAI_API_BASE_URL/);
  });
});
