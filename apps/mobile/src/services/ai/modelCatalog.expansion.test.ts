import { describe, expect, it } from "vitest";
import type { ModelRecord, ProviderId } from "./providerContract";
import {
  applyEntitlements,
  fixedFallbackCatalog,
  isFastRecord,
  loadAuthorizedCatalog,
} from "./modelCatalog";
import { priceFingerprint } from "./modelCatalog";
import {
  authorizePaidSelection,
  defaultSelection,
  planModelFallback,
  resolveSelection,
} from "./modelPolicy";

function freeRecord(provider: ProviderId, id: string, input: readonly string[] = ["text"]): ModelRecord {
  return {
    provider,
    id,
    input,
    output: ["text"],
    contextTokens: 128_000,
    prices: [
      { amountDecimal: "0", currency: "USD", unit: "token", dimension: "input", sourceField: "pricing.prompt" },
      { amountDecimal: "0", currency: "USD", unit: "token", dimension: "output", sourceField: "pricing.completion" },
    ],
    priceClass: "free",
    retrievedAt: "2026-09-26T00:00:00.000Z",
    entitlement: "verified",
  };
}

function paidRecord(provider: ProviderId, id: string): ModelRecord {
  return {
    ...freeRecord(provider, id),
    prices: [
      { amountDecimal: "0.000003", currency: "USD", unit: "token", dimension: "input", sourceField: "pricing.prompt" },
      { amountDecimal: "0.000015", currency: "USD", unit: "token", dimension: "output", sourceField: "pricing.completion" },
    ],
    priceClass: "paid",
  };
}

const fingerprintOf = (record: ModelRecord): string => priceFingerprint(record);

describe("modelCatalog expansion (AI-024b)", () => {
  it("builds honest fixed fallbacks for providers with no list endpoint (unknown, never priced)", () => {
    const records = fixedFallbackCatalog({
      provider: "cohere",
      ids: ["command-r-plus"],
      retrievedAt: "2026-09-26T00:00:00.000Z",
    });
    expect(records).toHaveLength(1);
    expect(records[0]?.provider).toBe("cohere");
    expect(records[0]?.prices).toEqual([]);
    expect(records[0]?.priceClass).toBe("unknown");
    expect(records[0]?.input).toEqual(["text"]);
    const blocked = fixedFallbackCatalog({
      provider: "generic",
      ids: ["local-model"],
      blockedIds: ["local-model"],
    });
    expect(blocked[0]?.entitlement).toBe("blocked");
  });

  it("loads the authorized catalogue: merges listed rows and skips failing providers", async () => {
    const groqRows = [freeRecord("groq", "llama-3.3-70b-versatile")];
    const records = await loadAuthorizedCatalog({
      accountId: "acct-1",
      providers: ["groq", "xai", "cohere"],
      hasCredential: async (provider) => provider !== "cohere",
      listModels: async (provider) => {
        if (provider === "groq") return groqRows;
        throw new Error("xai unreachable");
      },
      retrievedAt: "2026-09-26T00:00:00.000Z",
    });
    expect(records.some((r) => r.id === "llama-3.3-70b-versatile")).toBe(true);
    expect(records.some((r) => r.provider === "xai")).toBe(false);
    expect(records.some((r) => r.provider === "cohere")).toBe(false);
  });

  it("dedupes repeated ids", async () => {
    const rows = [freeRecord("mistral", "mistral-small-latest"), freeRecord("mistral", "mistral-small-latest")];
    const records = await loadAuthorizedCatalog({
      accountId: "acct-1",
      providers: ["mistral"],
      hasCredential: async () => true,
      listModels: async () => rows,
    });
    expect(records.filter((r) => r.id === "mistral-small-latest")).toHaveLength(1);
  });

  it("applies blocked/verified entitlements without inventing rows", () => {
    const rows = [freeRecord("groq", "a"), freeRecord("groq", "b")];
    const stamped = applyEntitlements(rows, { blockedIds: ["a"], verifiedIds: ["b"] });
    expect(stamped.find((r) => r.id === "a")?.entitlement).toBe("blocked");
    expect(stamped.find((r) => r.id === "b")?.entitlement).toBe("verified");
    expect(stamped).toHaveLength(2);
  });

  it("pins the Fast heuristic: free, text-only, known window — never vision/paid/unknown", () => {
    expect(isFastRecord(freeRecord("groq", "a"))).toBe(true);
    expect(isFastRecord(freeRecord("groq", "v", ["text", "image"]))).toBe(false);
    expect(isFastRecord(paidRecord("mistral", "p"))).toBe(false);
    expect(isFastRecord({ ...freeRecord("xai", "u"), prices: [], priceClass: "unknown" })).toBe(false);
    expect(isFastRecord({ ...freeRecord("cohere", "w"), contextTokens: undefined })).toBe(false);
  });
});

describe("modelPolicy over the expanded catalogue (AI-024b)", () => {
  it("keeps the default selection free-only safe on the free route", () => {
    const selection = defaultSelection("acct-9");
    expect(selection).toEqual({
      accountId: "acct-9",
      provider: "openrouter",
      modelId: "openrouter/free",
      mode: "free-only",
    });
  });

  it("resolves free rows for the new providers without consent", () => {
    for (const provider of ["groq", "xai", "mistral", "cohere", "generic"] as const) {
      const row = freeRecord(provider, `${provider}-row`);
      const resolved = resolveSelection({
        accountId: "acct-1",
        catalog: [row],
        task: "app-help",
        desiredModelId: row.id,
        fingerprintOf,
      });
      expect(resolved.ok).toBe(true);
    }
  });

  it("gates paid rows for new providers: free-only never, consent per task scope", () => {
    const paid = paidRecord("mistral", "mistral-large-latest");
    const catalog = [freeRecord("openrouter", "openrouter/free"), paid];
    expect(
      resolveSelection({ accountId: "a", catalog, task: "general", desiredModelId: paid.id, fingerprintOf }).ok,
    ).toBe(false);
    const consent = authorizePaidSelection({
      accountId: "a",
      record: paid,
      fingerprint: fingerprintOf(paid),
      taskScopes: ["report-draft"],
      acceptedAt: "2026-09-26T00:00:00.000Z",
    }).paidConsent;
    expect(
      resolveSelection({
        accountId: "a",
        catalog,
        task: "report-draft",
        desiredModelId: paid.id,
        mode: "paid-explicit",
        paidConsent: consent,
        fingerprintOf,
      }).ok,
    ).toBe(true);
    expect(
      resolveSelection({
        accountId: "a",
        catalog,
        task: "general",
        desiredModelId: paid.id,
        mode: "paid-explicit",
        paidConsent: consent,
        fingerprintOf,
      }).ok,
    ).toBe(false);
  });

  it("never consents to unknown-priced rows", () => {
    const unknown: ModelRecord = { ...freeRecord("openai", "openai/unknown"), prices: [], priceClass: "unknown" };
    const consent = authorizePaidSelection({
      accountId: "a",
      record: unknown,
      fingerprint: fingerprintOf(unknown),
      taskScopes: ["general"],
      acceptedAt: "2026-09-26T00:00:00.000Z",
    }).paidConsent;
    const resolved = resolveSelection({
      accountId: "a",
      catalog: [freeRecord("openrouter", "openrouter/free"), unknown],
      task: "general",
      desiredModelId: unknown.id,
      mode: "paid-explicit",
      paidConsent: consent,
      fingerprintOf,
    });
    expect(resolved.ok).toBe(false);
  });

  it("prefers same-provider fallback across the new providers", () => {
    const catalog = [
      freeRecord("groq", "groq-a"),
      freeRecord("groq", "groq-b"),
      freeRecord("xai", "xai-c"),
    ];
    const result = planModelFallback({
      accountId: "a",
      catalog,
      task: "general",
      currentModelId: "groq-a",
      approvedImageIds: [],
      mode: "free-only",
      fingerprintOf,
      hasCredential: () => true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.provider).toBe("groq");
    expect(result.sameProvider).toBe(true);
  });

  it("keeps photo requests pinned to the provider across new providers", () => {
    const catalog = [
      freeRecord("groq", "groq-vision", ["text", "image"]),
      freeRecord("xai", "xai-vision", ["text", "image"]),
    ];
    const result = planModelFallback({
      accountId: "a",
      catalog,
      task: "image-question",
      currentModelId: "groq-vision",
      approvedImageIds: ["img-1"],
      mode: "free-only",
      fingerprintOf,
      hasCredential: () => true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("photo-provider-pinned");
  });

  it("skips offline rows unless explicitly allowed with a credential", () => {
    const catalog = [freeRecord("groq", "groq-a"), { ...freeRecord("offline", "smolvlm2-500m-text") }];
    const skipped = planModelFallback({
      accountId: "a",
      catalog,
      task: "general",
      currentModelId: "groq-a",
      approvedImageIds: [],
      mode: "free-only",
      fingerprintOf,
      hasCredential: () => true,
    });
    expect(skipped.ok).toBe(false);
    const allowed = planModelFallback({
      accountId: "a",
      catalog,
      task: "general",
      currentModelId: "groq-a",
      approvedImageIds: [],
      mode: "free-only",
      fingerprintOf,
      hasCredential: () => true,
      allowOffline: true,
    });
    expect(allowed.ok).toBe(true);
    if (!allowed.ok) return;
    expect(allowed.record.provider).toBe("offline");
  });

  it("asks before paid fallback on new providers: consent required, then reused verbatim", () => {
    const paid = paidRecord("xai", "grok-paid");
    const catalog = [freeRecord("xai", "xai-free"), paid];
    const gated = planModelFallback({
      accountId: "a",
      catalog,
      task: "general",
      currentModelId: "xai-free",
      approvedImageIds: [],
      mode: "paid-explicit",
      fingerprintOf,
      hasCredential: () => true,
    });
    expect(gated.ok).toBe(false);
    const consent = authorizePaidSelection({
      accountId: "a",
      record: paid,
      fingerprint: fingerprintOf(paid),
      taskScopes: ["general"],
      acceptedAt: "2026-09-26T00:00:00.000Z",
    }).paidConsent;
    const result = planModelFallback({
      accountId: "a",
      catalog,
      task: "general",
      currentModelId: "xai-free",
      approvedImageIds: [],
      mode: "paid-explicit",
      paidConsent: consent,
      fingerprintOf,
      hasCredential: () => true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.selection.mode).toBe("paid-explicit");
    expect(result.selection.paidConsent).toBe(consent);
  });
});
