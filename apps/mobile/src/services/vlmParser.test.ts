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

  it("rejects structurally incomplete JSON (missing canonical keys)", () => {
    expect(parseVlmOutput('{"objectName":null}', CATEGORIES)).toBeNull();
    expect(parseVlmOutput("{}", CATEGORIES)).toBeNull();
    const missingArray = JSON.parse(valid) as Record<string, unknown>;
    delete missingArray.colors;
    expect(parseVlmOutput(JSON.stringify(missingArray), CATEGORIES)).toBeNull();
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

  it("rejects wrong-typed fields instead of silently nulling them", () => {
    const bad = JSON.stringify({ ...JSON.parse(valid), objectName: 42 });
    expect(parseVlmOutput(bad, CATEGORIES)).toBeNull();
    const badArray = JSON.stringify({ ...JSON.parse(valid), colors: "black" });
    expect(parseVlmOutput(badArray, CATEGORIES)).toBeNull();
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
    expect(parsed.visibleText).toEqual(["[redacted]", "[redacted]", "[redacted]"]);
    expect(parsed.identifyingFeatures).toContain("[redacted]");
    expect(parsed.suggestedTitle).toBe("[redacted]");
    expect(parsed.suggestedDescription).toBe("[redacted]");
  });
});