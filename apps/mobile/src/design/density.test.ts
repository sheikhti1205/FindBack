// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { density } from "./density";

describe("density tokens (W4.1 compactness targets)", () => {
  it("keeps the primary button visual height in 42–44", () => {
    expect(density.primaryButtonHeight).toBeGreaterThanOrEqual(42);
    expect(density.primaryButtonHeight).toBeLessThanOrEqual(44);
  });

  it("keeps the compact secondary button visual height in 36–40", () => {
    expect(density.compactButtonHeight).toBeGreaterThanOrEqual(36);
    expect(density.compactButtonHeight).toBeLessThanOrEqual(40);
  });

  it("keeps the icon visual size in 20–22", () => {
    expect(density.iconSize).toBeGreaterThanOrEqual(20);
    expect(density.iconSize).toBeLessThanOrEqual(22);
  });

  it("keeps every effective touch target at >=44", () => {
    expect(density.minTouchTarget).toBeGreaterThanOrEqual(44);
    expect(density.settingsRowHeight).toBeGreaterThanOrEqual(density.minTouchTarget);
    expect(density.primaryButtonHeight).toBeGreaterThanOrEqual(density.minTouchTarget);
  });

  it("keeps the settings row at the house 60px row target", () => {
    expect(density.settingsRowHeight).toBeGreaterThanOrEqual(60);
    expect(density.settingsRowHeight).toBeLessThanOrEqual(64);
  });

  it("keeps the small chip visual height in 28–32", () => {
    expect(density.chipHeight).toBeGreaterThanOrEqual(28);
    expect(density.chipHeight).toBeLessThanOrEqual(32);
  });

  it("keeps common card padding in 10–12", () => {
    expect(density.cardPadding).toBeGreaterThanOrEqual(10);
    expect(density.cardPadding).toBeLessThanOrEqual(12);
  });

  it("keeps the common section gap in 12–16", () => {
    expect(density.sectionGap).toBeGreaterThanOrEqual(12);
    expect(density.sectionGap).toBeLessThanOrEqual(16);
  });

  it("keeps the common radius in 10–14", () => {
    expect(density.radius).toBeGreaterThanOrEqual(10);
    expect(density.radius).toBeLessThanOrEqual(14);
  });
});
