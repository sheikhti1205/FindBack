// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
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
  for (const key of ["theme", "accent", "reduceMotionOverride"]) delete root.dataset[key];
});

describe("AppearanceSettings", () => {
  it("renders one heading, four theme options, and seven accent options as native radios", () => {
    renderScreen();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "Appearance" })).toBeTruthy();
    for (const name of ["System", "Light", "Dark", "AMOLED"]) {
      expect(screen.getByRole("radio", { name: new RegExp(`^${name}`) })).toBeTruthy();
    }
    for (const name of ["Emerald", "Blue", "Violet", "Rose", "Amber", "Teal", "Mono"]) {
      expect(screen.getByRole("radio", { name })).toBeTruthy();
    }
  });

  it("theme selection applies and persists immediately with no save step", () => {
    renderScreen();
    act(() => { screen.getByRole("radio", { name: /^Dark/ }).click(); });
    expect(localStorage.getItem("findback.theme")).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
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
    act(() => { screen.getByRole("radio", { name: /^AMOLED/ }).click(); });
    act(() => { screen.getByRole("radio", { name: "Teal" }).click(); });
    expect(screen.getByRole("img", { name: /preview/i }).getAttribute("aria-label")).toMatch(/amoled/i);
    expect(screen.getByRole("img", { name: /preview/i }).getAttribute("aria-label")).toMatch(/teal/i);
  });
});
