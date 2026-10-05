// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { stubGenerate, mustProfile } from "./ai/ops/testSupport";
import {
  buildCategorySuggestionFromClassification,
  buildCategorySuggestionFromPhoto,
  DROPPED_CATEGORY_SUGGESTION_NOTE,
  ITEM_CATEGORY_TO_RELEASED,
  resolveCategorySuggestion,
  suggestCategoryForText,
} from "./categorySuggestion";

const PROFILE = mustProfile("qwen3-0.6b-dynamic-int4");

describe("resolveCategorySuggestion (pure resolver)", () => {
  it("passes a released canonical straight through (photo path)", () => {
    expect(resolveCategorySuggestion("Phones & Tablets", "photo")).toEqual({
      suggestion: { suggestedCategory: "Phones & Tablets", source: "photo" },
      dropped: false,
    });
  });

  it("maps every lowercase op value to a released form label", () => {
    for (const [raw, mapped] of Object.entries(ITEM_CATEGORY_TO_RELEASED)) {
      const resolved = resolveCategorySuggestion(raw, "classify-category", 0.9);
      expect(resolved.dropped).toBe(false);
      expect(resolved.suggestion).toEqual({
        suggestedCategory: mapped,
        source: "classify-category",
        confidence: 0.9,
      });
    }
  });

  it("maps known text examples to the confirmed form categories", () => {
    expect(resolveCategorySuggestion("electronics", "classify-category").suggestion?.suggestedCategory).toBe(
      "Electronics",
    );
    expect(resolveCategorySuggestion("keys", "classify-category").suggestion?.suggestedCategory).toBe("Keys");
    expect(resolveCategorySuggestion("bags", "classify-category").suggestion?.suggestedCategory).toBe(
      "Bags & Wallets",
    );
  });

  it("downgrades unknown categories to null + dropped (user picks manually)", () => {
    const resolved = resolveCategorySuggestion("spaceship", "classify-category");
    expect(resolved).toEqual({ suggestion: null, dropped: true });
    expect(DROPPED_CATEGORY_SUGGESTION_NOTE).toMatch(/left out/);
  });

  it("returns null without dropped for empty input (nothing suggested)", () => {
    expect(resolveCategorySuggestion(null, "photo")).toEqual({ suggestion: null, dropped: false });
    expect(resolveCategorySuggestion("   ", "classify-category")).toEqual({ suggestion: null, dropped: false });
  });
});

describe("buildCategorySuggestion helpers", () => {
  it("builds a confirmable suggestion from a classification", () => {
    expect(buildCategorySuggestionFromClassification({ category: "electronics", confidence: 0.8 })).toEqual({
      suggestion: { suggestedCategory: "Electronics", source: "classify-category", confidence: 0.8 },
      dropped: false,
    });
  });

  it("builds a confirmable suggestion from a photo category", () => {
    expect(buildCategorySuggestionFromPhoto("Keys")).toEqual({
      suggestion: { suggestedCategory: "Keys", source: "photo" },
      dropped: false,
    });
  });
});

describe("suggestCategoryForText (classify-category consumer, fakes only)", () => {
  it("returns a user-confirmable suggestion from fake classification", async () => {
    const generate = stubGenerate('{"category":"electronics","confidence":0.8}');
    const result = await suggestCategoryForText(generate, "black wireless headphones", PROFILE);
    expect(result).toEqual({
      ok: true,
      value: {
        suggestion: { suggestedCategory: "Electronics", source: "classify-category", confidence: 0.8 },
        dropped: false,
      },
    });
    expect(generate.calls).toBe(1);
  });

  it("fails closed on an out-of-vocabulary category (never a silent suggestion)", async () => {
    const generate = stubGenerate('{"category":"spaceship"}');
    const result = await suggestCategoryForText(generate, "a strange metal object", PROFILE);
    // Fails closed at the op validator: unknown enum never becomes a suggestion.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.diagnostic).toBe("R1_UNKNOWN_CATEGORY:spaceship");
  });

  it("fails closed on mistyped confidence (no silent suggestion)", async () => {
    const generate = stubGenerate('{"category":"keys","confidence":"high"}');
    const result = await suggestCategoryForText(generate, "keys", PROFILE);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.diagnostic).toBe("R1_BAD_CONFIDENCE");
  });

  it("never calls generate when already aborted", async () => {
    const generate = stubGenerate('{"category":"keys"}');
    const controller = new AbortController();
    controller.abort();
    const result = await suggestCategoryForText(generate, "keys", PROFILE, { signal: controller.signal });
    expect(result).toEqual({ ok: false, error: { errorClass: "CANCELLED", diagnostic: "ABORT_BEFORE_START" } });
    expect(generate.calls).toBe(0);
  });

  it("aborts mid-generation cleanly with no fallback side effects", async () => {
    let release!: (text: string) => void;
    const pending = new Promise<string>((resolve) => {
      release = resolve;
    });
    const generate = Object.assign(
      async () => {
        generate.calls += 1;
        return pending;
      },
      { calls: 0 },
    );
    const controller = new AbortController();
    const task = suggestCategoryForText(generate, "keys", PROFILE, { signal: controller.signal });
    controller.abort();
    release('{"category":"keys"}');
    const result = await task;
    expect(result).toEqual({ ok: false, error: { errorClass: "CANCELLED", diagnostic: "ABORT_MID_GENERATION" } });
    // Exactly one transport call was in flight; no retry, no second op.
    expect(generate.calls).toBe(1);
  });

  it("rejects coordinates input before calling generate", async () => {
    const generate = stubGenerate('{"category":"bags"}');
    const result = await suggestCategoryForText(generate, "bag lost at 12.3456, 65.4321", PROFILE);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.diagnostic).toBe("R5_COORDINATES_NOT_ACCEPTED:text");
    expect(generate.calls).toBe(0);
  });
});
