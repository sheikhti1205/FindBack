import { beforeEach, describe, expect, it, vi } from "vitest";

const { embedMock } = vi.hoisted(() => ({ embedMock: vi.fn() }));
vi.mock("./vlmPlugin", () => ({ getVlmBridge: () => ({ embedTexts: embedMock }) }));

import { embeddingInput, embedTexts } from "./embeddings";

beforeEach(() => embedMock.mockReset());

describe("embeddingInput", () => {
  it("trims and joins title and description", () => {
    expect(embeddingInput("  black umbrella ", " wooden handle ")).toBe("black umbrella\nwooden handle");
    expect(embeddingInput("", "only desc")).toBe("only desc");
  });
});

describe("embedTexts", () => {
  it("forwards to the native bridge and returns raw vectors", async () => {
    embedMock.mockResolvedValue([[0.1, 0.2]]);
    await expect(embedTexts(["a"])).resolves.toEqual([[0.1, 0.2]]);
    expect(embedMock).toHaveBeenCalledWith(["a"]);
  });
});