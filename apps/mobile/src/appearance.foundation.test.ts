// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import * as appearance from "./appearance";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  document.documentElement.removeAttribute("style");
});

describe("consumer appearance migration", () => {
  it("distinguishes untouched device navigation from explicit legacy and current choices", () => {
    expect(appearance.loadAppearance().navLayoutChosen).toBe(false);
    expect(appearance.migrateAppearance({ navLayout: "rail" })).toMatchObject({ navLayout: "rail", navLayoutChosen: true });
    expect(appearance.migrateAppearance({ navLayout: "bottom" })).toMatchObject({ navLayout: "bottom", navLayoutChosen: true });
    expect(appearance.migrateAppearance({ navLayout: "drawer" }).navLayoutChosen).toBe(false);
    expect(appearance.migrateAppearance({ ...appearance.DEFAULT_APPEARANCE, navLayoutChosen: false }).navLayoutChosen).toBe(false);
    expect(appearance.migrateAppearance({ navLayout: "rail", navLayoutChosen: "yes" }).navLayoutChosen).toBe(false);
  });
  it.each([
    ["ink", "mono"], ["green", "emerald"], ["plum", "violet"],
    ["clay", "rose"], ["blue", "blue"], ["mono", "mono"],
    ["amber", "orange"], ["cyan", "teal"], ["lime", "emerald"], ["pink", "rose"],
  ])("migrates %s to %s without resetting other preferences", (old, next) => {
    localStorage.setItem(appearance.APPEARANCE_STORAGE_KEY, JSON.stringify({
      accent: old, textScale: "xlarge", reduceMotion: "reduce", highQualityPhoto: true,
    }));
    expect(appearance.loadAppearance()).toEqual({
      accent: next, accentSource: "preset", textScale: "xlarge", reduceMotion: "reduce", highQualityPhoto: true,
      navLayout: "bottom",
      navLayoutChosen: false,
    });
  });

  it.each([null, [], 42, "green", { accent: "unknown" }])("safely handles malformed shape %j", (value) => {
    localStorage.setItem(appearance.APPEARANCE_STORAGE_KEY, JSON.stringify(value));
    expect(appearance.loadAppearance()).toEqual(appearance.DEFAULT_APPEARANCE);
  });

  it("offers eight curated accents with Blue as the fresh default", () => {
    const ids = appearance.ACCENT_OPTIONS.map((a) => a.id);
    expect(ids).toEqual([
      "blue", "indigo", "violet", "emerald", "teal", "rose", "orange", "mono",
    ]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(appearance.DEFAULT_APPEARANCE.accent);
    expect(appearance.DEFAULT_APPEARANCE.accent).toBe("blue");
    expect(appearance.ACCENT_OPTIONS[0]?.label).toBe("Blue");
  });

  it("emits light and dark pairs for each accent so a theme switch cannot leave stale colors", () => {
    for (const accent of appearance.ACCENT_OPTIONS) {
      appearance.applyAppearance({ ...appearance.DEFAULT_APPEARANCE, accent: accent.id });
      for (const mode of ["light", "dark"] as const) {
        const tokens = appearance.accentTokensFor(accent.id, mode);
        const style = document.documentElement.style;
        expect(style.getPropertyValue(`--fb-primary-${mode}`)).toBe(tokens.primary);
        expect(style.getPropertyValue(`--fb-on-primary-${mode}`)).toBe(tokens.onPrimary);
        expect(style.getPropertyValue(`--fb-primary-container-${mode}`)).toBe(tokens.primaryContainer);
        expect(style.getPropertyValue(`--fb-on-primary-container-${mode}`)).toBe(tokens.onPrimaryContainer);
        expect(style.getPropertyValue(`--fb-link-${mode}`)).toBe(tokens.link);
      }
    }
  });

  it("keeps live updates usable when persistence is blocked", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    const first = renderHook(() => appearance.useAppearance());
    const second = renderHook(() => appearance.useAppearance());
    act(() => first.result.current.update({ accent: "blue", highQualityPhoto: true }));
    expect(first.result.current.settings.accent).toBe("blue");
    expect(second.result.current.settings.accent).toBe("blue");
    expect(second.result.current.settings.highQualityPhoto).toBe(true);
  });

  it("does not lose independent updates from two mounted consumers", () => {
    const first = renderHook(() => appearance.useAppearance());
    const second = renderHook(() => appearance.useAppearance());
    act(() => {
      first.result.current.update({ textScale: "large" });
      second.result.current.update({ highQualityPhoto: true });
    });
    expect(appearance.loadAppearance()).toMatchObject({ textScale: "large", highQualityPhoto: true });
  });
});
