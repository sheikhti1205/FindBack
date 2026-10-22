import { describe, expect, it } from "vitest";
import { classifyIntent } from "./classifyIntent";
import { FakeAiProvider } from "../testing/FakeAiProvider";
import { fakeGenerate, mustProfile, stubGenerate } from "./testSupport";
import { looksLikeCoordinates } from "../../search/coordinates";

describe("classify-intent op", () => {
  it("classifies a search request and defaults the action", async () => {
    const result = await classifyIntent(
      stubGenerate('{"intent":"SEARCH"}'),
      "Search for any red backpack reported in the last week.",
      mustProfile("smolvlm2-500m-text"),
    );
    expect(result).toEqual({
      ok: true,
      value: { intent: "SEARCH", action: { action: "OPEN_SEARCH" } },
    });
  });

  it("strips Qwen thought envelopes before classifying", async () => {
    const result = await classifyIntent(
      stubGenerate('[thought] The user wants to search. [/thought]\n{"intent":"SEARCH"}'),
      "Search for any red backpack.",
      mustProfile("qwen3-0.6b-dynamic-int4"),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.intent).toBe("SEARCH");
  });

  it("resolves ambiguous input to ASK_USER with no coordinates", async () => {
    const result = await classifyIntent(
      stubGenerate('{"intent":"UNKNOWN"}'),
      "I lost something.",
      mustProfile("smolvlm2-500m-text"),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.action.action).toBe("ASK_USER");
      expect(looksLikeCoordinates(JSON.stringify(result.value))).toBe(false);
    }
  });

  it("propagates refusal and empty simulator modes", async () => {
    const refused = await classifyIntent(
      fakeGenerate(new FakeAiProvider({ mode: "REFUSAL" })),
      "Help me.",
      mustProfile("smolvlm2-500m-text"),
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.errorClass).toBe("UNSUPPORTED_REQUEST");

    const empty = await classifyIntent(
      fakeGenerate(new FakeAiProvider({ mode: "EMPTY" })),
      "Help me.",
      mustProfile("smolvlm2-500m-text"),
    );
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.error.errorClass).toBe("INVALID_OUTPUT");
      expect(empty.error.diagnostic).toBe("R4_EMPTY_OUTPUT");
    }
  });

  it("surfaces unknown simulator actions as UNSUPPORTED_ACTION", async () => {
    const result = await classifyIntent(
      fakeGenerate(new FakeAiProvider({ mode: "UNKNOWN_ACTION" })),
      "Do something.",
      mustProfile("smolvlm2-500m-text"),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.errorClass).toBe("UNSUPPORTED_ACTION");
      expect(result.error.diagnostic).toBe("R1_UNSUPPORTED_ACTION:teleport_item_home");
    }
  });

  it("wires context with no free-text R6 surface (works with and without explicit context)", async () => {
    const plain = await classifyIntent(
      stubGenerate('{"intent":"SEARCH"}'),
      "Search for any red backpack reported in the last week.",
      mustProfile("smolvlm2-500m-text"),
    );
    expect(plain).toEqual({
      ok: true,
      value: { intent: "SEARCH", action: { action: "OPEN_SEARCH" } },
    });
    const supplied = await classifyIntent(
      stubGenerate('{"intent":"SEARCH"}'),
      "Search for any red backpack reported in the last week.",
      mustProfile("smolvlm2-500m-text"),
      { context: { userContext: "custom context about a backpack search" } },
    );
    expect(supplied).toEqual({
      ok: true,
      value: { intent: "SEARCH", action: { action: "OPEN_SEARCH" } },
    });
  });
});
