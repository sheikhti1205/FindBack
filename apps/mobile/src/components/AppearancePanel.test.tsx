// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AppearancePanel } from "./AppearancePanel";
import { ThemeProvider } from "../theme";
import { APPEARANCE_STORAGE_KEY, DEFAULT_APPEARANCE } from "../appearance";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function renderPanel() {
  render(
    <ThemeProvider>
      <AppearancePanel />
    </ThemeProvider>,
  );
}

function persisted(): Record<string, unknown> {
  const raw = localStorage.getItem(APPEARANCE_STORAGE_KEY);
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

describe("AppearancePanel (AI-011 Quick Appearance)", () => {
  it("renders Light/Dark/System theme preview cards that persist immediately", () => {
    renderPanel();
    const group = screen.getByRole("radiogroup", { name: "Theme" });
    for (const name of ["Light", "Dark", "System"]) {
      expect(within(group).getByRole("radio", { name: new RegExp(name) })).toBeTruthy();
    }
    const dark = within(group).getByRole("radio", { name: /Dark/ });
    fireEvent.click(dark);
    expect(dark.getAttribute("aria-checked")).toBe("true");
    expect(localStorage.getItem("findback.theme")).toBe("dark");
    // The shared sliding selection indicator follows the chosen card.
    expect(dark.querySelector('[data-testid="segmented-selection"]')).toBeTruthy();
  });

  it("offers a curated accent set that applies its CSS var immediately", () => {
    renderPanel();
    const group = screen.getByRole("radiogroup", { name: "Accent color" });
    const radios = within(group).getAllByRole("radio");
    expect(radios.length).toBeGreaterThanOrEqual(4);
    fireEvent.click(radios[1]!);
    expect(radios[1]!.getAttribute("aria-checked")).toBe("true");
    expect(document.documentElement.style.getPropertyValue("--fb-accent").trim().length).toBeGreaterThan(0);
    expect(persisted().accent).toBeTruthy();
  });

  it("scales root text size immediately with no Save step", () => {
    renderPanel();
    const group = screen.getByRole("radiogroup", { name: "Text size" });
    const large = within(group).getByRole("radio", { name: "Large" });
    fireEvent.click(large);
    expect(large.getAttribute("aria-checked")).toBe("true");
    expect(persisted().textScale).toBe("large");
    expect(document.documentElement.style.fontSize).toBe("112.5%");
  });

  it("layers the reduce-motion override on the OS setting", () => {
    renderPanel();
    const group = screen.getByRole("radiogroup", { name: "Reduce motion" });
    const reduce = within(group).getByRole("radio", { name: "Reduce" });
    fireEvent.click(reduce);
    expect(reduce.getAttribute("aria-checked")).toBe("true");
    expect(persisted().reduceMotion).toBe("reduce");
    expect(document.documentElement.classList.contains("fb-reduce-motion")).toBe(true);
  });

  it("persists the High Quality Photo flag for the image pipeline", () => {
    renderPanel();
    const toggle = screen.getByRole("switch", { name: /High quality photo/ });
    expect(toggle.getAttribute("aria-checked")).toBe(
      String(DEFAULT_APPEARANCE.highQualityPhoto),
    );
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(persisted().highQualityPhoto).toBe(true);
  });

  it("applies every change immediately — no Save button exists", () => {
    renderPanel();
    expect(screen.queryByRole("button", { name: /save/i })).toBeNull();
  });

  it("collapses and expands with an aria-expanded toggle", () => {
    renderPanel();
    const toggle = screen.getByRole("button", { name: /Quick Appearance/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("radiogroup", { name: "Theme" })).toBeTruthy();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("radiogroup", { name: "Theme" })).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByRole("radiogroup", { name: "Theme" })).toBeTruthy();
  });
});
