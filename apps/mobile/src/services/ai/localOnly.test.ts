/**
 * Local-intelligence local-only proof (isolated scope).
 *
 * Global fetch is stubbed to throw: the retained local paths — Needle
 * embeddings, report-slot extraction and category classification — must
 * complete with zero fetch calls. No network, no download, no bridge.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StubNeedleEmbedder } from "./needle/embedder";
import { classifyCategory } from "./ops/classifyCategory";
import { extractReportFields } from "./ops/extractReportFields";
import { mustProfile, stubGenerate } from "./ops/testSupport";

const NEEDLE_PROFILE = "needle3-cact-l20";

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

  it("extracts report slots through an injected local generator", async () => {
    const result = await extractReportFields(
      stubGenerate('{"title":"Lost keys","locationNote":"Central Park"}'),
      "Lost keys near Central Park.",
      mustProfile(NEEDLE_PROFILE),
    );
    expect(result.ok).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("classifies a category through an injected local generator", async () => {
    const result = await classifyCategory(
      stubGenerate('{"category":"accessories"}'),
      { text: "black leather wallet with a student ID" },
      mustProfile(NEEDLE_PROFILE),
    );
    expect(result.ok).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
