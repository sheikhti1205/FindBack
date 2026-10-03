import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ACCENT_OPTIONS, accentTokensFor } from "./appearance";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "./components/Button";
import { AppearancePanel } from "./components/AppearancePanel";
import { ThemeProvider } from "./theme";

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

/** sRGB alpha compositing, including whole-element fading into its surface. */
function composite(foreground: string, background: string, opacity: number) {
  return `#${[1, 3, 5].map((start) => {
    const fg = parseInt(foreground.slice(start, start + 2), 16);
    const bg = parseInt(background.slice(start, start + 2), 16);
    return Math.round(fg * opacity + bg * (1 - opacity)).toString(16).padStart(2, "0");
  }).join("")}`;
}

const buttonClasses = renderToStaticMarkup(createElement(Button, { children: "Continue" })).match(/class="([^"]+)"/)![1]!;
const panelMarkup = renderToStaticMarkup(createElement(ThemeProvider, { children: createElement(AppearancePanel) }));
const hintClasses = panelMarkup.match(/class="([^"]+)">Bright surfaces<\/span>/)![1]!;

function primaryStateBackground(base: string, source: string, state: "hover" | "active") {
  if (!buttonClasses.includes("fb-button-primary")) return base;
  // Verify the state layer is consumed by this enabled Button, not merely defined.
  const rule = block(`.fb-button-primary:not(:disabled):${state}`);
  const role = state === "hover" ? "--fb-primary-hover-layer" : "--fb-primary-pressed-layer";
  expect(token(rule, "background-image")).toBe(`linear-gradient(var(${role}), var(${role}))`);
  const rgba = token(source, role).match(/^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/)!;
  const layer = `#${rgba.slice(1, 4).map((channel) => Number(channel).toString(16).padStart(2, "0")).join("")}`;
  return composite(layer, base, Number(rgba[4]));
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
    it(`${mode}: legacy Quick Appearance hints meet AA after actual opacity compositing`, () => {
      const opacity = Number(hintClasses.match(/(?:^| )opacity-(\d+)/)?.[1] ?? "100") / 100;
      // Unselected, hovered, and selected legacy cards use these surfaces.
      for (const surface of ["--fb-surface-container-low", "--fb-surface-container", "--fb-surface"]) {
        const background = token(source, surface);
        const visibleInk = composite(token(source, "--fb-on-surface-variant"), background, opacity);
        expect(contrast(visibleInk, background)).toBeGreaterThanOrEqual(4.5);
      }
    });
    for (const state of ["hover", "active"] as const) {
      it.each(ACCENT_OPTIONS)(`${mode}: enabled $id Button ${state} rendered text meets AA`, ({ id }) => {
        const colors = accentTokensFor(id, mode);
        const opacity = Number(buttonClasses.match(new RegExp(`${state}:opacity-(\\d+)`))?.[1] ?? "100") / 100;
        const stateBackground = primaryStateBackground(colors.primary, source, state);
        for (const surface of surfaces) {
          const background = token(source, surface);
          const visibleBackground = composite(stateBackground, background, opacity);
          const visibleLabel = composite(colors.onPrimary, background, opacity);
          expect(contrast(visibleLabel, visibleBackground)).toBeGreaterThanOrEqual(4.5);
        }
        expect(opacity).toBe(1);
      });
    }
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
