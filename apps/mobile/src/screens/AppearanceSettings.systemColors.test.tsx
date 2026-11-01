// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppearanceSettings } from "./AppearanceSettings";
import { ThemeProvider } from "../theme";
import { APPEARANCE_STORAGE_KEY, DEFAULT_APPEARANCE, accentTokensFor } from "../appearance";
import { getSystemColorsSnapshot, refreshSystemColors } from "../services/systemColors";

const bridge = vi.hoisted(() => ({ getColors: vi.fn(), addListener: vi.fn(), remove: vi.fn() }));
vi.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform: () => "android", isNativePlatform: () => true },
  registerPlugin: () => bridge,
}));
const palette = {
  supported: true,
  light: { primary: "#006a6a", onPrimary: "#ffffff", primaryContainer: "#ddf2f1", onPrimaryContainer: "#003838", link: "#003838" },
  dark: { primary: "#7bd8d8", onPrimary: "#003838", primaryContainer: "#153c3c", onPrimaryContainer: "#7bd8d8", link: "#7bd8d8" },
};
const primary = () => document.documentElement.style.getPropertyValue("--fb-primary-light");
const stored = () => JSON.parse(localStorage.getItem(APPEARANCE_STORAGE_KEY)!);
async function mount() {
  await act(async () => { render(<MemoryRouter><ThemeProvider><AppearanceSettings /></ThemeProvider></MemoryRouter>); });
}
beforeEach(async () => {
  vi.clearAllMocks(); localStorage.clear();
  bridge.getColors.mockResolvedValue({ supported: false });
  await refreshSystemColors();
  bridge.getColors.mockClear();
  bridge.getColors.mockResolvedValue(palette);
  bridge.addListener.mockResolvedValue({ remove: bridge.remove.mockResolvedValue(undefined) });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); document.documentElement.removeAttribute("style"); });

describe("actual System colors Settings and theme integration (synthetic bridge, not device proof)", () => {
  it("offers an opt-in switch on supported Android and preserves the last preset when disabled", async () => {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify({ ...DEFAULT_APPEARANCE, accent: "violet" }));
    await mount();
    const toggle = screen.getByRole("switch", { name: "System colors" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await act(async () => { toggle.click(); });
    expect(stored()).toMatchObject({ accent: "violet", accentSource: "system" });
    expect(primary()).toBe(palette.light.primary);
    expect((screen.getByRole("radio", { name: "Violet" }) as HTMLInputElement).checked).toBe(false);
    expect(screen.getByRole("img", { name: /preview/i }).getAttribute("aria-label")).toMatch(/system colors/i);
    await act(async () => { toggle.click(); });
    expect(primary()).toBe(accentTokensFor("violet", "light").primary);
    expect(stored()).toMatchObject({ accent: "violet", accentSource: "preset" });
    expect(localStorage.getItem(APPEARANCE_STORAGE_KEY)).not.toContain("#");
  });
  it("choosing any preset exits System colors immediately", async () => {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify({ ...DEFAULT_APPEARANCE, accentSource: "system" }));
    await mount();
    await act(async () => { screen.getByRole("radio", { name: "Teal" }).click(); });
    expect(stored()).toMatchObject({ accent: "teal", accentSource: "preset" });
    expect(screen.getByRole("switch", { name: "System colors" }).getAttribute("aria-checked")).toBe("false");
    expect(primary()).toBe(accentTokensFor("teal", "light").primary);
  });
  it("launch reads once; theme, true-black and native lifecycle changes refresh both palettes", async () => {
    let changed!: () => void;
    bridge.addListener.mockImplementation((_event, listener) => { changed = listener; return Promise.resolve({ remove: bridge.remove }); });
    localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify({ ...DEFAULT_APPEARANCE, accentSource: "system" }));
    await mount();
    expect(bridge.getColors).toHaveBeenCalledTimes(1);
    expect(primary()).toBe(palette.light.primary);
    await act(async () => { screen.getByRole("radio", { name: /^Dark/ }).click(); });
    expect(bridge.getColors).toHaveBeenCalledTimes(2);
    expect(document.documentElement.style.getPropertyValue("--fb-primary-dark")).toBe(palette.dark.primary);
    await act(async () => { screen.getByRole("switch", { name: /true black/i }).click(); });
    expect(bridge.getColors).toHaveBeenCalledTimes(3);
    expect(document.documentElement.classList.contains("amoled")).toBe(true);
    await act(async () => { changed(); });
    expect(bridge.getColors).toHaveBeenCalledTimes(4);
    const canonical = document.getElementById("findback-color-system")!.textContent;
    for (const key of ["--fb-found-bg", "--fb-lost-bg", "--fb-error", "--fb-mention", "--fb-reaction-love"]) {
      expect(document.documentElement.style.getPropertyValue(key)).toBe("");
    }
    expect(document.getElementById("findback-color-system")!.textContent).toBe(canonical);
    cleanup();
    await act(async () => { changed(); });
    expect(bridge.getColors).toHaveBeenCalledTimes(4);
    expect(bridge.remove).toHaveBeenCalledTimes(1);
  });
  it("a palette reply cannot override a preset chosen while the native read is pending", async () => {
    let resolve!: (data: unknown) => void;
    bridge.getColors.mockImplementation(() => new Promise(r => { resolve = r; }));
    localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify({ ...DEFAULT_APPEARANCE, accentSource: "system" }));
    await mount();
    expect(primary()).toBe(accentTokensFor("blue", "light").primary);
    await act(async () => { screen.getByRole("radio", { name: "Rose" }).click(); });
    await act(async () => { resolve(palette); });
    expect(primary()).toBe(accentTokensFor("rose", "light").primary);
    expect(stored().accentSource).toBe("preset");
  });
  it("old Android/unavailable bridge uses Blue and explains support without pretending wallpaper colors", async () => {
    bridge.getColors.mockResolvedValue({ supported: false });
    localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify({ ...DEFAULT_APPEARANCE, accent: "rose", accentSource: "system" }));
    await mount();
    expect(screen.queryByRole("switch", { name: "System colors" })).toBeNull();
    expect(screen.getByText(/system colors.*android 12/i)).toBeTruthy();
    expect(primary()).toBe(accentTokensFor("blue", "light").primary);
  });
  it("disposal fences an in-flight read and never reapplies colors after unmount", async () => {
    let resolve!: (data: unknown) => void;
    bridge.getColors.mockImplementation(() => new Promise(r => { resolve = r; }));
    await mount(); cleanup();
    const before = getSystemColorsSnapshot();
    document.documentElement.style.setProperty("--fb-primary-light", "#123456");
    await act(async () => { resolve(palette); });
    expect(getSystemColorsSnapshot()).toBe(before);
    expect(primary()).toBe("#123456");
  });
  it("OS theme changes refresh native roles and remove the OS listener on disposal", async () => {
    let dark = false;
    const listeners = new Set<() => void>();
    vi.stubGlobal("matchMedia", (query: string) => ({
      get matches() { return query.includes("color-scheme") && dark; },
      addEventListener: (_event: string, listener: () => void) => { if (query.includes("color-scheme")) listeners.add(listener); },
      removeEventListener: (_event: string, listener: () => void) => listeners.delete(listener),
    }));
    localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify({ ...DEFAULT_APPEARANCE, accentSource: "system" }));
    await mount();
    expect(bridge.getColors).toHaveBeenCalledTimes(1);
    expect(document.documentElement.classList.contains("light")).toBe(true);
    await act(async () => { dark = true; for (const changed of listeners) changed(); });
    expect(bridge.getColors).toHaveBeenCalledTimes(2);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.style.getPropertyValue("--fb-primary-dark")).toBe(palette.dark.primary);
    cleanup();
    expect(listeners.size).toBe(0);
  });
});
