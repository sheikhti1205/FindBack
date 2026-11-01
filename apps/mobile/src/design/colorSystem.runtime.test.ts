// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACCENT_OPTIONS, DEFAULT_APPEARANCE, applyAppearance, colorSystemCss } from "../appearance";
import { applyTheme, bootstrapAppearance } from "../theme";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.className = "";
  document.documentElement.removeAttribute("style");
  document.getElementById("findback-color-system")?.remove();
});
afterEach(() => { localStorage.clear(); });

describe("canonical palette installed through the shipping appearance/theme owners", () => {
  it("bootstraps exactly one canonical stylesheet before content, even after repeated applies", () => {
    bootstrapAppearance();
    bootstrapAppearance();
    const styles = document.querySelectorAll("#findback-color-system");
    expect(styles).toHaveLength(1);
    expect(styles[0]?.textContent).toBe(colorSystemCss());
    expect(document.documentElement.dataset.accent).toBe("blue");
  });

  it.each([
    ["light", "#f8f9fa", "#fbeed3", "#ddf0e1", "#e4e9fc", "#d8f0e6", "#755400", "#ba1a1a"],
    ["dark", "#18191b", "#3a2c00", "#12331f", "#1c2a5c", "#0e3b2c", "#e9c46a", "#ffb4ab"],
    ["amoled", "#000000", "#3a2c00", "#12331f", "#1c2a5c", "#0e3b2c", "#e9c46a", "#ffb4ab"],
  ] as const)("%s applies real CSS values and never lets any accent recolor meaning", (mode, surface, ...semantic) => {
    applyTheme({ theme: mode === "light" ? "light" : "dark", trueBlackDark: mode === "amoled" });
    for (const accent of ACCENT_OPTIONS) {
      applyAppearance({ ...DEFAULT_APPEARANCE, accent: accent.id });
      const style = getComputedStyle(document.documentElement);
      expect(style.getPropertyValue("--fb-surface").trim()).toBe(surface);
      const roles = ["--fb-lost-bg", "--fb-found-bg", "--fb-status-matched-bg", "--fb-status-recovered-bg", "--fb-warning", "--fb-error"];
      expect(roles.map((role) => style.getPropertyValue(role).trim())).toEqual(semantic);
      expect(style.getPropertyValue(`--fb-primary-${mode === "light" ? "light" : "dark"}`).trim()).toBe(mode === "light" ? accent.swatch : accent.darkSwatch);
    }
  });
});
