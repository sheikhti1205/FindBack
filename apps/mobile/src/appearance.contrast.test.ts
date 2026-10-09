import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ACCENT_OPTIONS, DEFAULT_APPEARANCE, accentTokensFor } from "./appearance";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "./components/Button";

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
    expect(token(amoled, "--fb-surface-container-low")).toBe("#212529");
    expect(token(amoled, "--fb-surface-container")).toBe("#343a40");
    expect(token(amoled, "--fb-surface-container-high")).toBe("#495057");
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
    // True-black (`.amoled`) reuses the dark accent tokens; only its surfaces differ.
    const accentMode = mode === "light" ? "light" : "dark";
    it(`${mode}: body and supporting text meet AA on every surface`, () => {
      for (const surface of surfaces) {
        expect(contrast(token(source, "--fb-on-surface"), token(source, surface))).toBeGreaterThanOrEqual(4.5);
        expect(contrast(token(source, "--fb-on-surface-variant"), token(source, surface))).toBeGreaterThanOrEqual(4.5);
      }
    });
    it(`${mode}: secondary text meets AA on every surface`, () => {
      for (const surface of ["--fb-surface-container-low", "--fb-surface-container", "--fb-surface"]) {
        const background = token(source, surface);
        expect(contrast(token(source, "--fb-on-surface-variant"), background)).toBeGreaterThanOrEqual(4.5);
      }
    });
    for (const state of ["hover", "active"] as const) {
      it.each(ACCENT_OPTIONS)(`${mode}: enabled $id Button ${state} rendered text meets AA`, ({ id }) => {
        const colors = accentTokensFor(id, accentMode);
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
      const colors = accentTokensFor(id, accentMode);
      expect(contrast(colors.primary, colors.onPrimary)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colors.primaryContainer, colors.onPrimaryContainer)).toBeGreaterThanOrEqual(4.5);
      for (const surface of surfaces) {
        expect(contrast(colors.primary, token(source, surface))).toBeGreaterThanOrEqual(3);
        expect(contrast(colors.link, token(source, surface))).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});

describe("QA I — new consumer-UI token pairings (StatusPill, icons, switches, errors)", () => {
  const css = readFileSync("src/index.css", "utf8");
  const settingsCss = readFileSync("src/components/settings/settings.css", "utf8");
  function blockIn(source: string, selector: string) {
    const start = source.indexOf(`${selector} {`);
    expect(start, selector).toBeGreaterThanOrEqual(0);
    return source.slice(start).split("}")[0]!;
  }
  function tokenIn(source: string, name: string) {
    const value = source.match(new RegExp(`${name}\\s*:\\s*([^;]+);`))?.[1]?.trim();
    expect(value, name).toBeDefined();
    return value!;
  }
  const rootSource = blockIn(css, ":root");
  /** Resolve var(--x[, fallback]) through the mode block, then :root. */
  function resolveToken(modeSource: string, name: string, depth = 0): string {
    expect(depth, `var() cycle for ${name}`).toBeLessThan(5);
    const raw = modeSource.match(new RegExp(`${name}\\s*:\\s*([^;]+);`))?.[1]?.trim()
      ?? rootSource.match(new RegExp(`${name}\\s*:\\s*([^;]+);`))?.[1]?.trim();
    expect(raw, name).toBeDefined();
    const ref = raw!.match(/^var\(\s*(--[\w-]+)(?:\s*,\s*(.+))?\)$/);
    if (!ref) return raw!;
    const [, target, fallback] = ref;
    const next = modeSource.match(new RegExp(`${target}\\s*:\\s*([^;]+);`))?.[1]?.trim()
      ?? rootSource.match(new RegExp(`${target}\\s*:\\s*([^;]+);`))?.[1]?.trim();
    if (next) return resolveToken(modeSource, target!, depth + 1);
    expect(fallback, `${name} fallback`).toBeDefined();
    return fallback!;
  }
  function contrastLocal(a: string, b: string) {
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
  // AMOLED keeps .dark alongside .amoled, so its semantic text tokens resolve
  // from the .dark rule (the .amoled block only redefines surfaces).
  const themeSource: Record<"light" | "dark" | "amoled", string> = {
    light: blockIn(css, ":root"),
    dark: blockIn(css, ".dark"),
    amoled: blockIn(css, ".dark"),
  };
  const themeSurfaces: Record<"light" | "dark" | "amoled", string[]> = {
    light: ["#f8f9fa", "#ffffff", "#e9ecef", "#dee2e6"],
    dark: ["#212529", "#343a40", "#343a40", "#495057"],
    amoled: ["#000000", "#212529", "#343a40", "#495057"],
  };

  it.each(["light", "dark", "amoled"] as const)("%s: error/warning/success text meets AA on every surface", (mode) => {
    const source = themeSource[mode];
    for (const surface of themeSurfaces[mode]) {
      expect(contrastLocal(tokenIn(source, "--fb-error"), surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrastLocal(tokenIn(source, "--fb-warning"), surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrastLocal(tokenIn(source, "--fb-success"), surface)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(["light", "dark", "amoled"] as const)("%s: StatusPill success/error pairs meet AA", (mode) => {
    const source = themeSource[mode];
    expect(
      contrastLocal(tokenIn(source, "--fb-found-ink"), tokenIn(source, "--fb-found-bg")),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastLocal(tokenIn(source, "--fb-lost-ink"), tokenIn(source, "--fb-lost-bg")),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it.each(["light", "dark", "amoled"] as const)("%s: StatusPill warning (warning ink on container) meets AA", (mode) => {
    const source = themeSource[mode];
    const container = themeSurfaces[mode][2]!;
    expect(contrastLocal(tokenIn(source, "--fb-warning"), container)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(["light", "dark"] as const)("%s: category icon tiles keep AA ink on their own tile", (mode) => {
    // Selectors are `.fb-setting-icon[data-tone="x"]` (+ `.dark` prefix in dark).
    for (const tone of ["blue", "lavender", "teal", "amber", "coral", "violet", "green", "sky", "neutral"]) {
      const selector = mode === "light"
        ? `.fb-setting-icon[data-tone="${tone}"]`
        : `.dark .fb-setting-icon[data-tone="${tone}"]`;
      const rule = blockIn(settingsCss, selector);
      expect(
        contrastLocal(tokenIn(rule, "--fb-icon-ink"), tokenIn(rule, "--fb-icon-bg")),
        tone,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(["light", "dark", "amoled"] as const)("%s: switch track/thumb UI contrast meets 3:1", (mode) => {
    const source = themeSource[mode];
    const track = themeSurfaces[mode][3]!;
    // Unchecked: outline + thumb against the track; checked pairs inherit the
    // accent primary/onPrimary coverage asserted above.
    expect(contrastLocal(resolveToken(source, "--fb-control-outline"), track)).toBeGreaterThanOrEqual(3);
    expect(contrastLocal(resolveToken(source, "--fb-on-surface-variant"), track)).toBeGreaterThanOrEqual(3);
  });

  it("dark semantic tokens exist so the .dark+.amoled cascade keeps AA text", () => {
    const dark = blockIn(css, ".dark");
    for (const name of ["--fb-error", "--fb-warning", "--fb-success", "--fb-on-error", "--fb-found-bg", "--fb-found-ink", "--fb-lost-bg", "--fb-lost-ink"]) {
      expect(tokenIn(dark, name), name).toBeTruthy();
    }
  });
});

describe("neutral structural palette (v0.9.0-beta.1)", () => {
  const css = readFileSync("src/index.css", "utf8");
  function blockOf(selector: string) {
    const start = css.indexOf(`${selector} {`);
    expect(start, selector).toBeGreaterThanOrEqual(0);
    return css.slice(start).split("}")[0]!;
  }
  function tokenOf(source: string, name: string) {
    const value = source.match(new RegExp(`${name}\\s*:\\s*([^;]+);`))?.[1]?.trim();
    expect(value, name).toBeDefined();
    return value!;
  }
  function rgb(hex: string) {
    return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  }

  /**
   * Structural surfaces must be neutral, not green/cream tinted. The adopted
   * neutral family is a cool gray (B >= G >= R); a green tint has G > B and a
   * cream/beige tint has R > B, so this catches both regressions.
   */
  const modes = [
    ["light", ":root"],
    ["dark", ".dark"],
    ["amoled", ".amoled"],
  ] as const;
  const structuralTokens = [
    "--fb-surface",
    "--fb-surface-container-low",
    "--fb-surface-container",
    "--fb-surface-container-high",
  ];

  it.each(modes)("%s structural surfaces are neutral gray (no green/cream tint)", (_mode, selector) => {
    const source = blockOf(selector);
    for (const name of structuralTokens) {
      const [r, g, b] = rgb(tokenOf(source, name));
      expect(b! >= g! && g! >= r!, `${name}=${tokenOf(source, name)} is not a cool neutral`).toBe(true);
    }
  });

  it.each([["light", ":root"], ["dark", ".dark"]] as const)(
    "%s status tint surface stays neutral (Found badge is functional green per W5)",
    (_mode, selector) => {
      const source = blockOf(selector);
      for (const name of ["--fb-tint-bg"]) {
        const [r, g, b] = rgb(tokenOf(source, name));
        expect(b! >= g! && g! >= r!, `${name}=${tokenOf(source, name)} is not a cool neutral`).toBe(true);
      }
    },
  );

  it("has retired the green/cream surface values from every mode block", () => {
    for (const legacy of ["#f6f7f5", "#eff1ed", "#e9ece7", "#edf3ec", "#e2f1e5", "#101211", "#1a1d1b", "#202421", "#282c29"]) {
      expect(css.includes(legacy), `${legacy} must not appear`).toBe(false);
    }
  });

  it("defaults the accent to mono while keeping all seven options", () => {
    expect(DEFAULT_APPEARANCE.accent).toBe("mono");
    expect(ACCENT_OPTIONS.map((a) => a.id)).toEqual([
      "emerald", "blue", "violet", "rose", "amber", "teal", "mono",
    ]);
  });

  it("binds the Found badge to the W5 functional green with an icon + text affordance elsewhere", () => {
    const light = blockOf(":root");
    expect(tokenOf(light, "--fb-found-bg")).toBe("#ddf0e1");
    expect(tokenOf(light, "--fb-found-ink")).toBe("#123f1f");
  });

  it("binds every W5 functional chip pair with AA ink-on-bg in both modes", () => {
    const modes = [["light", ":root"], ["dark", ".dark"]] as const;
    const pairs: Array<[string, string]> = [
      ["--fb-lost-ink", "--fb-lost-bg"],
      ["--fb-found-ink", "--fb-found-bg"],
      ["--fb-status-matched-ink", "--fb-status-matched-bg"],
      ["--fb-status-recovered-ink", "--fb-status-recovered-bg"],
      ["--fb-status-closed-ink", "--fb-status-closed-bg"],
    ];
    for (const [_mode, selector] of modes) {
      const source = blockOf(selector);
      for (const [ink, bg] of pairs) {
        expect(contrast(token(source, ink), token(source, bg)), `${selector} ${ink}/${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("keeps W5 reaction/mention accents legible on neutral surfaces incl. true black", () => {
    const light = blockOf(":root");
    const dark = blockOf(".dark");
    const lightSurfaces = ["#ffffff", "#f8f9fa", "#e9ecef"];
    const darkSurfaces = ["#212529", "#343a40", "#000000"];
    for (const name of ["--fb-reaction-love", "--fb-reaction-helpful", "--fb-reaction-support", "--fb-reaction-wow", "--fb-mention"]) {
      for (const surface of lightSurfaces) {
        expect(contrast(token(light, name), surface), `light ${name} on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
      for (const surface of darkSurfaces) {
        expect(contrast(token(dark, name), surface), `dark ${name} on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
