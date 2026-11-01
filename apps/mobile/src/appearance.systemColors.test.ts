// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { APPEARANCE_STORAGE_KEY, DEFAULT_APPEARANCE, loadAppearance, migrateAppearance, saveAppearance } from "./appearance";

afterEach(() => localStorage.clear());
describe("device-local System colors preference", () => {
  it("defaults legacy and fresh installs to presets, not wallpaper-following", () => {
    expect(migrateAppearance({ accent: "teal" })).toMatchObject({ accent: "teal", accentSource: "preset" });
    expect(DEFAULT_APPEARANCE).toMatchObject({ accent: "blue", accentSource: "preset" });
  });
  it("preserves the last preset and only the source choice, not derived native colors", () => {
    const settings = migrateAppearance({ accent: "violet", accentSource: "system", primary: "#123456", nativePalette: { light: "#ffffff" } });
    expect(settings).toEqual({ ...DEFAULT_APPEARANCE, accent: "violet", accentSource: "system" });
    saveAppearance(settings);
    expect(loadAppearance()).toEqual(settings);
    const raw = localStorage.getItem(APPEARANCE_STORAGE_KEY)!;
    expect(raw).not.toContain("#");
    expect(raw).not.toContain("nativePalette");
  });
  it("normalizes an invalid source independently of other valid fields", () => {
    expect(migrateAppearance({ accent: "amber", accentSource: "wallpaper-image", textScale: "large" }))
      .toMatchObject({ accent: "orange", accentSource: "preset", textScale: "large" });
  });
});
