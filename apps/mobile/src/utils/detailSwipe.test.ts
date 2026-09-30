// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  DETAIL_SWIPE_MIN_OFFSET_PX,
  DETAIL_SWIPE_MIN_VELOCITY_PX_S,
  resolveHorizontalSwipe,
} from "./detailSwipe";

describe("resolveHorizontalSwipe", () => {
  it("swipe left resolves to next", () => {
    expect(resolveHorizontalSwipe(-120, 5, -600)).toBe("next");
    // Fast flick: small offset but high velocity still advances.
    expect(resolveHorizontalSwipe(-20, 2, -800)).toBe("next");
  });

  it("swipe right resolves to previous", () => {
    expect(resolveHorizontalSwipe(120, -4, 600)).toBe("prev");
    expect(resolveHorizontalSwipe(20, 2, 800)).toBe("prev");
  });

  it("vertical-dominant gesture is ignored (page scrolls)", () => {
    expect(resolveHorizontalSwipe(-120, 200, -600)).toBeNull();
    expect(resolveHorizontalSwipe(30, 120, 100)).toBeNull();
    expect(resolveHorizontalSwipe(0, 150, 0)).toBeNull();
  });

  it("small accidental drag is ignored", () => {
    expect(resolveHorizontalSwipe(10, 2, 50)).toBeNull();
    expect(resolveHorizontalSwipe(-15, -3, -100)).toBeNull();
    expect(resolveHorizontalSwipe(0, 0, 0)).toBeNull();
  });

  it("exposes documented thresholds", () => {
    expect(DETAIL_SWIPE_MIN_OFFSET_PX).toBe(48);
    expect(DETAIL_SWIPE_MIN_VELOCITY_PX_S).toBe(400);
  });
});
