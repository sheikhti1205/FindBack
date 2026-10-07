/**
 * Phase A (Step 5b): the canonical slot envelope is accepted by every slot
 * op. Local producers emit `{ fields: {...} }` (Needle, deterministic
 * rules); cloud emits the flat slot object. Both spellings validate
 * identically — no consumer unwraps `{fields}` ad hoc.
 */
import { describe, expect, it } from "vitest";
import { classifyCategory } from "./classifyCategory";
import { extractReportFields } from "./extractReportFields";
import { extractSearchFilters } from "./extractSearchFilters";
import { mustProfile, stubGenerate } from "./testSupport";

const QWEN = "qwen3-0.6b-dynamic-int4";

describe("canonical slot envelope", () => {
  it("extract-search-filters accepts the local {fields} envelope like flat cloud output", async () => {
    const profile = mustProfile(QWEN);
    const flat = await extractSearchFilters(
      stubGenerate('{"query": "wallet", "dateRangeText": "last week"}'),
      "black wallet lost last week",
      profile,
    );
    const enveloped = await extractSearchFilters(
      stubGenerate('{"fields": {"query": "wallet", "dateRangeText": "last week"}}'),
      "black wallet lost last week",
      profile,
    );
    expect(flat.ok).toBe(true);
    expect(enveloped.ok).toBe(true);
    if (flat.ok && enveloped.ok) {
      expect(enveloped.value.fields).toEqual(flat.value.fields);
    }
  });

  it("extract-search-filters still rejects a report-shaped envelope", async () => {
    const result = await extractSearchFilters(
      stubGenerate('{"fields": {"title": "red umbrella"}}'),
      "black wallet lost last week",
      mustProfile(QWEN),
    );
    expect(result.ok).toBe(false);
  });

  it("extract-report-fields accepts the local {fields} envelope", async () => {
    const result = await extractReportFields(
      stubGenerate('{"fields": {"title": "red umbrella"}}'),
      "red umbrella found downtown",
      mustProfile(QWEN),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.fields.title).toBe("red umbrella");
  });

  it("classify-category accepts the local {fields} envelope", async () => {
    const result = await classifyCategory(
      stubGenerate('{"fields": {"category": "keys"}}'),
      { text: "lost my keys" },
      mustProfile(QWEN),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.category).toBe("keys");
  });

  it("a fields envelope mixed with flat slots is invalid, never merged", async () => {
    const result = await extractSearchFilters(
      stubGenerate('{"fields": {"query": "wallet"}, "status": "OPEN"}'),
      "black wallet",
      mustProfile(QWEN),
    );
    expect(result.ok).toBe(false);
  });
});
