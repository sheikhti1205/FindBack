// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppearanceSettings } from "./AppearanceSettings";
import { ThemeProvider } from "../theme";
import { APPEARANCE_STORAGE_KEY } from "../appearance";

function renderScreen() {
  return render(
    <MemoryRouter>
      <ThemeProvider>
        <AppearanceSettings />
      </ThemeProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  const root = document.documentElement;
  root.removeAttribute("style");
  root.className = "";
  for (const key of ["theme", "trueBlack", "accent", "reduceMotionOverride"]) delete root.dataset[key];
});

describe("AppearanceSettings", () => {
  it("renders one heading, three theme options, and seven accent options as native radios", () => {
    renderScreen();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "Appearance" })).toBeTruthy();
    for (const name of ["System", "Light", "Dark"]) {
      expect(screen.getByRole("radio", { name: new RegExp(`^${name}`) })).toBeTruthy();
    }
    expect(screen.queryByRole("radio", { name: /^AMOLED/ })).toBeNull();
    for (const name of ["Emerald", "Blue", "Violet", "Rose", "Amber", "Teal", "Mono"]) {
      expect(screen.getByRole("radio", { name })).toBeTruthy();
    }
  });

  it("theme selection applies and persists immediately in the stable object format", () => {
    renderScreen();
    act(() => { screen.getByRole("radio", { name: /^Dark/ }).click(); });
    expect(JSON.parse(localStorage.getItem("findback.theme")!)).toEqual({ theme: "dark", trueBlackDark: false });
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.classList.contains("amoled")).toBe(false);
  });

  it("selecting Dark alone does not force true black", () => {
    renderScreen();
    act(() => { screen.getByRole("radio", { name: /^Dark/ }).click(); });
    expect(screen.getByRole("switch", { name: /true black/i }).getAttribute("aria-checked")).toBe("false");
    expect(document.documentElement.classList.contains("amoled")).toBe(false);
  });

  it("shows the true-black toggle for Dark and System, hides it for Light", () => {
    renderScreen();
    expect(screen.queryByRole("switch", { name: /true black/i })).toBeTruthy();
    act(() => { screen.getByRole("radio", { name: /^Light/ }).click(); });
    expect(screen.queryByRole("switch", { name: /true black/i })).toBeNull();
    act(() => { screen.getByRole("radio", { name: /^Dark/ }).click(); });
    expect(screen.queryByRole("switch", { name: /true black/i })).toBeTruthy();
  });

  it("true-black toggle persists and applies AMOLED while keeping dark", () => {
    localStorage.setItem("findback.theme", "dark");
    renderScreen();
    act(() => { screen.getByRole("switch", { name: /true black/i }).click(); });
    expect(JSON.parse(localStorage.getItem("findback.theme")!)).toEqual({ theme: "dark", trueBlackDark: true });
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.classList.contains("amoled")).toBe(true);
  });

  it("accent selection applies and persists immediately with no save step", () => {
    renderScreen();
    act(() => { screen.getByRole("radio", { name: "Violet" }).click(); });
    const stored = JSON.parse(localStorage.getItem(APPEARANCE_STORAGE_KEY) ?? "{}");
    expect(stored.accent).toBe("violet");
    expect(document.documentElement.dataset.accent).toBe("violet");
  });

  it("live preview reflects the current theme and accent selection", () => {
    renderScreen();
    const preview = screen.getByRole("img", { name: /preview/i });
    expect(preview.getAttribute("aria-label")).toMatch(/system/i);
    act(() => { screen.getByRole("radio", { name: /^Dark/ }).click(); });
    act(() => { screen.getByRole("radio", { name: "Teal" }).click(); });
    expect(screen.getByRole("img", { name: /preview/i }).getAttribute("aria-label")).toMatch(/dark/i);
    expect(screen.getByRole("img", { name: /preview/i }).getAttribute("aria-label")).toMatch(/teal/i);
  });

  it("scopes the accent copy: selections only, semantics keep their own meaning", () => {
    renderScreen();
    const group = screen.getByText(/status colors, reactions, and mention links/i);
    expect(group.textContent).toMatch(/never follow the accent/i);
  });

  it("binds the preview Found chip to functional tokens, never the accent container", () => {
    const css = readFileSync("src/screens/AppearanceSettings.css", "utf8");
    const rule = css.slice(css.indexOf(".fb-appearance-preview-chip {")).split("}")[0]!;
    expect(rule).toContain("var(--fb-found-bg)");
    expect(rule).toContain("var(--fb-found-ink)");
    expect(rule).not.toContain("--fb-primary-container");
  });
});
