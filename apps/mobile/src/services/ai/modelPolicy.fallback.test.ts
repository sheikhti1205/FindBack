import { describe, expect, it } from "vitest";
import type { ModelRecord } from "./providerContract";
import { priceFingerprint } from "./modelCatalog";
import { planModelFallback } from "./modelPolicy";

function record(
  provider: ModelRecord["provider"],
  id: string,
  priceClass: ModelRecord["priceClass"],
  input: readonly string[] = ["text"],
  entitlement: ModelRecord["entitlement"] = "verified",
): ModelRecord {
  const prices =
    priceClass === "free"
      ? [
          { amountDecimal: "0", currency: "USD", unit: "token", dimension: "input", sourceField: "pricing.prompt" },
          { amountDecimal: "0", currency: "USD", unit: "token", dimension: "output", sourceField: "pricing.completion" },
        ]
      : priceClass === "paid"
        ? [
            { amountDecimal: "0.000003", currency: "USD", unit: "token", dimension: "input", sourceField: "pricing.prompt" },
            { amountDecimal: "0.000015", currency: "USD", unit: "token", dimension: "output", sourceField: "pricing.completion" },
          ]
        : [];
  return {
    provider,
    id,
    input,
    output: ["text"],
    contextTokens: 128_000,
    prices,
    priceClass,
    retrievedAt: "2026-09-26T00:00:00.000Z",
    entitlement,
  } as ModelRecord;
}

const fingerprintOf = (r: ModelRecord): string => priceFingerprint(r);
const openCredential = (provider: ModelRecord["provider"]): boolean => provider === "openrouter";

describe("planModelFallback (M2, G11 model-level router)", () => {
  it("picks a free same-task alternative and never splices partial text", async () => {
    const catalog = [
      record("openrouter", "openrouter/free-a", "free"),
      record("openrouter", "openrouter/free-b", "free"),
    ];
    const result = planModelFallback({
      accountId: "acct-a",
      catalog,
      task: "general",
      currentModelId: "openrouter/free-a",
      approvedImageIds: [],
      mode: "free-only",
      fingerprintOf,
      hasCredential: openCredential,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.id).toBe("openrouter/free-b");
    expect(result.selection.mode).toBe("free-only");
    // The router moves selection only: it carries no answer/partial payload.
    expect("answer" in result).toBe(false);
    expect("partialText" in result).toBe(false);
    expect("delta" in result).toBe(false);
  });

  it("never transitions free-only into paid, even when only paid alternatives exist", async () => {
    const catalog = [
      record("openrouter", "openrouter/free-a", "free"),
      record("openrouter", "paid/model", "paid"),
    ];
    const result = planModelFallback({
      accountId: "acct-a",
      catalog,
      task: "general",
      currentModelId: "openrouter/free-a",
      approvedImageIds: [],
      mode: "free-only",
      fingerprintOf,
      hasCredential: openCredential,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("no-compatible-fallback");
  });

  it("never falls back to an unknown-price model, even in paid-explicit mode", async () => {
    const catalog = [
      record("openrouter", "openrouter/free-a", "free"),
      record("openrouter", "mystery/model", "unknown"),
    ];
    const result = planModelFallback({
      accountId: "acct-a",
      catalog,
      task: "general",
      currentModelId: "openrouter/free-a",
      approvedImageIds: [],
      mode: "paid-explicit",
      fingerprintOf,
      hasCredential: openCredential,
    });
    expect(result.ok).toBe(false);
  });

  it("with approved photos, never routes cross-provider and never drops to text-only", async () => {
    const catalog = [
      record("openrouter", "openrouter/vision-a", "free", ["text", "image"]),
      record("openrouter", "openrouter/text-b", "free", ["text"]),
      record("anthropic", "anthropic/vision-c", "free", ["text", "image"]),
    ];
    const result = planModelFallback({
      accountId: "acct-a",
      catalog,
      task: "image-question",
      currentModelId: "openrouter/vision-a",
      approvedImageIds: ["img-1"],
      mode: "free-only",
      fingerprintOf,
      hasCredential: () => true,
    });
    // Same-provider vision alternatives: none (text-b lacks vision, anthropic is
    // cross-provider) → explicit photo-pinned stop, never a silent switch.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("photo-provider-pinned");
  });

  it("with approved photos, accepts a same-provider vision alternative", async () => {
    const catalog = [
      record("openrouter", "openrouter/vision-a", "free", ["text", "image"]),
      record("openrouter", "openrouter/vision-b", "free", ["text", "image"]),
    ];
    const result = planModelFallback({
      accountId: "acct-a",
      catalog,
      task: "image-question",
      currentModelId: "openrouter/vision-a",
      approvedImageIds: ["img-1", "img-2"],
      mode: "free-only",
      fingerprintOf,
      hasCredential: openCredential,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.id).toBe("openrouter/vision-b");
    expect(result.record.input).toContain("image");
    expect(result.sameProvider).toBe(true);
  });

  it("skips blocked models and models without credentials", async () => {
    const catalog = [
      record("openrouter", "openrouter/free-a", "free"),
      record("openrouter", "openrouter/blocked-b", "free", ["text"], "blocked"),
      record("google", "google/free-c", "free"),
    ];
    const result = planModelFallback({
      accountId: "acct-a",
      catalog,
      task: "general",
      currentModelId: "openrouter/free-a",
      approvedImageIds: [],
      mode: "free-only",
      fingerprintOf,
      hasCredential: openCredential,
    });
    expect(result.ok).toBe(false);
  });
});
