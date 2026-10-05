import { describe, expect, it } from "vitest";
import { mustProfile, stubGenerate } from "./ai/ops/testSupport";
import {
  groundingQuestion,
  requestGroundedOptions,
  selectGroundedOption,
  toCssPercentRect,
} from "./photoGrounding";

const VISION = "smolvlm2-500M-vision";
const CONSENT = { imageConsent: true as const };

function payload(boxes: readonly unknown[]): string {
  return JSON.stringify({ coordinateSpace: "relative-0-1000", boxes });
}

const INPUT = { imageUri: "report-photo.jpg", referringExpression: "the black wallet" };

describe("photoGrounding (report-photo disambiguation)", () => {
  it("returns selectable options for grounded boxes", async () => {
    const result = await requestGroundedOptions(
      stubGenerate(payload([{ x: 10, y: 20, w: 300, h: 200, label: "black wallet" }])),
      mustProfile(VISION),
      { ...INPUT, ...CONSENT },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.options).toHaveLength(1);
    expect(result.value.options[0]).toMatchObject({ id: "ground-0", label: "black wallet" });
    expect(result.value.question).toBe("Which item are you reporting?");
  });

  it("returns zero options (not invented boxes) when nothing matches", async () => {
    const result = await requestGroundedOptions(
      stubGenerate(payload([])),
      mustProfile(VISION),
      { ...INPUT, ...CONSENT },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.options).toEqual([]);
    expect(result.value.question).toContain("No confident match");
  });

  it("fails closed without image consent and never calls generate", async () => {
    const generate = stubGenerate(payload([{ x: 10, y: 20, w: 300, h: 200, label: "black wallet" }]));
    const result = await requestGroundedOptions(generate, mustProfile(VISION), {
      ...INPUT,
      imageConsent: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.diagnostic).toBe("CONSENT_REQUIRED:image");
    expect(generate.calls).toBe(0);
  });

  it("fails closed on invalid boxes instead of surfacing them", async () => {
    const result = await requestGroundedOptions(
      stubGenerate(payload([{ x: 900, y: 900, w: 200, h: 200, label: "black wallet" }])),
      mustProfile(VISION),
      { ...INPUT, ...CONSENT },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.diagnostic).toBe("R1_BUSINESS_RULE:BOX_OUT_OF_BOUNDS");
  });

  it("fails closed on oversize box sets", async () => {
    const boxes = Array.from({ length: 9 }, (_, i) => ({ x: i, y: i, w: 10, h: 10, label: `item ${i}` }));
    const result = await requestGroundedOptions(
      stubGenerate(payload(boxes)),
      mustProfile(VISION),
      { ...INPUT, ...CONSENT },
    );
    expect(result.ok).toBe(false);
  });

  it("rejects empty photo inputs without calling generate", async () => {
    const generate = stubGenerate(payload([]));
    const emptyUri = await requestGroundedOptions(generate, mustProfile(VISION), {
      referringExpression: "wallet",
      imageUri: "  ",
      ...CONSENT,
    });
    expect(emptyUri.ok).toBe(false);
    const emptyExpr = await requestGroundedOptions(generate, mustProfile(VISION), {
      imageUri: "photo.jpg",
      referringExpression: "  ",
      ...CONSENT,
    });
    expect(emptyExpr.ok).toBe(false);
    expect(generate.calls).toBe(0);
  });
});

describe("grounded selector logic", () => {
  const options = [
    { id: "ground-0", label: "black wallet", box: { x: 10, y: 20, w: 300, h: 200, label: "black wallet" } },
    { id: "ground-1", label: "keys", box: { x: 400, y: 20, w: 100, h: 100, label: "keys" } },
  ] as const;

  it("selects a known option by id", () => {
    expect(selectGroundedOption([...options], "ground-1")?.label).toBe("keys");
  });

  it("returns undefined for unknown ids (no guessing)", () => {
    expect(selectGroundedOption([...options], "ground-9")).toBeUndefined();
  });

  it("asks the disambiguation question with an accurate count", () => {
    expect(groundingQuestion(2)).toBe("Which item are you reporting? (2 options)");
    expect(groundingQuestion(0)).toContain("No confident match");
  });

  it("converts boxes to CSS percent rects for presentation only", () => {
    expect(toCssPercentRect({ x: 10, y: 20, w: 300, h: 200, label: "black wallet" })).toEqual({
      leftPct: 1,
      topPct: 2,
      widthPct: 30,
      heightPct: 20,
    });
  });
});
