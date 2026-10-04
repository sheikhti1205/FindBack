// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccessibilitySettings } from "./AccessibilitySettings";
import { ThemeProvider } from "../theme";
import { loadAppearance } from "../appearance";

function renderScreen() {
  return render(
    <MemoryRouter>
      <ThemeProvider>
        <AccessibilitySettings />
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

describe("AccessibilitySettings", () => {
  it("renders one heading, four text-size options, and three motion options", () => {
    renderScreen();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "Accessibility" })).toBeTruthy();
    for (const name of ["Small", "Default", "Large", "Extra large"]) {
      expect(screen.getByRole("radio", { name: new RegExp(`^${name}`) })).toBeTruthy();
    }
    for (const name of ["Follow system", "Reduce", "Full"]) {
      expect(screen.getByRole("radio", { name: new RegExp(`^${name}`) })).toBeTruthy();
    }
  });

  it("text-size choice updates the shared store and scales the root immediately", () => {
    renderScreen();
    act(() => { screen.getByRole("radio", { name: /^Large/ }).click(); });
    expect(loadAppearance().textScale).toBe("large");
    expect(document.documentElement.style.fontSize).toBe("112.5%");
  });

  it("motion choice updates the shared store and the motion marker immediately", () => {
    renderScreen();
    act(() => { screen.getByRole("radio", { name: /^Reduce/ }).click(); });
    expect(loadAppearance().reduceMotion).toBe("reduce");
    expect(document.documentElement.classList.contains("fb-reduce-motion")).toBe(true);
  });

  it("sample preview reflects both the text size and the motion choice", () => {
    renderScreen();
    const preview = screen.getByRole("region", { name: /sample preview/i });
    expect(preview.textContent).toMatch(/default/i);
    act(() => { screen.getByRole("radio", { name: /^Extra large/ }).click(); });
    act(() => { screen.getByRole("radio", { name: /^Full/ }).click(); });
    const updated = screen.getByRole("region", { name: /sample preview/i });
    expect(updated.textContent).toMatch(/extra large/i);
    expect(updated.textContent).toMatch(/full/i);
  });
});
