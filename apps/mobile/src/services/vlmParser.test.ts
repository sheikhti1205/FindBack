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

  it("drops an unknown category to null but keeps the usable title/description", () => {
    const bad = JSON.stringify({ ...JSON.parse(valid), suggestedCategory: "Weapons" });
    const parsed = parseVlmOutput(bad, CATEGORIES)!;
    expect(parsed.suggestedCategory).toBeNull();
    expect(parsed.suggestedTitle).toBe("Black umbrella");
  });

  it("rejects non-JSON; repairs an unterminated looped object to its usable prefix", () => {
    expect(parseVlmOutput("no json here", CATEGORIES)).toBeNull();
    // Unterminated SmolVLM loop: the balanced prefix still carries signal.
    const partial = parseVlmOutput('{"objectName":"umbrella","colors":["black"]', CATEGORIES);
    expect(partial?.objectName).toBe("umbrella");
    expect(partial?.colors).toEqual(["black"]);
  });

  it("clamps over-long strings and drops newlines", () => {
    const long = JSON.stringify({ ...JSON.parse(valid), objectName: "x".repeat(500), suggestedDescription: "line\nline" });
    const parsed = parseVlmOutput(long, CATEGORIES)!;
    expect(parsed.objectName!.length).toBeLessThanOrEqual(120);
    expect(parsed.suggestedDescription).not.toMatch(/\n/);
  });

  it("tolerates structurally sparse JSON (missing keys default, aliases map)", () => {
    // SmolVLM frequently drops keys or uses snake_case/shorthand: sparse
    // output stays usable instead of UNUSABLE.
    const sparse = parseVlmOutput('{"objectName":"umbrella"}', CATEGORIES)!;
    expect(sparse.objectName).toBe("umbrella");
    expect(sparse.colors).toEqual([]);
    expect(sparse.suggestedTitle).toBeNull();
    expect(parseVlmOutput("{}", CATEGORIES)).not.toBeNull();
    const aliased = parseVlmOutput('{"title":"Keys","category":"clothing","color":"black"}', CATEGORIES)!;
    expect(aliased.suggestedTitle).toBe("Keys");
    expect(aliased.colors).toEqual(["black"]);
  });

  it("accepts a complete object whose values are legitimately null/empty", () => {
    const full = JSON.stringify({
      objectName: null,
      suggestedCategory: null,
      colors: [],
      visibleBrand: null,
      visibleText: [],
      identifyingFeatures: [],
      suggestedTitle: null,
      suggestedDescription: null,
      uncertainFields: [],
    });
    const parsed = parseVlmOutput(full, CATEGORIES)!;
    expect(parsed.objectName).toBeNull();
    expect(parsed.suggestedCategory).toBeNull();
    expect(parsed.colors).toEqual([]);
  });

  it("coerces wrong-typed fields instead of failing the whole output", () => {
    const coerced = JSON.stringify({ ...JSON.parse(valid), objectName: 42 });
    expect(parseVlmOutput(coerced, CATEGORIES)?.objectName).toBe("42");
    const wrapped = JSON.stringify({ ...JSON.parse(valid), colors: "black" });
    expect(parseVlmOutput(wrapped, CATEGORIES)?.colors).toEqual(["black"]);
  });

  it("redacts email/phone/card/IDs/OTP/QR on all Stage-2 text fields", () => {
    const tainted = JSON.stringify({
      objectName: "card 4111-1111-1111-1111",
      suggestedCategory: "Clothing",
      colors: ["+880 1712-345678"],
      visibleBrand: "owner@example.com",
      visibleText: ["ID No AB123456", "OTP 483921", "https://evil.example/qr"],
      identifyingFeatures: ["WIFI:S:home;T:WPA;P:secret", "black strap"],
      suggestedTitle: "CODE 123456",
      suggestedDescription: "Call +880 1712-345678",
      uncertainFields: ["visibleBrand"],
    });
    const parsed = parseVlmOutput(tainted, CATEGORIES)!;
    expect(parsed.objectName).toBe("[redacted]");
    expect(parsed.colors).toEqual(["[redacted]"]);
    expect(parsed.visibleBrand).toBe("[redacted]");
    // Redacted duplicates collapse to one entry (echo-loop dedupe).
    expect(parsed.visibleText).toEqual(["[redacted]"]);
    expect(parsed.identifyingFeatures).toContain("[redacted]");
    expect(parsed.suggestedTitle).toBe("[redacted]");
    expect(parsed.suggestedDescription).toBe("[redacted]");
  });

  it("collapses echo loops to a single instance", () => {
    const looped = JSON.stringify({
      ...JSON.parse(valid),
      suggestedTitle: "black umbrella black umbrella black umbrella black umbrella black umbrella black umbrella black umbrella",
      colors: ["black", "black", "BLACK"],
    });
    const parsed = parseVlmOutput(looped, CATEGORIES)!;
    expect(parsed.suggestedTitle).toBe("black umbrella");
    expect(parsed.colors).toEqual(["black"]);
  });

  it("matches categories case-insensitively to the canonical", () => {
    const lower = JSON.stringify({ ...JSON.parse(valid), suggestedCategory: "clothing" });
    expect(parseVlmOutput(lower, CATEGORIES)?.suggestedCategory).toBe("Clothing");
  });
});