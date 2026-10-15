import { describe, expect, it } from "vitest";
import { classifyCategory } from "./classifyCategory";
import { getTaskSpec } from "../orchestrator/taskRegistry";
import type { GenerateFn } from "../types";
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

  it("reports an engine failure honestly instead of relabelling it a cancellation", async () => {
    const generate: GenerateFn & { calls: number } = Object.assign(
      async (): Promise<string> => {
        generate.calls += 1;
        throw new Error("No available runtime for this task.");
      },
      { calls: 0 },
    );
    const result = await classifyCategory(generate, { text: "a black wallet" }, mustProfile(PROFILE));
    expect(result).toEqual({
      ok: false,
      error: { errorClass: "RUNTIME_ERROR", diagnostic: "CATEGORY_GENERATION_FAILED" },
    });
    expect(generate.calls).toBe(1);
  });

  it("still reports CANCELLED when generate fails while the signal aborts", async () => {
    const controller = new AbortController();
    const generate: GenerateFn = async () => {
      controller.abort();
      throw new Error("native stopped");
    };
    const result = await classifyCategory(generate, { text: "keys" }, mustProfile(PROFILE), {
      signal: controller.signal,
    });
    expect(result).toEqual({
      ok: false,
      error: { errorClass: "CANCELLED", diagnostic: "ABORT_MID_GENERATION" },
    });
  });

  it("reports CANCELLED for a route-level abort even when the caller's signal is not aborted", async () => {
    // `liveGenerateFor` turns a route-level cancel (residency coordinator,
    // logout / account switch) into a name-`AbortError` rejection while the
    // caller's own signal stays live. That is still a cancellation, not an
    // engine failure — and it must never render as one.
    const generate: GenerateFn = async () => {
      const error = new Error("AI request cancelled.");
      error.name = "AbortError";
      throw error;
    };
    const controller = new AbortController();
    const result = await classifyCategory(generate, { text: "keys" }, mustProfile(PROFILE), {
      signal: controller.signal,
    });
    expect(result).toEqual({
      ok: false,
      error: { errorClass: "CANCELLED", diagnostic: "ABORT_MID_GENERATION" },
    });
    expect(controller.signal.aborted).toBe(false);
  });

  it("carries the canonical task envelope with budgets, runtimes, timeout, and no route consent", () => {
    const spec = getTaskSpec("classify-category")!;
    expect(spec.taskId).toBe("classify-category");
    expect(spec.maxInputChars).toBe(280);
    expect(spec.maxOutputTokens).toBeGreaterThan(0);
    expect(spec.timeoutMs).toBeGreaterThan(0);
    expect(spec.privacy.tier).toBe("local-only");
    expect(spec.runtimes).toContain("local-text");
    expect(spec.consent.required).toBe(false);
  });
});
