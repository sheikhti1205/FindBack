// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APPEARANCE, saveAppearance } from "../appearance";
import { MorphLoader } from "./MorphLoader";

// vitest runs without `globals`, so RTL's auto-cleanup never registers.
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("MorphLoader (CF-010 §15)", () => {
  it("renders the capsule identity: shell, bar, one announced label, no glyph", () => {
    render(<MorphLoader label="Loading more…" />);

    const status = screen.getByRole("status");
    expect(status.textContent).toBe("Loading more…");
    // The label is announced, never drawn: the identity is the capsule itself.
    expect(status.querySelector(".sr-only")?.textContent).toBe("Loading more…");
    expect(status.querySelector("svg")).toBeNull();

    const shell = screen.getByTestId("morph-shell");
    expect(shell.className).toContain("bg-surface-container-high");
    expect(shell.className).toContain("rounded-full");
    // Token colors only — no hardcoded prototype green, no gradient.
    expect(shell.className).not.toMatch(/#|rgb|gradient/);

    const bar = screen.getByTestId("morph-bar");
    expect(bar.className).toContain("bg-on-surface-variant");
    expect(bar.className).toContain("fb-morph-bar");
    expect(bar.getAttribute("data-animated")).toBe("true");
  });

  it("shows the label as text only when a surface asks for a page-level wait", () => {
    render(<MorphLoader label="Preparing…" showLabel />);

    expect(screen.getByText("Preparing…").className).not.toContain("sr-only");
    expect(screen.queryByText("Preparing…", { selector: ".sr-only" })).toBeNull();
  });

  it("holds the bar still when the persisted Reduce override is on", () => {
    // The OS is fine with motion here; the in-app decision must still win.
    saveAppearance({ ...DEFAULT_APPEARANCE, reduceMotion: "reduce" });

    render(<MorphLoader label="Loading posts" />);

    const bar = screen.getByTestId("morph-bar");
    expect(bar.getAttribute("data-animated")).toBe("false");
    expect(bar.className).not.toContain("fb-morph-bar");
    // Static centered bar: no travel, no morph, no keyframe.
    expect(bar.style.width).toBe("45%");
    expect(screen.getByTestId("morph-loader").getAttribute("data-animated")).toBe("false");
  });

  it("holds the bar still when the OS asks for reduced motion", () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockReturnValue({
      matches: true,
      media: "(prefers-reduced-motion: reduce)",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    }) as unknown as typeof window.matchMedia;
    try {
      render(<MorphLoader label="Loading posts" />);

      const bar = screen.getByTestId("morph-bar");
      expect(bar.getAttribute("data-animated")).toBe("false");
      expect(bar.className).not.toContain("fb-morph-bar");
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it("keeps the compact geometry for the pagination slot", () => {
    render(<MorphLoader label="Loading more…" size="sm" />);
    const shell = screen.getByTestId("morph-shell");
    expect(shell.className).toContain("h-6");
    expect(shell.className).toContain("w-16");
  });
});

describe("Morph loader CSS contract (index.css)", () => {
  const css = readFileSync("src/index.css", "utf8");

  it("defines the morph keyframe and applies it from .fb-morph-bar", () => {
    expect(css).toContain("@keyframes fb-morph-bar");
    expect(css).toMatch(/\.fb-morph-bar\s*\{[^}]*animation:\s*fb-morph-bar/);
  });

  it("kills the morph for both the OS setting and the app override", () => {
    // Same dual kill-switch discipline as the loading washes: the media query
    // covers the first paint (before JS), the class covers the saved override.
    const overrideMedia = css.slice(css.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
    expect(overrideMedia).toMatch(/\.fb-morph-bar\s*\{[^}]*animation:\s*none/);
    expect(css).toMatch(/html\.fb-reduce-motion \.fb-morph-bar\s*\{[^}]*animation:\s*none/);
  });

  it("keeps the morph to width and translate only", () => {
    const start = css.indexOf("@keyframes fb-morph-bar");
    const keyframes = css.slice(start, start + 400);
    // No blur, gradient, filter or shadow in the loader — it stays cheap.
    expect(keyframes).not.toMatch(/blur|gradient|filter|box-shadow/);
    expect(keyframes).toMatch(/width:/);
    expect(keyframes).toMatch(/translateX/);
  });
});
