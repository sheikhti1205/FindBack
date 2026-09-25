import { describe, expect, it } from "vitest";
import {
  formatPerMillionTokens,
  getNextPageLink,
  isCatalogStale,
  parseModelCatalog,
  priceFingerprint,
  supportsVision,
  type OpenRouterModelsResponse,
} from "./modelCatalog";

function baseModel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "meta-llama/llama-3-8b-instruct:free",
    canonical_slug: "meta-llama/llama-3-8b-instruct",
    name: "Llama 3 8B Instruct",
    created: 1692901234,
    description: "Test fixture model.",
    context_length: 8192,
    architecture: {
      modality: "text->text",
      input_modalities: ["text"],
      output_modalities: ["text"],
      tokenizer: "Llama3",
      instruct_type: "llama3",
    },
    pricing: { prompt: "0", completion: "0", request: "0", image: "0" },
    top_provider: { context_length: 8192, is_moderated: true, max_completion_tokens: 4096 },
    per_request_limits: null,
    supported_parameters: ["temperature"],
    default_parameters: null,
    supported_voices: null,
    links: { details: "/api/v1/models/meta-llama/llama-3-8b-instruct/endpoints" },
    ...overrides,
  };
}

function responseWith(models: Array<Record<string, unknown>>): OpenRouterModelsResponse {
  return {
    data: models as unknown as OpenRouterModelsResponse["data"],
    total_count: models.length,
    links: { next: null },
  };
}

describe("modelCatalog (P1 red)", () => {
  it("parses a free text model: zero lines stay exact strings, free class, real limits", () => {
    const [record] = parseModelCatalog(responseWith([baseModel()]), { retrievedAt: "2026-09-25T00:00:00.000Z" });
    expect(record?.provider).toBe("openrouter");
    expect(record?.id).toBe("meta-llama/llama-3-8b-instruct:free");
    expect(record?.input).toEqual(["text"]);
    expect(record?.output).toEqual(["text"]);
    expect(record?.priceClass).toBe("free");
    expect(record?.prices.map((p) => [p.dimension, p.amountDecimal, p.sourceField])).toContainEqual([
      "input",
      "0",
      "pricing.prompt",
    ]);
    expect(record?.contextTokens).toBe(8192);
    expect(record?.maxOutputTokens).toBe(4096);
    expect(record?.retrievedAt).toBe("2026-09-25T00:00:00.000Z");
    expect(record?.entitlement).toBe("untested");
  });

  it("marks output-paid/input-free as paid (suffix alone is not proof either way)", () => {
    const [record] = parseModelCatalog(
      responseWith([baseModel({ pricing: { prompt: "0", completion: "0.000001" } })]),
    );
    expect(record?.priceClass).toBe("paid");
  });

  it("keeps image/request/cache fees as separate price lines with source fields", () => {
    const [record] = parseModelCatalog(
      responseWith([
        baseModel({
          pricing: {
            prompt: "0",
            completion: "0",
            image: "0.002",
            request: "0.001",
            input_cache_read: "0.0000001",
          },
        }),
      ]),
    );
    expect(record?.priceClass).toBe("paid");
    const byDim = new Map((record?.prices ?? []).map((p) => [p.dimension, p]));
    expect(byDim.get("image")?.amountDecimal).toBe("0.002");
    expect(byDim.get("image")?.sourceField).toBe("pricing.image");
    expect(byDim.get("request")?.amountDecimal).toBe("0.001");
    expect(byDim.get("cache-read")?.sourceField).toBe("pricing.input_cache_read");
  });

  it("turns conditional overrides into variable lines with conditions", () => {
    const [record] = parseModelCatalog(
      responseWith([
        baseModel({
          pricing: {
            prompt: "0",
            completion: "0",
            overrides: [{ prompt: "0.00001", min_prompt_tokens: 200000 }],
          },
        }),
      ]),
    );
    expect(record?.priceClass).toBe("variable");
    const override = record?.prices.find((p) => p.sourceField === "pricing.overrides[0].prompt");
    expect(override?.amountDecimal).toBe("0.00001");
    expect(override?.conditions).toContain("200000");
  });

  it("treats invalid/missing decimals as unknown, never as free or zero", () => {
    const [bad, missing] = parseModelCatalog(
      responseWith([
        baseModel({ pricing: { prompt: "abc", completion: "0" } }),
        baseModel({ id: "x/y", pricing: { prompt: "0" } }),
      ]),
    );
    expect(bad?.priceClass).toBe("unknown");
    expect(bad?.prices).toEqual([]);
    expect(missing?.priceClass).toBe("unknown");
    expect(missing?.prices).toEqual([]);
  });

  it("skips invalid optional fees but keeps valid base lines", () => {
    const [record] = parseModelCatalog(
      responseWith([baseModel({ pricing: { prompt: "0", completion: "0", image: "n/a" } })]),
    );
    expect(record?.priceClass).toBe("free");
    expect(record?.prices.some((p) => p.dimension === "image")).toBe(false);
  });

  it("marks a paid model under a :free alias suffix as paid", () => {
    const [record] = parseModelCatalog(
      responseWith([
        baseModel({
          id: "openai/gpt-4o-mini:free",
          canonical_slug: "openai/gpt-4o-mini",
          pricing: { prompt: "0.00000015", completion: "0.0000006" },
        }),
      ]),
    );
    expect(record?.id).toBe("openai/gpt-4o-mini:free");
    expect(record?.priceClass).toBe("paid");
  });

  it("preserves alias ids without inventing a target id", () => {
    const [record] = parseModelCatalog(
      responseWith([
        baseModel({
          id: "anthropic/claude-latest",
          alias_target: { slug: "anthropic/claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
          pricing: { prompt: "0.000003", completion: "0.000015" },
        }),
      ]),
    );
    expect(record?.id).toBe("anthropic/claude-latest");
    expect(record?.priceClass).toBe("paid");
  });

  it("reports unsupported/absent vision honestly (no invented modalities)", () => {
    const [textOnly, noArch] = parseModelCatalog(
      responseWith([baseModel(), baseModel({ id: "x/noarch", architecture: null })]),
    );
    expect(supportsVision(textOnly!)).toBe(false);
    expect(textOnly?.input).toEqual(["text"]);
    expect(noArch?.input).toEqual([]);
    expect(noArch?.output).toEqual([]);
    expect(supportsVision(noArch!)).toBe(false);
    const [vision] = parseModelCatalog(
      responseWith([
        baseModel({
          id: "x/vision",
          architecture: {
            modality: "text+image->text",
            input_modalities: ["text", "image"],
            output_modalities: ["text"],
            tokenizer: "Other",
            instruct_type: null,
          },
        }),
      ]),
    );
    expect(supportsVision(vision!)).toBe(true);
  });

  it("leaves context/output limits undefined when absent (never 0, never invented)", () => {
    const [record] = parseModelCatalog(
      responseWith([
        baseModel({
          context_length: null,
          top_provider: { is_moderated: false },
          per_request_limits: null,
        }),
      ]),
    );
    expect(record?.contextTokens).toBeUndefined();
    expect(record?.maxOutputTokens).toBeUndefined();
    expect(record?.maxImagesPerCall).toBeUndefined();
  });

  it("maps blocked/verified entitlements and defaults to untested", () => {
    const [blocked, verified, def] = parseModelCatalog(
      responseWith([baseModel({ id: "a/1" }), baseModel({ id: "a/2" }), baseModel({ id: "a/3" })]),
      { blockedIds: ["a/1"], verifiedIds: ["a/2"] },
    );
    expect(blocked?.entitlement).toBe("blocked");
    expect(verified?.entitlement).toBe("verified");
    expect(def?.entitlement).toBe("untested");
  });

  it("flags stale or unparseable retrievedAt", () => {
    expect(isCatalogStale("2020-01-01T00:00:00.000Z", Date.parse("2026-09-25T00:00:00.000Z"))).toBe(true);
    expect(isCatalogStale("2026-09-25T00:00:00.000Z", Date.parse("2026-09-25T00:00:00.000Z"))).toBe(false);
    expect(isCatalogStale("not-a-date", Date.parse("2026-09-25T00:00:00.000Z"))).toBe(true);
  });

  it("formats USD-per-token decimals to per-1M strings with exact string math", () => {
    expect(formatPerMillionTokens("0.00003")).toBe("30");
    expect(formatPerMillionTokens("0")).toBe("0");
    expect(formatPerMillionTokens("0.00")).toBe("0");
    expect(formatPerMillionTokens("1.5")).toBe("1500000");
    expect(formatPerMillionTokens("0.0000001")).toBe("0.1");
    expect(formatPerMillionTokens("abc")).toBeNull();
    expect(formatPerMillionTokens("")).toBeNull();
  });

  it("changes fingerprint when any fee changes", () => {
    const [a] = parseModelCatalog(responseWith([baseModel({ pricing: { prompt: "0", completion: "0" } })]));
    const [b] = parseModelCatalog(
      responseWith([baseModel({ pricing: { prompt: "0.000001", completion: "0" } })]),
    );
    expect(priceFingerprint(a!)).not.toBe(priceFingerprint(b!));
    const [a2] = parseModelCatalog(responseWith([baseModel({ pricing: { prompt: "0", completion: "0" } })]));
    expect(priceFingerprint(a!)).toBe(priceFingerprint(a2!));
  });

  it("exposes pagination only as the documented links.next chain", () => {
    expect(getNextPageLink({ data: [], total_count: 0, links: { next: null } })).toBeNull();
    expect(
      getNextPageLink({
        data: [],
        total_count: 150,
        links: { next: "/api/v1/models?offset=500&limit=500" },
      }),
    ).toBe("/api/v1/models?offset=500&limit=500");
  });

  it("parses 1000 rows quickly with correct classes", () => {
    const models = Array.from({ length: 1000 }, (_, i) =>
      baseModel({
        id: `vendor/model-${i}`,
        pricing: i % 3 === 0 ? { prompt: "0", completion: "0" } : { prompt: "0.000001", completion: "0" },
      }),
    );
    const start = performance.now();
    const records = parseModelCatalog(responseWith(models));
    const elapsed = performance.now() - start;
    expect(records).toHaveLength(1000);
    expect(records.filter((r) => r.priceClass === "free")).toHaveLength(334);
    expect(elapsed).toBeLessThan(5000);
  });
});
