import { describe, expect, it } from "vitest";
import { cleanPlace, matchesPlace, placeRejection, placeTokens } from "./placeScope";

describe("cleanPlace", () => {
  it("trims a place name and collapses its spaces", () => {
    expect(cleanPlace("  Dhaka  ")).toBe("Dhaka");
    expect(cleanPlace("Gulshan   Dhaka")).toBe("Gulshan Dhaka");
    expect(cleanPlace("Gulshan,")).toBe("Gulshan");
  });

  it("refuses a coordinate: a place is a name, never a position", () => {
    expect(cleanPlace("23.8103, 90.4125")).toBe("");
    expect(cleanPlace("near 12.3456, 65.4321")).toBe("");
  });

  it("refuses a bare number and a paragraph", () => {
    expect(cleanPlace("221")).toBe("");
    expect(cleanPlace("x".repeat(81))).toBe("");
  });

  it("keeps a name written in any script", () => {
    expect(cleanPlace("গুলশান")).toBe("গুলশান");
    expect(cleanPlace("221B Baker Street")).toBe("221B Baker Street");
  });

  it("treats nothing as no place", () => {
    expect(cleanPlace("")).toBe("");
    expect(cleanPlace("   ")).toBe("");
    expect(cleanPlace(undefined)).toBe("");
    expect(cleanPlace(null)).toBe("");
  });
});

describe("placeRejection", () => {
  it("names the reason a value is not a place, one reason per mistake", () => {
    // The reader is told the RIGHT reason: a coordinate, a bare number and
    // an over-long name are three different mistakes.
    expect(placeRejection("23.8103, 90.4125")).toBe("coordinate");
    expect(placeRejection("221")).toBe("number");
    expect(placeRejection("x".repeat(81))).toBe("too-long");
  });

  it("accepts a place name in any script", () => {
    expect(placeRejection("Gulshan")).toBeNull();
    expect(placeRejection("গুলশান")).toBeNull();
    expect(placeRejection("221B Baker Street")).toBeNull();
    expect(placeRejection("")).toBeNull();
    expect(placeRejection(undefined)).toBeNull();
  });

  it("agrees with cleanPlace: a refused value is never a place", () => {
    for (const value of ["23.8103, 90.4125", "221", "x".repeat(81)]) {
      expect(placeRejection(value)).not.toBeNull();
      expect(cleanPlace(value)).toBe("");
    }
    for (const value of ["Gulshan", "Gulshan, Dhaka", "গুলশান"]) {
      expect(placeRejection(value)).toBeNull();
      expect(cleanPlace(value)).not.toBe("");
    }
  });
});

describe("placeTokens", () => {
  it("splits on punctuation and lowercases", () => {
    expect(placeTokens("Gulshan, Dhaka")).toEqual(["gulshan", "dhaka"]);
    expect(placeTokens("Gulshan  Dhaka")).toEqual(["gulshan", "dhaka"]);
  });
});

describe("matchesPlace", () => {
  it("matches a place inside a longer place name", () => {
    expect(matchesPlace("Dhaka, Bangladesh", "Dhaka")).toBe(true);
    expect(matchesPlace("Dhaka", "dhaka")).toBe(true);
    expect(matchesPlace("Gulshan, Dhaka", "Gulshan Dhaka")).toBe(true);
  });

  it("matches whole words only, so a longer name is not a match", () => {
    // "Dhakaimpur" is a different place, not "Dhaka".
    expect(matchesPlace("Dhakaimpur", "Dhaka")).toBe(false);
    expect(matchesPlace("Old Dhaka", "dhaka")).toBe(true);
  });

  it("needs the words side by side and in order", () => {
    expect(matchesPlace("Dhaka, Gulshan", "Gulshan Dhaka")).toBe(false);
  });

  it("never matches a report without a place name", () => {
    // A report with only a map pin carries no place name: it cannot be
    // proved to be in the place, so it is not shown.
    expect(matchesPlace(null, "Dhaka")).toBe(false);
    expect(matchesPlace(undefined, "Dhaka")).toBe(false);
    expect(matchesPlace("", "Dhaka")).toBe(false);
  });

  it("matches nothing without a filter", () => {
    expect(matchesPlace("Dhaka", "")).toBe(false);
  });
});
