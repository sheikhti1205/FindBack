// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { haptic } from "./haptics";

function stubVibrate(value: unknown) {
  Object.defineProperty(navigator, "vibrate", { value, configurable: true });
}

afterEach(() => {
  stubVibrate(undefined);
});

describe("haptic", () => {
  it("uses the threshold and commit patterns when the platform supports it", () => {
    const vibrate = vi.fn(() => true);
    stubVibrate(vibrate);

    expect(haptic("threshold")).toBe(true);
    expect(haptic("commit")).toBe(true);
    expect(vibrate.mock.calls).toEqual([[8], [14]]);
  });

  it("is a silent no-op when there is no vibration API", () => {
    expect(haptic("threshold")).toBe(false);
    expect(haptic("commit")).toBe(false);
  });

  it("swallows a platform rejection instead of breaking the gesture", () => {
    stubVibrate(() => {
      throw new Error("not allowed");
    });
    expect(haptic("threshold")).toBe(false);
  });
});
