import { describe, expect, it } from "vitest";
import {
  MAX_DISPLAY_DIMENSION,
  displayDimensionOrNull,
  displaySizeOrNull,
} from "./displayDimensions";

describe("displayDimensionOrNull", () => {
  it("accepts a positive integer within the ceiling", () => {
    expect(displayDimensionOrNull(1)).toBe(1);
    expect(displayDimensionOrNull(3024)).toBe(3024);
    expect(displayDimensionOrNull(MAX_DISPLAY_DIMENSION)).toBe(MAX_DISPLAY_DIMENSION);
  });

  it("accepts a plain digit string (a mirrored or offline row can carry one)", () => {
    expect(displayDimensionOrNull("1200")).toBe(1200);
    expect(displayDimensionOrNull(" 1200 ")).toBe(1200);
  });

  it("never coerces a value it only looks numeric (REVIEW-M1 F5)", () => {
    // Number() would read all of these as integers; a display hint must not.
    expect(displayDimensionOrNull("0x10")).toBeNull();
    expect(displayDimensionOrNull("1e3")).toBeNull();
    expect(displayDimensionOrNull("12.5")).toBeNull();
    expect(displayDimensionOrNull("-3")).toBeNull();
    expect(displayDimensionOrNull("1_000")).toBeNull();
  });

  it("treats zero, negatives, fractions and non-numbers as unknown", () => {
    expect(displayDimensionOrNull(0)).toBeNull();
    expect(displayDimensionOrNull(-1)).toBeNull();
    expect(displayDimensionOrNull(12.5)).toBeNull();
    expect(displayDimensionOrNull(Number.NaN)).toBeNull();
    expect(displayDimensionOrNull(Number.POSITIVE_INFINITY)).toBeNull();
    expect(displayDimensionOrNull(null)).toBeNull();
    expect(displayDimensionOrNull(undefined)).toBeNull();
    expect(displayDimensionOrNull("")).toBeNull();
    expect(displayDimensionOrNull({})).toBeNull();
    expect(displayDimensionOrNull([])).toBeNull();
  });

  it("rejects past the ceiling, which mirrors the database check", () => {
    expect(displayDimensionOrNull(MAX_DISPLAY_DIMENSION + 1)).toBeNull();
    expect(displayDimensionOrNull(1e30)).toBeNull();
  });

  it("accepts the large passthrough sizes the pipeline can actually emit", () => {
    // An animated GIF is passed through untouched up to 30M decoded pixels, so a
    // 9000px edge is publishable and must keep a usable ratio (REVIEW-M1 F4).
    expect(displayDimensionOrNull(9000)).toBe(9000);
    expect(displaySizeOrNull({ width: 9000, height: 3000 })).toEqual({
      width: 9000,
      height: 3000,
    });
  });
});

describe("displaySizeOrNull", () => {
  it("is pair-or-nothing: one known axis reports no size", () => {
    expect(displaySizeOrNull({ width: 1200 })).toBeNull();
    expect(displaySizeOrNull({ height: 800 })).toBeNull();
    expect(displaySizeOrNull({ width: 1200, height: "800" })).toEqual({
      width: 1200,
      height: 800,
    });
    expect(displaySizeOrNull({ width: "0x10", height: 800 })).toBeNull();
    expect(displaySizeOrNull({})).toBeNull();
  });
});
