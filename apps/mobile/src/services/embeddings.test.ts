import { beforeEach, describe, expect, it, vi } from "vitest";

const { embedMock, nativePlatform } = vi.hoisted(() => ({
  embedMock: vi.fn(),
  nativePlatform: { isNative: true },
}));
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => nativePlatform.isNative },
  registerPlugin: (name: string) => name === "FindBackEmbeddings" ? { embedTexts: embedMock } : null,
}));

import { embeddingInput, embedTexts } from "./embeddings";

beforeEach(() => {
  embedMock.mockReset();
  nativePlatform.isNative = true;
});

describe("embeddingInput", () => {
  it("trims and joins title and description", () => {
    expect(embeddingInput("  black umbrella ", " wooden handle ")).toBe("black umbrella\nwooden handle");
    expect(embeddingInput("", "only desc")).toBe("only desc");
  });
});

describe("embedTexts", () => {
  it("forwards to the native bridge and returns raw vectors", async () => {
    embedMock.mockResolvedValue({ vectors: [[0.1, 0.2]] });
    await expect(embedTexts(["a"])).resolves.toEqual([[0.1, 0.2]]);
    expect(embedMock).toHaveBeenCalledWith({ texts: ["a"] });
  });

  it("rejects instead of succeeding silently outside the native platform", async () => {
    nativePlatform.isNative = false;
    await expect(embedTexts(["a"])).rejects.toThrow("Embedding unavailable in browser");
    expect(embedMock).not.toHaveBeenCalled();
  });

  it("bounds the batch at 21 texts (1 target + MATCH_CANDIDATE_LIMIT candidates)", async () => {
    const texts = Array.from({ length: 22 }, (_, i) => `t${i}`);
    await expect(embedTexts(texts)).rejects.toThrow("Invalid embedding input");
    expect(embedMock).not.toHaveBeenCalled();
  });

  it("rejects blank and over-long inputs", async () => {
    await expect(embedTexts(["   "])).rejects.toThrow("Invalid embedding input");
    await expect(embedTexts(["x".repeat(5001)])).rejects.toThrow("Invalid embedding input");
    expect(embedMock).not.toHaveBeenCalled();
  });

  it("never returns an empty, short, ragged or non-finite payload", async () => {
    embedMock.mockResolvedValue({ vectors: [] });
    await expect(embedTexts(["a", "b"])).rejects.toThrow("Invalid embedding result");

    embedMock.mockResolvedValue({ vectors: [[0.1, 0.2]] });
    await expect(embedTexts(["a", "b"])).rejects.toThrow("Invalid embedding result");

    embedMock.mockResolvedValue({ vectors: [[0.1, 0.2], [0.3, 0.4, 0.5]] });
    await expect(embedTexts(["a", "b"])).rejects.toThrow("Invalid embedding result");

    embedMock.mockResolvedValue({ vectors: [[0.1, Number.POSITIVE_INFINITY]] });
    await expect(embedTexts(["a"])).rejects.toThrow("Invalid embedding result");

    embedMock.mockResolvedValue({ vectors: [["0.1", "0.2"]] });
    await expect(embedTexts(["a"])).rejects.toThrow("Invalid embedding result");
  });

  it("keeps vector order stable: one output row per input text", async () => {
    embedMock.mockResolvedValue({ vectors: [[0.1], [0.2], [0.3]] });
    await expect(embedTexts(["a", "b", "c"])).resolves.toEqual([[0.1], [0.2], [0.3]]);
  });
});
