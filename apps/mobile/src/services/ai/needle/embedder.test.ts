import { describe, expect, it } from "vitest";
import {
  NEEDLE_EMBEDDING_DIM,
  NEEDLE_MODEL_BYTES,
  NEEDLE_MODEL_ID,
  NEEDLE_MODEL_REVISION,
  NativeNeedleEmbedder,
  StubNeedleEmbedder,
  validateNeedleVectors,
  type NativeNeedleBridge,
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

describe("NativeNeedleEmbedder", () => {
  function fakeBridge(vectors: number[][], available = true): NativeNeedleBridge {
    return {
      bridgeName: "test-needle-stub",
      isNeedleAvailable: async () => available,
      embeddingDimension: async () => vectors[0]?.length ?? 0,
      embedNeedleTexts: async () => vectors,
    };
  }

  it("serves the engine-probed dimension, never the stub constant", async () => {
    const vectors = [
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
    ];
    const embedder = new NativeNeedleEmbedder(fakeBridge(vectors), 3);
    expect(embedder.dimension).toBe(3);
    expect(embedder.modelId).toBe(NEEDLE_MODEL_ID);
    await expect(embedder.embedNeedleTexts(["a", "b"])).resolves.toEqual(vectors);
  });

  it("rejects a non-positive probed dimension at construction", () => {
    expect(() => new NativeNeedleEmbedder(fakeBridge([[0.1]]), 0)).toThrow();
  });

  it("fails closed while the engine is unavailable", async () => {
    const embedder = new NativeNeedleEmbedder(fakeBridge([[0.1, 0.2]], false), 2);
    await expect(embedder.embedNeedleTexts(["a"])).rejects.toThrow(/not available/);
  });

  it("rejects dimension-mismatched engine payloads", async () => {
    const embedder = new NativeNeedleEmbedder(fakeBridge([[0.1, 0.2, 0.3]]), 2);
    await expect(embedder.embedNeedleTexts(["a"])).rejects.toThrow();
  });

  it("pins the production model identity to the catalogue", () => {
    expect(NEEDLE_MODEL_ID).toBe("needle3-cact-l20");
    expect(NEEDLE_MODEL_REVISION).toBe("c7c415a3d1b3d929014bc6e866d51ebb971f7089");
    expect(NEEDLE_MODEL_BYTES).toBe(35335380);
  });
});
