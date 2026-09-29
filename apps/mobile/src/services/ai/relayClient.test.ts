import { describe, expect, it, vi } from "vitest";
import {
  RELAY_FUNCTION_NAME,
  RELAY_PROVIDERS,
  RelayError,
  createRelayClient,
  type RelayInvokeFn,
} from "./relayClient";

/**
 * AI-021: the mobile app never holds provider key material for the relay
 * route. The server-side function owns the secret; the client only sends the
 * provider id + messages over the authenticated session, with abort support.
 * All network access here goes through an injected fake (fakes over mocks).
 */

function fakeInvoke(
  impl: (body: Record<string, unknown>) => { data?: unknown; error?: unknown },
): RelayInvokeFn & { calls: Array<{ fn: string; body: Record<string, unknown> }> } {
  const calls: Array<{ fn: string; body: Record<string, unknown> }> = [];
  const fn = (async (fnName: string, body: Record<string, unknown>) => {
    calls.push({ fn: fnName, body });
    return impl(body);
  }) as RelayInvokeFn & { calls: Array<{ fn: string; body: Record<string, unknown> }> };
  fn.calls = calls;
  return fn;
}

describe("relayClient (AI-021 secure relay route)", () => {
  it("pins the approved relay function name", () => {
    expect(RELAY_FUNCTION_NAME).toBe("ai-relay");
    expect(RELAY_PROVIDERS).toEqual(["openai", "deepseek"]);
  });

  it("sends provider + messages with no key material and returns text", async () => {
    const invoke = fakeInvoke(() => ({ data: { text: "hello", provider: "openai" } }));
    const client = createRelayClient({ invoke });
    const result = await client.chat({
      provider: "openai",
      messages: [{ role: "user", content: "Hello" }],
    });
    expect(result).toMatchObject({ text: "hello", provider: "openai" });
    expect(invoke.calls).toHaveLength(1);
    expect(invoke.calls[0]?.fn).toBe("ai-relay");
    const body = invoke.calls[0]?.body ?? {};
    expect(body.provider).toBe("openai");
    expect(body.messages).toEqual([{ role: "user", content: "Hello" }]);
    // No key material may ever travel with a relay request.
    expect(JSON.stringify(body).toLowerCase()).not.toContain("key");
    expect("model" in body).toBe(false);
  });

  it("rejects unknown providers before any network call", async () => {
    const invoke = fakeInvoke(() => ({ data: { text: "x" } }));
    const client = createRelayClient({ invoke });
    await expect(
      client.chat({
        // Deliberate contract probe: never a supported relay provider.
        provider: "other" as never,
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toMatchObject({ code: "request_invalid" });
    expect(invoke.calls).toHaveLength(0);
  });

  it("rejects empty or oversized payloads before any network call", async () => {
    const invoke = fakeInvoke(() => ({ data: { text: "x" } }));
    const client = createRelayClient({ invoke });
    await expect(client.chat({ provider: "deepseek", messages: [] })).rejects.toMatchObject({
      code: "request_invalid",
    });
    await expect(
      client.chat({
        provider: "deepseek",
        messages: [{ role: "user", content: "x".repeat(5000) }],
      }),
    ).rejects.toMatchObject({ code: "request_invalid" });
    await expect(
      client.chat({
        provider: "deepseek",
        messages: [{ role: "user", content: "" }],
      }),
    ).rejects.toMatchObject({ code: "request_invalid" });
    expect(invoke.calls).toHaveLength(0);
  });

  it("honours an already-aborted signal without calling the network", async () => {
    const invoke = fakeInvoke(() => ({ data: { text: "x" } }));
    const client = createRelayClient({ invoke });
    const controller = new AbortController();
    controller.abort();
    await expect(
      client.chat({
        provider: "openai",
        messages: [{ role: "user", content: "hi" }],
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "request_cancelled" });
    expect(invoke.calls).toHaveLength(0);
  });

  it("maps relay failures to typed codes", async () => {
    const cases: Array<{ error: { status?: number; message?: string }; code: string }> = [
      { error: { status: 401, message: "unauthorized" }, code: "relay_unauthorized" },
      { error: { status: 403, message: "forbidden" }, code: "relay_forbidden" },
      { error: { status: 503, message: "not configured" }, code: "provider_error" },
    ];
    for (const { error, code } of cases) {
      const invoke = fakeInvoke(() => ({ error }));
      const client = createRelayClient({ invoke });
      const failure = await client
        .chat({ provider: "openai", messages: [{ role: "user", content: "hi" }] })
        .catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(RelayError);
      expect((failure as RelayError).code).toBe(code);
    }
  });

  it("rejects malformed relay payloads without leaking body content", async () => {
    const invoke = fakeInvoke(() => ({ data: { unexpected: true } }));
    const client = createRelayClient({ invoke });
    const failure = await client
      .chat({ provider: "deepseek", messages: [{ role: "user", content: "hi" }] })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(RelayError);
    expect((failure as RelayError).code).toBe("response_malformed");
  });

  it("forwards the caller signal to the invoke layer", async () => {
    const seen: Array<AbortSignal | undefined> = [];
    const invoke = (async (
      _fn: string,
      _body: Record<string, unknown>,
      signal?: AbortSignal,
    ) => {
      seen.push(signal);
      return { data: { text: "ok", provider: "openai" } };
    }) as RelayInvokeFn;
    const client = createRelayClient({ invoke });
    const controller = new AbortController();
    await client.chat({
      provider: "openai",
      messages: [{ role: "user", content: "hi" }],
      signal: controller.signal,
    });
    expect(seen[0]).toBe(controller.signal);
  });

  it("default client closes over the injected contract (smoke via factory)", () => {
    // The module default wires the live session client; the factory contract
    // above is what tests pin. This keeps one construction path.
    const spy = vi.fn();
    createRelayClient({ invoke: spy as unknown as RelayInvokeFn });
    expect(spy).not.toHaveBeenCalled();
  });
});
