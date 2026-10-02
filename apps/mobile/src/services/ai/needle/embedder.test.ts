import { describe, expect, it } from "vitest";
import {
  NEEDLE_EMBEDDING_DIM,
  StubNeedleEmbedder,
  validateNeedleVectors,
} from "./embedder";

describe("StubNeedleEmbedder", () => {
  it("exposes a positive dimension constant", () => {
    expect(NEEDLE_EMBEDDING_DIM).toBeGreaterThan(0);
    expect(Number.isInteger(NEEDLE_EMBEDDING_DIM)).toBe(true);
    expect(new StubNeedleEmbedder().dimension).toBe(NEEDLE_EMBEDDING_DIM);
  });

  it("returns one finite vector of the declared dimension per input", async () => {
    const embedder = new StubNeedleEmbedder();
    const vectors = await embedder.embedNeedleTexts(["black umbrella", "wooden handle"]);
    expect(vectors).toHaveLength(2);
    for (const row of vectors) {
      expect(row).toHaveLength(NEEDLE_EMBEDDING_DIM);
      for (const value of row) {
        expect(typeof value).toBe("number");
        expect(Number.isFinite(value)).toBe(true);
      }
    }
    expect(validateNeedleVectors(["black umbrella", "wooden handle"], vectors)).toEqual(vectors);
  });

  it("is deterministic per input text", async () => {
    const embedder = new StubNeedleEmbedder();
    const first = await embedder.embedNeedleTexts(["black umbrella"]);
    const second = await embedder.embedNeedleTexts(["black umbrella"]);
    expect(second).toEqual(first);
  });

  it("rejects blank and over-long inputs without calling a model", async () => {
    const embedder = new StubNeedleEmbedder();
    await expect(embedder.embedNeedleTexts(["   "])).rejects.toThrow();
    await expect(embedder.embedNeedleTexts(["x".repeat(5001)])).rejects.toThrow();
  });

  it("rejects ragged or non-finite payloads", () => {
    expect(() => validateNeedleVectors(["a", "b"], [[0.1]])).toThrow();
    expect(() =>
      validateNeedleVectors(["a", "b"], [
        [0.1, 0.2],
        [0.3, 0.4, 0.5],
      ]),
    ).toThrow();
    expect(() =>
      validateNeedleVectors(["a"], [[0.1, Number.POSITIVE_INFINITY]]),
    ).toThrow();
  });
});
