import { describe, expect, it } from "vitest";
import { classifyCategory, classifyCategoryTaskSpec } from "./classifyCategory";
import { mustProfile, stubGenerate } from "./testSupport";

const PROFILE = "qwen3-0.6b-dynamic-int4";

describe("classify-category op", () => {
  it("classifies item text into the category vocabulary", async () => {
    const result = await classifyCategory(
      stubGenerate('{"category":"electronics","confidence":0.8}'),
      { text: "black wireless headphones" },
      mustProfile(PROFILE),
    );
    expect(result).toEqual({ ok: true, value: { category: "electronics", confidence: 0.8 } });
  });

  it("accepts a bare category without confidence", async () => {
    const result = await classifyCategory(
      stubGenerate('{"category":"keys"}'),
      { text: "a ring with two metal keys" },
      mustProfile(PROFILE),
    );
    expect(result).toEqual({ ok: true, value: { category: "keys" } });
  });

  it("rejects non-object payloads and mistyped confidence (invalid shape)", async () => {
    const nonObject = await classifyCategory(stubGenerate("[1, 2, 3]"), { text: "keys" }, mustProfile(PROFILE));
    expect(nonObject.ok).toBe(false);
    if (!nonObject.ok) expect(nonObject.error.errorClass).toBe("INVALID_OUTPUT");

    const mistyped = await classifyCategory(
      stubGenerate('{"category":"keys","confidence":"high"}'),
      { text: "keys" },
      mustProfile(PROFILE),
    );
    expect(mistyped.ok).toBe(false);
    if (!mistyped.ok) expect(mistyped.error.diagnostic).toBe("R1_BAD_CONFIDENCE");
  });

  it("rejects categories outside the vocabulary (invalid enum)", async () => {
    const result = await classifyCategory(
      stubGenerate('{"category":"spaceship"}'),
      { text: "a strange metal object" },
      mustProfile(PROFILE),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.errorClass).toBe("INVALID_OUTPUT");
      expect(result.error.diagnostic).toBe("R1_UNKNOWN_CATEGORY:spaceship");
    }
  });

  it("rejects oversize input before calling generate", async () => {
    const generate = stubGenerate('{"category":"other"}');
    const result = await classifyCategory(generate, { text: "w".repeat(281) }, mustProfile(PROFILE));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.diagnostic).toBe("R5_INPUT_TOO_LONG:text");
    expect(generate.calls).toBe(0);
  });

  it("rejects coordinates in category input (business rule)", async () => {
    const generate = stubGenerate('{"category":"bags"}');
    const result = await classifyCategory(generate, { text: "bag lost at 12.3456, 65.4321" }, mustProfile(PROFILE));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.diagnostic).toBe("R5_COORDINATES_NOT_ACCEPTED:text");
    expect(generate.calls).toBe(0);
  });

  it("surfaces cancellation without calling generate", async () => {
    const generate = stubGenerate('{"category":"keys"}');
    const controller = new AbortController();
    controller.abort();
    const result = await classifyCategory(generate, { text: "keys" }, mustProfile(PROFILE), {
      signal: controller.signal,
    });
    expect(result).toEqual({ ok: false, error: { errorClass: "CANCELLED", diagnostic: "ABORT_BEFORE_START" } });
    expect(generate.calls).toBe(0);
  });

  it("carries a local-only envelope with budgets, runtimes, timeout, and no consent", () => {
    expect(classifyCategoryTaskSpec.task).toBe("classify-category");
    expect(classifyCategoryTaskSpec.maxInputChars).toBe(280);
    expect(classifyCategoryTaskSpec.maxOutputTokens).toBeGreaterThan(0);
    expect(classifyCategoryTaskSpec.timeoutMs).toBeGreaterThan(0);
    expect(classifyCategoryTaskSpec.privacy.tier).toBe("local-only");
    expect(classifyCategoryTaskSpec.runtimes).toContain("litert-lm");
    expect(classifyCategoryTaskSpec.consent.required).toBe(false);
  });
});
