import { describe, expect, it } from "vitest";
import { COLOR_SYSTEM, colorTokensFor } from "./colorSystem";

function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map(i => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return r! * .2126 + g! * .7152 + b! * .0722;
}
describe("Product Fit graphite visual hierarchy", () => {
  it("uses distinct charcoal levels, not the old flattened gray or pure-black normal mode", () => {
    const n = COLOR_SYSTEM.neutrals.dark;
    expect(n).toMatchObject({ surface: "#18191b", low: "#202124", container: "#26272b", high: "#2d2f34", divider: "#34363b" });
    const levels = [n.surface, n.low, n.container, n.high].map(luminance);
    for (let i = 1; i < levels.length; i++) expect(levels[i]!).toBeGreaterThan(levels[i - 1]!);
    expect(luminance(n.high)).toBeLessThan(.04);
  });
  it("keeps light calm and AMOLED truly black, with raised controls rather than brighter decorative borders", () => {
    expect(COLOR_SYSTEM.neutrals.light.surface).toBe("#f8f9fa");
    const a = COLOR_SYSTEM.neutrals.amoled;
    expect(a.surface).toBe("#000000");
    expect(new Set([a.surface, a.low, a.container, a.high]).size).toBe(4);
    expect(a.container).toBe(COLOR_SYSTEM.neutrals.dark.container);
    expect(a.divider).toBe(COLOR_SYSTEM.neutrals.dark.divider);
    expect(luminance(a.divider)).toBeLessThan(luminance(COLOR_SYSTEM.neutrals.dark.outline));
  });
  it("routes the raised composer, calm chat bubble and base reading canvas through the same neutral owner", () => {
    const n = COLOR_SYSTEM.neutrals.dark, t = colorTokensFor("dark");
    expect(t["--composer-surface"]).toBe(n.low);
    expect(t["--user-bubble"]).toBe(n.high);
    expect(t["--assistant-surface"]).toBe(n.surface);
    expect(t["--fb-outline-variant"]).toBe(n.divider);
  });
});
