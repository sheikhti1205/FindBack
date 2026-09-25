import { describe, expect, it, vi } from "vitest";
import { createOpenRouterClient, OPENROUTER_MODEL, OpenRouterError, REQUEST_TIMEOUT_MS } from "./openRouter";

function completed(text = "A black backpack") {
  return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: text } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Emulates a provider that returns headers, streams a partial body, then stalls
 * forever. The stream is tied to the request signal the way real fetch does, so
 * aborting the request errors the pending read.
 */
function stalledBody(onSignal?: AbortSignal) {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const fail = () => controller.error(new DOMException("Aborted", "AbortError"));
        if (onSignal?.aborted) { fail(); return; }
        controller.enqueue(new TextEncoder().encode('{"choices":'));
        onSignal?.addEventListener("abort", fail);
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("fixed OpenRouter free route", () => {
  it("exposes openrouter/free as the single enforced model constant", () => {
    expect(OPENROUTER_MODEL).toBe("openrouter/free");
  });

  it("uses only openrouter/free even when a caller smuggles a model override", async () => {
    const fetcher = vi.fn(async () => completed());
    const client = createOpenRouterClient(async () => "user-owned-key", fetcher);
    expect(await client.text("Suggest a title", { model: "openrouter/auto" } as never)).toBe("A black backpack");
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(JSON.parse(init.body as string)).toMatchObject({ model: "openrouter/free" });
    expect(JSON.parse(init.body as string)).not.toHaveProperty("models");
    expect(init.body).not.toContain("user-owned-key"); // Headers carry the bearer, not JSON body.
  });

  it("strips smuggled provider/route/models fields and keeps the free route", async () => {
    const fetcher = vi.fn(async () => completed());
    const client = createOpenRouterClient(async () => "user-owned-key", fetcher);
    await client.text("Suggest a title", {
      model: "openrouter/auto",
      models: ["paid-model"],
      route: "fallback",
      provider: { order: ["paid"], allow: ["paid"] },
    } as never);
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    const payload = JSON.parse(init.body as string);
    expect(payload.model).toBe("openrouter/free");
    expect(payload).not.toHaveProperty("models");
    expect(payload).not.toHaveProperty("provider");
    expect(payload).not.toHaveProperty("route");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("sends consented images only as supported bounded data URLs", async () => {
    const fetcher = vi.fn(async () => completed("{}"));
    const client = createOpenRouterClient(async () => "example-key", fetcher);
    const image = `data:image/jpeg;base64,${btoa("jpeg")}`;
    await expect(client.image("Analyze the item", image, false)).rejects.toMatchObject({ code: "CONSENT_REQUIRED" });
    expect(fetcher).not.toHaveBeenCalled();
    await client.image("Analyze the item", image, true);
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    const payload = JSON.parse(init.body as string);
    expect(payload.model).toBe("openrouter/free");
    expect(payload.messages[0].content).toEqual([
      { type: "text", text: "Analyze the item" },
      { type: "image_url", image_url: { url: image } },
    ]);
    await expect(client.image("Analyze", "https://example.com/photo", true)).rejects.toMatchObject({ code: "INVALID_IMAGE" });
  });

  it("distinguishes missing key, invalid key, exhaustion and provider unavailability without leaking upstream errors", async () => {
    const missing = createOpenRouterClient(async () => null, vi.fn());
    await expect(missing.text("hi")).rejects.toMatchObject({ code: "MISSING_KEY" });
    for (const [status, code] of [[401, "INVALID_KEY"], [429, "RATE_LIMITED"], [503, "NO_FREE_MODEL"]] as const) {
      const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: { code: status, message: "secret upstream message" } }), { status }));
      const client = createOpenRouterClient(async () => "example-key", fetcher);
      await expect(client.text("hi")).rejects.toMatchObject({ code });
      await expect(client.text("hi")).rejects.not.toThrow("secret upstream message");
    }
    const exhausted = createOpenRouterClient(async () => "example-key", vi.fn(async () =>
      new Response(JSON.stringify({ error: { metadata: { error_type: "rate_limit_exceeded", limit_source: "free_model_daily" } } }), { status: 429 })));
    await expect(exhausted.text("hi")).rejects.toMatchObject({ code: "DAILY_LIMIT" });
  });

  it("maps 402/paid-credit blocks without any paid fallback or retry", async () => {
    for (const body of [
      { error: { code: 402, message: "Payment required" } },
      { error: { message: "Insufficient credits: add credits to continue", metadata: { error_type: "insufficient_credits" } } },
    ]) {
      const fetcher = vi.fn(async () => new Response(JSON.stringify(body), { status: 402 }));
      const client = createOpenRouterClient(async () => "example-key", fetcher);
      await expect(client.text("hi")).rejects.toMatchObject({ code: "PAYMENT_OR_POLICY_BLOCKED" });
      // Never a paid fallback: exactly one call, still on the free route.
      expect(fetcher).toHaveBeenCalledTimes(1);
      const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
      expect(JSON.parse(init.body as string).model).toBe("openrouter/free");
    }
  });

  it("maps 403, 408 and unsupported-capability 400 to stable categories", async () => {
    const cases = [
      [403, { error: { code: 403, message: "forbidden" } }, "PERMISSION_DENIED"],
      [408, { error: { code: 408, message: "request timeout" } }, "TIMEOUT"],
      [400, { error: { code: 400, message: "response_format json_schema is not supported by any free model" } }, "FREE_CAPABILITY_UNAVAILABLE"],
    ] as const;
    for (const [status, body, code] of cases) {
      const fetcher = vi.fn(async () => new Response(JSON.stringify(body), { status }));
      const client = createOpenRouterClient(async () => "example-key", fetcher);
      await expect(client.text("hi")).rejects.toMatchObject({ code });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it("rejects 200-level provider errors, truncated, empty and malformed output", async () => {
    for (const response of [
      new Response(JSON.stringify({ error: { code: 503, message: "provider" } }), { status: 200 }),
      new Response(JSON.stringify({ choices: [{ finish_reason: "error", error: { code: 502 }, message: { content: "partial" } }] }), { status: 200 }),
      new Response(JSON.stringify({ choices: [{ finish_reason: "length", message: { content: "partial" } }] }), { status: 200 }),
      completed("  "),
      new Response("{broken", { status: 200 }),
    ]) {
      const client = createOpenRouterClient(async () => "example-key", vi.fn(async () => response.clone()));
      await expect(client.text("hi")).rejects.toBeInstanceOf(OpenRouterError);
    }
  });

  it("validates a key without consuming a completion and rejects management keys", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: { is_management_key: false, free_model_daily_requests: { remaining: 4 } } }), { status: 200 }));
    const client = createOpenRouterClient(async () => null, fetcher);
    await expect(client.validateKey("entered-key")).resolves.toEqual({ remaining: 4 });
    expect((fetcher.mock.calls[0] as unknown as [string])[0]).toBe("https://openrouter.ai/api/v1/key");
    const admin = createOpenRouterClient(async () => null, vi.fn(async () => new Response(JSON.stringify({ data: { is_management_key: true } }), { status: 200 })));
    await expect(admin.validateKey("admin-key")).rejects.toMatchObject({ code: "INVALID_KEY" });
  });

  it("keeps the deadline active while the response body is still streaming", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn<typeof fetch>(async (_url, init) => stalledBody(init?.signal ?? undefined));
      const client = createOpenRouterClient(async () => "example-key", fetcher);
      const pending = client.text("hi");
      const assertion = expect(pending).rejects.toMatchObject({ code: "TIMEOUT" });
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
      await assertion;
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out a stalled body read even though headers already arrived", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn<typeof fetch>(async (_url, init) => stalledBody(init?.signal ?? undefined));
      const client = createOpenRouterClient(async () => "example-key", fetcher);
      const pending = client.text("hi");
      const assertion = expect(pending).rejects.toMatchObject({ code: "TIMEOUT" });
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1);
      // Still streaming: the deadline must not have fired early.
      let settled = false;
      void pending.catch(() => { settled = true; });
      await Promise.resolve();
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts a response body that finishes within the deadline", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn<typeof fetch>(async () => new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            setTimeout(() => {
              controller.enqueue(new TextEncoder().encode(JSON.stringify({
                choices: [{ finish_reason: "stop", message: { content: "late but valid" } }],
              })));
              controller.close();
            }, 1_000);
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ));
      const client = createOpenRouterClient(async () => "example-key", fetcher);
      const pending = client.text("hi");
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(pending).resolves.toBe("late but valid");
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels an in-flight body read when the caller aborts", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => stalledBody(init?.signal ?? undefined));
    const client = createOpenRouterClient(async () => "example-key", fetcher);
    const pending = client.text("hi", { signal: controller.signal });
    const assertion = expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    controller.abort();
    await assertion;
  });
});
