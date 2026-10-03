/**
 * Provider registry tests (packet AI-024a).
 *
 * The registry is pure adapter wiring: every `ProviderId` resolves to the
 * adapter whose `id` matches, and the adapter's live credential always
 * arrives through the standard `(accountId, provider) => key` getter — no
 * key material is embedded, logged, or echoed in errors.
 */
import { describe, expect, it, vi } from "vitest";
import { SUPPORTED_AI_PROVIDERS } from "../browserAiCredentials";
import type { NormalizedRequest, ProviderId } from "./providerContract";
import { createProviderAdapter } from "./providerRegistry";
import { ApplicationAiService } from "./applicationAi";

const ACCOUNT = "registry-acct-1";

function baseRequest(provider: ProviderId): { request: NormalizedRequest; controller: AbortController } {
  const controller = new AbortController();
  return {
    controller,
    request: {
      selection: { accountId: ACCOUNT, provider, modelId: `${provider}/test-model`, mode: "free-only" },
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

const NEW_FIVE: readonly ProviderId[] = ["mistral", "groq", "xai", "cohere", "generic"];

describe("providerRegistry", () => {
  it("resolves every supported provider id to the matching adapter", () => {
    for (const provider of SUPPORTED_AI_PROVIDERS) {
      const adapter = createProviderAdapter(provider, {
        accountId: ACCOUNT,
        resolveKey: async () => null,
        genericBaseURL: "https://api.example.com/v1",
        assembleSystemText: () => undefined,
      });
      expect(adapter.id).toBe(provider);
    }
  });

  it("routes each new-five adapter credential through the standard getter seam", async () => {
    for (const provider of NEW_FIVE) {
      const seen: Array<{ accountId: string; provider: ProviderId }> = [];
      const expectedKey = `REGISTRY-KEY-${provider}`;
      const resolveKey = vi.fn(async (accountId: string, slot: ProviderId) => {
        seen.push({ accountId, provider: slot });
        return slot === provider ? expectedKey : null;
      });
      const headers: Array<Record<string, string>> = [];
      const fetchImpl = (async (url: unknown, init?: RequestInit) => {
        headers.push({ ...(init?.headers as Record<string, string>), "x-url": String(url) });
        return new Response(JSON.stringify({ message: "nope" }), { status: 401 });
      }) as typeof fetch;
      const adapter = createProviderAdapter(provider, {
        accountId: ACCOUNT,
        resolveKey,
        fetchImpl,
        genericBaseURL: "https://api.example.com/v1",
      });
      expect(adapter.id).toBe(provider);
      const { request } = baseRequest(provider);
      const events = [];
      for await (const event of adapter.complete(request)) events.push(event);
      // The vault getter was consulted for exactly this account/provider slot.
      expect(seen).toEqual([{ accountId: ACCOUNT, provider }]);
      // The resolved key reached the wire as a Bearer credential and nothing else did.
      expect(headers).toHaveLength(1);
      expect(headers[0]!["Authorization"]).toBe(`Bearer ${expectedKey}`);
      expect(JSON.stringify(events)).not.toContain(expectedKey);
      // Terminated (error + done) rather than hanging on the stubbed 401.
      expect(events[events.length - 1]!.kind).toBe("done");
    }
  });

  it("sends generic completions to the caller-supplied baseURL", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: unknown) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ message: "nope" }), { status: 401 });
    }) as typeof fetch;
    const adapter = createProviderAdapter("generic", {
      accountId: ACCOUNT,
      resolveKey: async () => "REGISTRY-KEY-generic",
      fetchImpl,
      genericBaseURL: "https://api.example.com/v1/",
    });
    const { request } = baseRequest("generic");
    for await (const _event of adapter.complete(request)) {
      // Drain; assertions below.
    }
    expect(urls).toHaveLength(1);
    expect(urls[0]).toBe("https://api.example.com/v1/chat/completions");
  });

  it("requires a generic baseURL instead of inventing one", () => {
    expect(() =>
      createProviderAdapter("generic", { accountId: ACCOUNT, resolveKey: async () => null }),
    ).toThrow(/base ?URL|without an endpoint is unusable/i);
  });

  it("requires caller-owned system text for openai instead of inventing policy", () => {
    expect(() =>
      createProviderAdapter("openai", { accountId: ACCOUNT, resolveKey: async () => null }),
    ).toThrow(/assembleSystemText/i);
  });

  it("refuses offline on web with platform truth", () => {
    expect(() =>
      createProviderAdapter("offline", { accountId: ACCOUNT, resolveKey: async () => null }),
    ).toThrow(/Android/i);
  });

  it("binds Android offline to the shared service without reading a vault slot", async () => {
    const service = new ApplicationAiService({ android: true, driver: {
      rootDir: async () => "/private/ai-models", freeBytes: async () => 1e9,
      stagedSize: async () => 0, readJournalText: async () => null,
      download: async () => { throw new Error("unexpected download"); },
      cancelDownload: async () => {}, hashFile: async () => { throw new Error("missing"); },
      promoteFile: async () => {}, removeFile: async () => {},
    } });
    const adapter = createProviderAdapter("offline", {
      accountId: ACCOUNT, resolveKey: async () => { throw new Error("offline must never read credentials"); }, offlineService: service,
    });
    expect(adapter.id).toBe("offline");
    expect(await adapter.listModels?.()).toEqual([]);
  });

  it("rejects unknown providers without echoing key material", () => {
    const raw = "REGISTRY-SECRET-xyz";
    const bogus = "bogus" as unknown as ProviderId;
    expect(() => createProviderAdapter(bogus, { accountId: ACCOUNT, resolveKey: async () => raw })).toThrow(
      /provider/i,
    );
    try {
      createProviderAdapter(bogus, { accountId: ACCOUNT, resolveKey: async () => raw });
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(raw);
    }
  });
});
