import { describe, expect, it } from "vitest";
import { analyzeImage } from "./analyzeImage";
import { FakeAiProvider, REFUSAL_TEXT } from "../testing/FakeAiProvider";
import { fakePhotoGenerate, mustProfile, stubGenerate } from "./testSupport";

const VISION = "smolvlm2-500M-vision";

describe("analyze-image op", () => {
  it("accepts valid simulator photo JSON", async () => {
    const result = await analyzeImage(
      fakePhotoGenerate(new FakeAiProvider({ mode: "GOOD" }), "umbrella.jpg"),
      { imageUri: "umbrella.jpg" },
      mustProfile(VISION),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.objectName).toBe("black umbrella");
      expect(result.value.colors).toEqual(["black"]);
    }
  });

  it("de-fences simulator output before validating", async () => {
    const generate = fakePhotoGenerate(new FakeAiProvider({ mode: "FENCED_JSON" }), "x.jpg");
    const result = await analyzeImage(generate, { imageUri: "x.jpg" }, mustProfile(VISION));
    expect(result.ok).toBe(true);
  });

  it("retries once on INVALID_OUTPUT, then fails closed", async () => {
    const generate = stubGenerate("{objectName: black umbrella, colors: [}");
    const result = await analyzeImage(generate, { imageUri: "x.jpg" }, mustProfile(VISION));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.errorClass).toBe("INVALID_OUTPUT");
    expect(generate.calls).toBe(2);
  });

  it("recovers when the retry succeeds", async () => {
    const good = JSON.stringify({
      objectName: "keys",
      suggestedCategory: "keys",
      colors: ["silver"],
      visibleBrand: null,
      visibleText: [],
      identifyingFeatures: ["two metal keys"],
      suggestedTitle: "Keys found",
      suggestedDescription: "Two metal keys.",
      uncertainFields: [],
    });
    const generate = stubGenerate(["{bad json", good]);
    const result = await analyzeImage(generate, { imageUri: "x.jpg" }, mustProfile(VISION));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.objectName).toBe("keys");
    expect(generate.calls).toBe(2);
  });

  it("does not retry refusals", async () => {
    const generate = stubGenerate(REFUSAL_TEXT);
    const result = await analyzeImage(generate, { imageUri: "x.jpg" }, mustProfile(VISION));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.errorClass).toBe("UNSUPPORTED_REQUEST");
    expect(generate.calls).toBe(1);
  });

  it("rejects stuffed vision output even after a retry", async () => {
    const stuffed = JSON.stringify({
      objectName: "Champion",
      suggestedCategory: "Champion",
      colors: ["red"],
      visibleBrand: "Champion",
      visibleText: ["Champion"],
      identifyingFeatures: ["Champion"],
      suggestedTitle: "Champion",
      suggestedDescription: "Champion",
      uncertainFields: ["Champion"],
    });
    const generate = stubGenerate(stuffed);
    const result = await analyzeImage(generate, { imageUri: "x.jpg" }, mustProfile(VISION));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.diagnostic).toContain("R5_FIELD_STUFFING");
    expect(generate.calls).toBe(2);
  });
});
