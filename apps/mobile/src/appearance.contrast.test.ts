import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ACCENT_OPTIONS, accentTokensFor } from "./appearance";

const css = readFileSync("src/index.css", "utf8");
function block(selector: string) {
  return css.slice(css.indexOf(`${selector} {`)).split("}")[0]!;
}
function token(source: string, name: string) {
  const value = source.match(new RegExp(`${name}\\s*:\\s*([^;]+);`))?.[1]?.trim();
  expect(value, name).toBeDefined();
  return value!;
}
function contrast(a: string, b: string) {
  function luminance(hex: string) {
    const channels = [1, 3, 5].map((start) => {
      const c = parseInt(hex.slice(start, start + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
  }
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe("Soft Utility semantic palette", () => {
  it("keeps AMOLED truly black with distinct tonal elevation and no system override", () => {
    const amoled = block(".amoled");
    expect(token(amoled, "--fb-surface")).toBe("#000000");
    expect(token(amoled, "--fb-surface-container-low")).toBe("#0b0b0b");
    expect(token(amoled, "--fb-surface-container")).toBe("#111211");
    expect(token(amoled, "--fb-surface-container-high")).toBe("#171817");
    expect(css).toContain(":root:not(.light):not(.amoled)");
    expect(css).toMatch(/html,\s*body,\s*#root\s*\{[^}]*background: var\(--fb-surface\)/);
  });

  it("defines accent roles for controls, links, selection, focus and progress", () => {
    const root = block(":root");
    for (const name of ["--fb-primary", "--fb-on-primary", "--fb-primary-container", "--fb-on-primary-container",
      "--fb-focus", "--fb-link", "--fb-selection", "--fb-on-selection", "--fb-control-active", "--fb-control-outline", "--fb-progress", "--fb-accent", "--fb-accent-ink"]) {
      expect(token(root, name)).toBeTruthy();
    }
    expect(css).toContain("outline: 2px solid var(--fb-focus)");
    expect(css).toContain("--color-primary: var(--fb-primary)");
  });

  it("keeps the pre-module empty viewport black until preferences are bootstrapped", () => {
    expect(token(block(":root:not([data-theme])"), "--fb-surface")).toBe("#000000");
  });

  for (const mode of ["light", "dark", "amoled"] as const) {
    const source = block(mode === "light" ? ":root" : `.${mode}`);
    const surfaces = ["--fb-surface", "--fb-surface-container-low", "--fb-surface-container", "--fb-surface-container-high"];
    it(`${mode}: body and supporting text meet AA on every surface`, () => {
      for (const surface of surfaces) {
        expect(contrast(token(source, "--fb-on-surface"), token(source, surface))).toBeGreaterThanOrEqual(4.5);
        expect(contrast(token(source, "--fb-on-surface-variant"), token(source, surface))).toBeGreaterThanOrEqual(4.5);
      }
    });
    it.each(ACCENT_OPTIONS)(`${mode}: $id primary/container text AA and focus/control/link contrast`, ({ id }) => {
      const colors = accentTokensFor(id, mode);
      expect(contrast(colors.primary, colors.onPrimary)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colors.primaryContainer, colors.onPrimaryContainer)).toBeGreaterThanOrEqual(4.5);
      for (const surface of surfaces) {
        expect(contrast(colors.primary, token(source, surface))).toBeGreaterThanOrEqual(3);
        expect(contrast(colors.link, token(source, surface))).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});
