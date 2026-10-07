import { describe, expect, it } from "vitest";
import { embedTextsOp, type EmbedTextsInput } from "./embedTexts";
import { getTaskSpec } from "../orchestrator/taskRegistry";

function invalid(input: unknown): ReturnType<typeof embedTextsOp> {
  return embedTextsOp(input as unknown as EmbedTextsInput);
}

describe("embed-texts op", () => {
  it("validates and normalizes retrieval texts", async () => {
    const result = await embedTextsOp({ texts: ["  black umbrella  ", "red backpack"], mode: "retrieval" });
    expect(result).toEqual({
      ok: true,
      value: { texts: ["black umbrella", "red backpack"], mode: "retrieval" },
    });
  });

  it("defaults to retrieval mode", async () => {
    const result = await embedTextsOp({ texts: ["keys"] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.mode).toBe("retrieval");
  });

  it("rejects non-object and non-array payloads (invalid shape)", async () => {
    const nonObject = await invalid("just a string");
    expect(nonObject.ok).toBe(false);
    if (!nonObject.ok) expect(nonObject.error.diagnostic).toBe("R1_BAD_EMBED_OBJECT");

    const nonArray = await invalid({ texts: "not an array" });
    expect(nonArray.ok).toBe(false);
    if (!nonArray.ok) expect(nonArray.error.diagnostic).toBe("R1_BAD_FIELD:texts");

    const nonStringItem = await invalid({ texts: ["ok", 42] });
    expect(nonStringItem.ok).toBe(false);
    if (!nonStringItem.ok) expect(nonStringItem.error.diagnostic).toBe("R1_BAD_FIELD:texts");
  });

  it("rejects modes outside the allowlist (invalid enum)", async () => {
    const result = await invalid({ texts: ["keys"], mode: "semantic" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.errorClass).toBe("INVALID_OUTPUT");
      expect(result.error.diagnostic).toBe("R1_UNKNOWN_MODE:semantic");
    }
  });

  it("rejects oversize batches and texts", async () => {
    const tooMany = await embedTextsOp({ texts: Array.from({ length: 33 }, (_, i) => `item ${i}`) });
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(tooMany.error.diagnostic).toBe("R5_TOO_MANY_TEXTS");

    const tooLong = await embedTextsOp({ texts: ["z".repeat(501)] });
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) expect(tooLong.error.diagnostic).toBe("R5_FIELD_TOO_LONG:text");
  });

  it("rejects blanks and exact duplicates (business rules)", async () => {
    const blank = await embedTextsOp({ texts: ["   "] });
    expect(blank.ok).toBe(false);
    if (!blank.ok) expect(blank.error.diagnostic).toBe("R4_BLANK_TEXT");

    const duplicate = await embedTextsOp({ texts: ["keys", "Keys"] });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.error.diagnostic).toBe("R1_BUSINESS_RULE:DUPLICATE_TEXT");
  });

  it("surfaces cancellation without validating", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await embedTextsOp({ texts: ["keys"] }, { signal: controller.signal });
    expect(result).toEqual({ ok: false, error: { errorClass: "CANCELLED", diagnostic: "ABORT_BEFORE_START" } });
  });

  it("carries a canonical embedding envelope with no consent flag", () => {
    const spec = getTaskSpec("embed-texts")!;
    expect(spec.taskId).toBe("embed-texts");
    expect(spec.maxOutputTokens).toBe(0);
    expect(spec.timeoutMs).toBeGreaterThan(0);
    expect(spec.privacy.tier).toBe("local-only");
    expect(spec.runtimes).toEqual(["local-embedding"]);
    expect(spec.consent.required).toBe(false);
  });
});
