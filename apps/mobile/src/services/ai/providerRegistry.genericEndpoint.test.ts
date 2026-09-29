/**
 * Registry generic-endpoint wiring tests (h1-generic).
 *
 * The registry receives the configured URL — directly via `genericBaseURL`
 * or via the account-scoped `resolveGenericEndpoint` seam — for catalogue,
 * test, and send paths alike. A generic key without an endpoint stays
 * unusable with a visible explanation; no default is invented.
 */
import { describe, expect, it } from "vitest";
import type { NormalizedRequest, ProviderId } from "./providerContract";
import { createProviderAdapter } from "./providerRegistry";

const ACCOUNT = "generic-acct-1";

function baseRequest(): { request: NormalizedRequest; controller: AbortController } {
  const controller = new AbortController();
  return {
    controller,
    request: {
      selection: {
        accountId: ACCOUNT,
        provider: "generic",
        modelId: "generic/test-model",
        mode: "free-only",
      },
      task: "app-help",
      policyVersion: "p1",
      knowledgeVersion: "k1",
      recentTurns: [],
      currentText: "Hello",
      approvedImageIds: [],
      authorizedResultIds: [],
      maxOutputTokens: 64,
      signal: controller.signal,
    },
  };
}

function stubFetch(urls: string[], status = 401) {
  return (async (url: unknown) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ message: "nope" }), { status });
  }) as typeof fetch;
}

describe("providerRegistry generic endpoint wiring", () => {
  it("sends completions to the configured URL from the resolver seam", async () => {
    const urls: string[] = [];
    const adapter = createProviderAdapter("generic", {
      accountId: ACCOUNT,
      resolveKey: async () => "KEY-generic",
      fetchImpl: stubFetch(urls),
      resolveGenericEndpoint: (id) =>
        id === ACCOUNT ? "https://custom.example.com/v1/" : null,
    });
    expect(adapter.id).toBe("generic");
    const { request } = baseRequest();
    for await (const _event of adapter.complete(request)) {
      // Drain; assertions below.
    }
    expect(urls).toEqual(["https://custom.example.com/v1/chat/completions"]);
  });

  it("lists the catalogue from the same configured URL", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: unknown) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ data: [{ id: "custom-model" }] }), {
        status: 200,
      });
    }) as typeof fetch;
    const adapter = createProviderAdapter("generic", {
      accountId: ACCOUNT,
      resolveKey: async () => "KEY-generic",
      fetchImpl,
      resolveGenericEndpoint: () => "https://custom.example.com/v1",
    });
    const rows = await adapter.listModels?.();
    expect(urls).toEqual(["https://custom.example.com/v1/models"]);
    expect(rows?.map((row) => row.id)).toEqual(["custom-model"]);
  });

  it("prefers an explicit genericBaseURL over the resolver seam", async () => {
    const urls: string[] = [];
    const adapter = createProviderAdapter("generic", {
      accountId: ACCOUNT,
      resolveKey: async () => "KEY-generic",
      fetchImpl: stubFetch(urls),
      genericBaseURL: "https://explicit.example.com/v1",
      resolveGenericEndpoint: () => "https://custom.example.com/v1",
    });
    const { request } = baseRequest();
    for await (const _event of adapter.complete(request)) {
      // Drain; assertions below.
    }
    expect(urls).toEqual(["https://explicit.example.com/v1/chat/completions"]);
  });

  it("refuses a generic key without an endpoint with a visible explanation", () => {
    const raw = "SECRET-generic-key";
    for (const options of [
      { accountId: ACCOUNT, resolveKey: async () => raw },
      {
        accountId: ACCOUNT,
        resolveKey: async () => raw,
        resolveGenericEndpoint: () => null,
      },
      {
        accountId: ACCOUNT,
        resolveKey: async () => raw,
        genericBaseURL: "   ",
        resolveGenericEndpoint: () => "  ",
      },
    ] as const) {
      let message = "";
      try {
        createProviderAdapter("generic" as ProviderId, options);
      } catch (error) {
        message = error instanceof Error ? error.message : "";
      }
      expect(message).toMatch(/without an endpoint is unusable/i);
      expect(message).toMatch(/no default endpoint/i);
      expect(message).not.toContain(raw);
    }
  });

  it("fails closed on an invalid configured endpoint without echoing key material", () => {
    const raw = "SECRET-generic-key";
    let message = "";
    try {
      createProviderAdapter("generic", {
        accountId: ACCOUNT,
        resolveKey: async () => raw,
        resolveGenericEndpoint: () => "https://user:pw@custom.example.com/v1",
      });
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    expect(message).toMatch(/baseurl/i);
    expect(message).not.toContain(raw);
  });
});
