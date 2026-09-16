import { describe, expect, it } from "vitest";
import { CATEGORIES } from "@findback/shared";
import { parseVlmOutput } from "./vlmParser";

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

describe("parseVlmOutput", () => {
  it("parses a valid object", () => {
    expect(parseVlmOutput(valid, CATEGORIES)!.objectName).toBe("black umbrella");
    expect(parseVlmOutput(valid, CATEGORIES)!.suggestedCategory).toBe("Clothing");
  });

  it("strips one accidental outer code fence", () => {
    expect(parseVlmOutput("```json\n" + valid + "\n```", CATEGORIES)?.suggestedTitle).toBe("Black umbrella");
  });

  it("extracts the first complete top-level object from surrounding prose", () => {
    expect(parseVlmOutput(`Here you go: ${valid} Thanks!`, CATEGORIES)?.objectName).toBe("black umbrella");
  });

  it("rejects an unknown category", () => {
    const bad = JSON.stringify({ ...JSON.parse(valid), suggestedCategory: "Weapons" });
    expect(parseVlmOutput(bad, CATEGORIES)).toBeNull();
  });

  it("rejects non-JSON and unbalanced objects", () => {
    expect(parseVlmOutput("no json here", CATEGORIES)).toBeNull();
    expect(parseVlmOutput('{"objectName":"x"', CATEGORIES)).toBeNull();
  });

  it("clamps over-long strings and drops newlines", () => {
    const long = JSON.stringify({ ...JSON.parse(valid), objectName: "x".repeat(500), suggestedDescription: "line\nline" });
    const parsed = parseVlmOutput(long, CATEGORIES)!;
    expect(parsed.objectName!.length).toBeLessThanOrEqual(120);
    expect(parsed.suggestedDescription).not.toMatch(/\n/);
  });

  it("never invents missing values", () => {
    const parsed = parseVlmOutput('{"objectName":null}', CATEGORIES)!;
    expect(parsed.suggestedTitle).toBeNull();
    expect(parsed.colors).toEqual([]);
  });
});