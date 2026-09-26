// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  backdropTransition,
  motionDurations,
  motionEasings,
  sheetTransition,
  shouldReduceMotion,
} from "./uiMotion";

describe("uiMotion tokens (handover 04 motion policy)", () => {
  it("exposes instant/fast/standard/sheet durations in the approved ranges", () => {
    expect(motionDurations.instant).toBeGreaterThanOrEqual(0.08);
    expect(motionDurations.instant).toBeLessThanOrEqual(0.12);
    expect(motionDurations.fast).toBeGreaterThan(0.12);
    expect(motionDurations.fast).toBeLessThanOrEqual(0.18);
    expect(motionDurations.standard).toBeGreaterThanOrEqual(0.18);
    expect(motionDurations.standard).toBeLessThanOrEqual(0.24);
    expect(motionDurations.sheet).toBeGreaterThanOrEqual(0.22);
    expect(motionDurations.sheet).toBeLessThanOrEqual(0.32);
  });

  it("orders durations and keeps ordinary motion at or under 350ms", () => {
    expect(motionDurations.instant).toBeLessThanOrEqual(motionDurations.fast);
    expect(motionDurations.fast).toBeLessThanOrEqual(motionDurations.standard);
    expect(motionDurations.standard).toBeLessThanOrEqual(motionDurations.sheet);
    for (const duration of Object.values(motionDurations)) {
      expect(duration).toBeLessThanOrEqual(0.35);
    }
  });

  it("exposes cubic-bezier easings (no per-screen hardcoded easing)", () => {
    for (const easing of Object.values(motionEasings)) {
      expect(Array.isArray(easing)).toBe(true);
      expect(easing).toHaveLength(4);
      for (const value of easing) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
  });

  it("derives sheet/backdrop transitions from the shared tokens", () => {
    expect(sheetTransition.duration).toBe(motionDurations.sheet);
    expect(backdropTransition.duration).toBeLessThanOrEqual(motionDurations.fast);
  });

  describe("shouldReduceMotion()", () => {
    const realMatchMedia = window.matchMedia;

    afterEach(() => {
      window.matchMedia = realMatchMedia;
    });

    it("returns false when the device prefers full motion", () => {
      window.matchMedia = vi.fn(
        () => ({ matches: false }) as unknown as MediaQueryList,
      );
      expect(shouldReduceMotion()).toBe(false);
    });

    it("returns true when the device prefers reduced motion", () => {
      window.matchMedia = vi.fn(
        () => ({ matches: true }) as unknown as MediaQueryList,
      );
      expect(shouldReduceMotion()).toBe(true);
    });

    it("never throws when matchMedia is unavailable", () => {
      // @ts-expect-error jsdom without matchMedia (SSR-like guard)
      delete window.matchMedia;
      expect(() => shouldReduceMotion()).not.toThrow();
      expect(shouldReduceMotion()).toBe(false);
    });
  });
});

const REQUIRED_TOKENS = [
  "--composer-surface",
  "--user-bubble",
  "--assistant-surface",
  "--primary-action",
  "--scrim",
  "--shadow-sm",
  "--shadow-md",
  "--skeleton-base",
  "--skeleton-highlight",
] as const;

function themeSegments(css: string): { root: string; dark: string; media: string } {
  const darkAt = css.indexOf(".dark {");
  const mediaAt = css.indexOf("@media (prefers-color-scheme: dark)");
  expect(darkAt).toBeGreaterThan(-1);
  expect(mediaAt).toBeGreaterThan(darkAt);
  return {
    root: css.slice(0, darkAt),
    dark: css.slice(darkAt, mediaAt),
    media: css.slice(mediaAt),
  };
}

function declaration(segment: string, token: string): string | null {
  const match = segment.match(new RegExp(`${token}\\s*:\\s*([^;]+);`));
  return match?.[1]?.trim() ?? null;
}

function luminance(hex: string): number {
  const m = hex.match(/^#([0-9a-f]{6})$/i);
  if (!m?.[1]) throw new Error(`expected 6-digit hex, got ${hex}`);
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(m[1]!.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe("motion CSS tokens (index.css light + dark + media query)", () => {
  const css = readFileSync("src/index.css", "utf8");
  const segments = themeSegments(css);

  it.each(REQUIRED_TOKENS)("defines %s in :root, .dark, and the media query", (token) => {
    expect(declaration(segments.root, token)).not.toBeNull();
    expect(declaration(segments.dark, token)).not.toBeNull();
    expect(declaration(segments.media, token)).not.toBeNull();
  });

  it("keeps primary-action AA contrast in both themes", () => {
    // Light: near-black action surface behind white label text.
    expect(contrast(declaration(segments.root, "--primary-action")!, "#ffffff"))
      .toBeGreaterThanOrEqual(4.5);
    // Dark: near-white action surface behind near-black label text.
    expect(contrast(declaration(segments.dark, "--primary-action")!, "#121212"))
      .toBeGreaterThanOrEqual(4.5);
  });

  it("keeps user-bubble AA contrast against on-surface text in both themes", () => {
    expect(
      contrast(
        declaration(segments.root, "--user-bubble")!,
        declaration(segments.root, "--fb-on-surface")!,
      ),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrast(
        declaration(segments.dark, "--user-bubble")!,
        declaration(segments.dark, "--fb-on-surface")!,
      ),
    ).toBeGreaterThanOrEqual(4.5);
  });
});
