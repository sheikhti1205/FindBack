import { describe, expect, it } from "vitest";
import { SEARCH_SLOTS_INSTRUCTION, extractSearchFilters } from "./extractSearchFilters";
import { mustProfile, stubGenerate } from "./testSupport";

describe("extract-search-filters op", () => {
  it("extracts filters with no clarification", async () => {
    const result = await extractSearchFilters(
      stubGenerate('{"query":"red backpack","dateRangeText":"last week"}'),
      "Search for any red backpack reported in the last week.",
      mustProfile("qwen3-0.6b-dynamic-int4"),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.fields.query).toBe("red backpack");
      expect(result.value.action).toEqual({ action: "NONE" });
    }
  });

  it("resolves ambiguous filters to ASK_USER success", async () => {
    const result = await extractSearchFilters(
      stubGenerate("{}"),
      "Search for stuff.",
      mustProfile("qwen3-0.6b-dynamic-int4"),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.action.action).toBe("ASK_USER");
      expect(result.value.action.prompt?.field).toBe("query");
    }
  });

  it("keeps status free text without inventing an enum", async () => {
    const result = await extractSearchFilters(
      stubGenerate('{"query":"keys","status":"open"}'),
      "Show open key reports.",
      mustProfile("qwen3-0.6b-dynamic-int4"),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.fields.status).toBe("open");
  });

  it("gives the LOST/FOUND type and the place a slot of their own", async () => {
    const result = await extractSearchFilters(
      stubGenerate('{"query":"black wallet","postType":"LOST","place":"Gulshan"}'),
      "Show the black wallet lost in Gulshan.",
      mustProfile("qwen3-0.6b-dynamic-int4"),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.fields.postType).toBe("LOST");
      expect(result.value.fields.place).toBe("Gulshan");
    }
  });

  it("names the type and the place in the instruction the model reads", () => {
    // The slots are only extractable if the model is told they exist.
    expect(SEARCH_SLOTS_INSTRUCTION).toContain('"postType"');
    expect(SEARCH_SLOTS_INSTRUCTION).toContain('"place"');
    expect(SEARCH_SLOTS_INSTRUCTION).toMatch(/never invent coordinates/i);
  });

  it("rejects userContext echo with no explicit context (R6 wired)", async () => {
    const userMessage = "searching for a red backpack reported near the north gate last week";
    const result = await extractSearchFilters(
      stubGenerate(JSON.stringify({ query: userMessage })),
      userMessage,
      mustProfile("qwen3-0.6b-dynamic-int4"),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.diagnostic).toContain("R6_CONTEXT_ECHO");
  });

  it("rejects instruction verbatim in free text with no explicit context (BV08-stock shape)", async () => {
    const instructionRun = SEARCH_SLOTS_INSTRUCTION.slice(0, 66);
    const result = await extractSearchFilters(
      stubGenerate(JSON.stringify({ query: instructionRun })),
      "Search for any red backpack reported in the last week.",
      mustProfile("qwen3-0.6b-dynamic-int4"),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.diagnostic).toContain("R6_CONTEXT_ECHO");
  });
});
