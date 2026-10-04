// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MediaSettings } from "./MediaSettings";
import { ThemeProvider } from "../theme";
import {
  PHOTO_QUALITY_HIGH,
  PHOTO_QUALITY_STANDARD,
  currentPhotoQuality,
  loadAppearance,
} from "../appearance";

function renderScreen() {
  return render(
    <MemoryRouter>
      <ThemeProvider>
        <MediaSettings />
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

describe("MediaSettings", () => {
  it("renders one heading and a high-quality photo switch that toggles the real flag", () => {
    renderScreen();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: /media/i })).toBeTruthy();
    const control = screen.getByRole("switch", { name: /high quality/i });
    expect(control.getAttribute("aria-checked")).toBe("false");
    act(() => { control.click(); });
    expect(loadAppearance().highQualityPhoto).toBe(true);
    expect(currentPhotoQuality()).toEqual(PHOTO_QUALITY_HIGH);
    act(() => { screen.getByRole("switch", { name: /high quality/i }).click(); });
    expect(loadAppearance().highQualityPhoto).toBe(false);
    expect(currentPhotoQuality()).toEqual(PHOTO_QUALITY_STANDARD);
  });

  it("explains data and storage impact in plain words without technical numbers", () => {
    const view = renderScreen();
    const text = view.container.textContent ?? "";
    expect(text).toMatch(/data|storage/i);
    expect(text).not.toMatch(/\d+\.\d+/);
    expect(text).not.toMatch(/jpeg/i);
  });
});
