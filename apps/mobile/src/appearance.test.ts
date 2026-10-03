// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACCENT_OPTIONS,
  APPEARANCE_EVENT,
  APPEARANCE_STORAGE_KEY,
  DEFAULT_APPEARANCE,
  PHOTO_QUALITY_HIGH,
  PHOTO_QUALITY_STANDARD,
  TEXT_SCALE_OPTIONS,
  applyAppearance,
  currentPhotoQuality,
  effectiveReduceMotion,
  loadAppearance,
  photoQualityFor,
  resolveReduceMotion,
  saveAppearance,
  type AppearanceSettings,
} from "./appearance";

afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("style");
  document.documentElement.classList.remove("fb-reduce-motion");
  delete document.documentElement.dataset.reduceMotionOverride;
});

describe("appearance settings module (AI-011 Quick Appearance)", () => {
  it("exposes defaults: emerald accent, standard scale, system motion, standard photo", () => {
    expect(DEFAULT_APPEARANCE).toEqual({
      accent: "emerald",
      textScale: "standard",
      reduceMotion: "system",
      highQualityPhoto: false,
    });
  });

  it("loads defaults when nothing is persisted", () => {
    expect(loadAppearance()).toEqual(DEFAULT_APPEARANCE);
  });

  it("falls back to defaults on corrupt or partial payloads", () => {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, "{not-json");
    expect(loadAppearance()).toEqual(DEFAULT_APPEARANCE);

    localStorage.setItem(
      APPEARANCE_STORAGE_KEY,
      JSON.stringify({ accent: "nope", textScale: "huge", highQualityPhoto: "yes" }),
    );
    const loaded = loadAppearance();
    expect(loaded.accent).toBe(DEFAULT_APPEARANCE.accent);
    expect(loaded.textScale).toBe(DEFAULT_APPEARANCE.textScale);
    expect(loaded.reduceMotion).toBe(DEFAULT_APPEARANCE.reduceMotion);
    expect(loaded.highQualityPhoto).toBe(false);
  });

  it("round-trips save/load and notifies listeners immediately (no Save button)", () => {
    const onChange = vi.fn();
    window.addEventListener(APPEARANCE_EVENT, onChange);
    try {
      const next: AppearanceSettings = {
        accent: "blue",
        textScale: "large",
        reduceMotion: "reduce",
        highQualityPhoto: true,
      };
      saveAppearance(next);
      expect(loadAppearance()).toEqual(next);
      expect(onChange).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(APPEARANCE_EVENT, onChange);
    }
  });

  it("offers a curated accent set with unique ids and valid hex swatches", () => {
    expect(ACCENT_OPTIONS.length).toBeGreaterThanOrEqual(4);
    const ids = ACCENT_OPTIONS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const accent of ACCENT_OPTIONS) {
      expect(accent.label.length).toBeGreaterThan(0);
      expect(accent.swatch).toMatch(/^#[0-9a-f]{6}$/i);
      expect(accent.onAccent).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("offers a text-size scale as ascending root percentages", () => {
    expect(TEXT_SCALE_OPTIONS.length).toBeGreaterThanOrEqual(3);
    const percents = TEXT_SCALE_OPTIONS.map((t) => t.percent);
    expect([...percents].sort((a, b) => a - b)).toEqual(percents);
    expect(percents).toContain(100);
  });

  it("applyAppearance sets accent CSS vars, root scale, and motion markers", () => {
    applyAppearance({
      accent: "blue",
      textScale: "large",
      reduceMotion: "reduce",
      highQualityPhoto: false,
    });
    const root = document.documentElement;
    const swatch = ACCENT_OPTIONS.find((a) => a.id === "blue")!.swatch;
    expect(root.style.getPropertyValue("--fb-primary-light").trim()).toBe(swatch);
    expect(root.style.getPropertyValue("--fb-accent").trim()).toBe("var(--fb-primary)");
    expect(root.style.getPropertyValue("--fb-accent-ink").trim().length).toBeGreaterThan(0);
    const large = TEXT_SCALE_OPTIONS.find((t) => t.id === "large")!.percent;
    expect(root.style.fontSize).toBe(`${large}%`);
    expect(root.dataset.reduceMotionOverride).toBe("reduce");
    expect(root.classList.contains("fb-reduce-motion")).toBe(true);
  });

  it("applyAppearance clears the reduce-motion marker when motion is full", () => {
    applyAppearance({ ...DEFAULT_APPEARANCE, reduceMotion: "full" });
    expect(document.documentElement.classList.contains("fb-reduce-motion")).toBe(false);
  });

  it("layers the reduce-motion override on top of the OS setting", () => {
    expect(resolveReduceMotion("reduce", false)).toBe(true);
    expect(resolveReduceMotion("reduce", true)).toBe(true);
    expect(resolveReduceMotion("full", true)).toBe(false);
    expect(resolveReduceMotion("full", false)).toBe(false);
    // System defers to the OS.
    expect(resolveReduceMotion("system", true)).toBe(true);
    expect(resolveReduceMotion("system", false)).toBe(false);
  });

  it("effectiveReduceMotion reads the persisted override", () => {
    saveAppearance({ ...DEFAULT_APPEARANCE, reduceMotion: "reduce" });
    expect(effectiveReduceMotion()).toBe(true);
    saveAppearance({ ...DEFAULT_APPEARANCE, reduceMotion: "full" });
    expect(effectiveReduceMotion()).toBe(false);
  });

  it("exposes standard vs high photo quality for the image pipeline to consume", () => {
    expect(PHOTO_QUALITY_STANDARD.jpeg).toBeLessThan(PHOTO_QUALITY_HIGH.jpeg);
    expect(PHOTO_QUALITY_STANDARD.webp).toBeLessThan(PHOTO_QUALITY_HIGH.webp);
    expect(photoQualityFor(false)).toEqual(PHOTO_QUALITY_STANDARD);
    expect(photoQualityFor(true)).toEqual(PHOTO_QUALITY_HIGH);

    saveAppearance({ ...DEFAULT_APPEARANCE, highQualityPhoto: true });
    expect(currentPhotoQuality()).toEqual(PHOTO_QUALITY_HIGH);
    saveAppearance({ ...DEFAULT_APPEARANCE, highQualityPhoto: false });
    expect(currentPhotoQuality()).toEqual(PHOTO_QUALITY_STANDARD);
  });
});
