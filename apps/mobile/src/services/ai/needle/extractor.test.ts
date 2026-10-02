import { describe, expect, it } from "vitest";
import { CATEGORIES } from "@findback/shared";
import { NEEDLE_EXTRACTION_KEYS, extractNeedleFields } from "./extractor";

const valid = JSON.stringify({
  objectName: "black umbrella",
  suggestedCategory: "Clothing",
  colors: ["black"],
  visibleBrand: null,
  visibleText: [],
  identifyingFeatures: ["wooden handle"],
  suggestedTitle: "Black umbrella",
  suggestedDescription: "A black umbrella with a wooden handle.",
  uncertainFields: ["visibleBrand"],
});

describe("extractNeedleFields", () => {
  it("returns the vlmParser-compatible field shape", () => {
    expect([...NEEDLE_EXTRACTION_KEYS].sort()).toEqual(
      [
        "colors",
        "identifyingFeatures",
        "objectName",
        "suggestedCategory",
        "suggestedDescription",
        "suggestedTitle",
        "uncertainFields",
        "visibleBrand",
        "visibleText",
      ].sort(),
    );
    const parsed = extractNeedleFields(valid, CATEGORIES)!;
    expect(Object.keys(parsed).sort()).toEqual([...NEEDLE_EXTRACTION_KEYS].sort());
  });

  it("parses a valid structured object", () => {
    const parsed = extractNeedleFields(valid, CATEGORIES)!;
    expect(parsed.objectName).toBe("black umbrella");
    expect(parsed.suggestedCategory).toBe("Clothing");
    expect(parsed.colors).toEqual(["black"]);
    expect(parsed.suggestedTitle).toBe("Black umbrella");
  });

  it("extracts the first complete object from surrounding prose", () => {
    const parsed = extractNeedleFields(`Here you go: ${valid} Thanks!`, CATEGORIES);
    expect(parsed?.objectName).toBe("black umbrella");
  });

  it("rejects unknown categories", () => {
    const bad = JSON.stringify({ ...JSON.parse(valid), suggestedCategory: "Weapons" });
    expect(extractNeedleFields(bad, CATEGORIES)).toBeNull();
  });

  it("rejects non-JSON and unbalanced objects", () => {
    expect(extractNeedleFields("no json here", CATEGORIES)).toBeNull();
    expect(extractNeedleFields('{"objectName":"x"', CATEGORIES)).toBeNull();
  });

  it("rejects structurally incomplete JSON (missing canonical keys)", () => {
    expect(extractNeedleFields('{"objectName":null}', CATEGORIES)).toBeNull();
    const missing = JSON.parse(valid) as Record<string, unknown>;
    delete missing.colors;
    expect(extractNeedleFields(JSON.stringify(missing), CATEGORIES)).toBeNull();
  });

  it("rejects wrong-typed fields instead of silently nulling them", () => {
    const bad = JSON.stringify({ ...JSON.parse(valid), objectName: 42 });
    expect(extractNeedleFields(bad, CATEGORIES)).toBeNull();
    const badArray = JSON.stringify({ ...JSON.parse(valid), colors: "black" });
    expect(extractNeedleFields(badArray, CATEGORIES)).toBeNull();
  });

  it("performs no network access (pure local parse)", () => {
    const parsed = extractNeedleFields(valid, CATEGORIES)!;
    expect(parsed.suggestedDescription).toBe("A black umbrella with a wooden handle.");
  });
});
