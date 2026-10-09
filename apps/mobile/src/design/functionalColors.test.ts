// TDD RED: canonical functional color map per OWNER_DIRECTIVE W5.
// Every entry carries light+dark ramps; chip ink-on-bg and text-on-surface
// must meet AA on neutral surfaces (incl. true black #000000 for dark).
import { describe, expect, it } from "vitest";
import {
  FUNCTIONAL_COLORS,
  MENTION_FUNCTIONAL_ID,
  REACTION_KIND_FUNCTIONAL,
  WOW_RATIONALE,
  functionalColorFor,
  type FunctionalColorId,
} from "./functionalColors";

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((start) => {
    const c = parseInt(hex.slice(start, start + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const LIGHT_SURFACES = ["#ffffff", "#f8f9fa", "#e9ecef"] as const;
const DARK_SURFACES = ["#212529", "#343a40", "#000000"] as const;

const DIRECTIVE_IDS: readonly FunctionalColorId[] = [
  "brand",
  "lost",
  "found",
  "matched",
  "recovered",
  "ai",
  "notifications",
  "appearance",
  "media",
  "privacy",
  "mentions",
  "love",
  "helpful",
  "support",
  "wow",
  "warning",
  "error",
];

describe("functionalColors canonical map (W5)", () => {
  it("covers every directive family with valid hex ramps", () => {
    for (const id of DIRECTIVE_IDS) {
      const entry = FUNCTIONAL_COLORS[id];
      expect(entry, id).toBeDefined();
      expect(entry.id).toBe(id);
      expect(entry.usage.length, `${id} usage`).toBeGreaterThan(0);
      for (const mode of ["light", "dark"] as const) {
        for (const role of ["bg", "ink", "text"] as const) {
          expect(entry[mode][role], `${id}.${mode}.${role}`).toMatch(/^#[0-9a-f]{6}$/i);
        }
      }
    }
  });

  it("keeps app surfaces neutral: no functional entry redefines a surface token", () => {
    const keys = Object.keys(FUNCTIONAL_COLORS);
    expect(keys).not.toContain("surface");
    for (const entry of Object.values(FUNCTIONAL_COLORS)) {
      expect(entry.usage, `${entry.id} usage`).toMatch(/neutral surfaces/i);
    }
  });

  it.each(DIRECTIVE_IDS)("%s chip ink-on-bg meets AA in both modes", (id) => {
    const entry = FUNCTIONAL_COLORS[id]!;
    expect(contrast(entry.light.ink, entry.light.bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(entry.dark.ink, entry.dark.bg)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(DIRECTIVE_IDS)("%s text meets AA on its neutral surfaces incl. true black", (id) => {
    const entry = FUNCTIONAL_COLORS[id]!;
    for (const surface of LIGHT_SURFACES) {
      expect(contrast(entry.light.text, surface), `${id} light on ${surface}`).toBeGreaterThanOrEqual(4.5);
    }
    for (const surface of DARK_SURFACES) {
      expect(contrast(entry.dark.text, surface), `${id} dark on ${surface}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("maps reaction kinds to Love rose / Helpful blue / Support teal-green / Wow bronze", () => {
    expect(REACTION_KIND_FUNCTIONAL).toEqual({
      LOVE: "love",
      HELPFUL: "helpful",
      SUPPORT: "support",
      WOW: "wow",
    });
    expect(FUNCTIONAL_COLORS.love!.usage).toMatch(/rose/i);
    expect(FUNCTIONAL_COLORS.support!.usage).toMatch(/teal/i);
  });

  it("documents the Wow pick: restrained bronze-gold, icon-only, never a status chip", () => {
    expect(WOW_RATIONALE.length).toBeGreaterThan(0);
    expect(WOW_RATIONALE).toMatch(/icon-only/i);
    expect(FUNCTIONAL_COLORS.wow!.usage).toMatch(/never.*status/i);
  });

  it("routes mention links to the blue/teal family, never the user accent", () => {
    expect(MENTION_FUNCTIONAL_ID).toBe("mentions");
    expect(functionalColorFor("mentions", "light").text).toBe("#0b57d0");
    expect(functionalColorFor("mentions", "dark").text).toBe("#a8c7fa");
  });

  it("resolves ramps per mode without any accent input (accent cannot leak in)", () => {
    expect(functionalColorFor("lost", "light")).toEqual(FUNCTIONAL_COLORS.lost!.light);
    expect(functionalColorFor("lost", "dark")).toEqual(FUNCTIONAL_COLORS.lost!.dark);
    // No accent parameter exists on the resolver.
    expect(functionalColorFor.length).toBe(2);
  });
});
