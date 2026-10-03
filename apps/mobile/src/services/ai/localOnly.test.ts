/**
 * WS-G local-only mode proof (isolated scope).
 *
 * Global fetch is stubbed to throw: the embed / extract / classify local
 * paths must complete with zero fetch calls. No network, no download, no
 * bridge — pure local seams only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StubNeedleEmbedder } from "./needle/embedder";
import { extractNeedleFields } from "./needle/extractor";
import { classifyIntent } from "./ops/classifyIntent";
import { extractReportFields } from "./ops/extractReportFields";
import { mustProfile, stubGenerate } from "./ops/testSupport";

const NEEDLE_JSON = JSON.stringify({
  objectName: "red umbrella",
  suggestedCategory: null,
  colors: ["red"],
  visibleBrand: null,
  visibleText: [],
  identifyingFeatures: ["wooden handle"],
  suggestedTitle: "Red umbrella",
  suggestedDescription: "A red umbrella with a wooden handle.",
  uncertainFields: [],
});

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => {
    throw new Error("network disabled in local-only mode");
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("local-only mode performs zero network calls", () => {
  it("embeds locally via the deterministic stub", async () => {
    const vectors = await new StubNeedleEmbedder().embedNeedleTexts(["red umbrella"]);
    expect(vectors).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("extracts structured fields with pure local parsing", () => {
    const result = extractNeedleFields(NEEDLE_JSON);
    expect(result).not.toBeNull();
    expect(result?.objectName).toBe("red umbrella");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("classifies intent through an injected local generator", async () => {
    const result = await classifyIntent(
      stubGenerate('{"intent":"SEARCH"}'),
      "Search for any red backpack.",
      mustProfile("qwen3-0.6b-dynamic-int4"),
    );
    expect(result.ok).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("extracts report slots through an injected local generator", async () => {
    const result = await extractReportFields(
      stubGenerate('{"title":"Lost keys","locationNote":"Central Park"}'),
      "Lost keys near Central Park.",
      mustProfile("qwen3-0.6b-dynamic-int4"),
    );
    expect(result.ok).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
