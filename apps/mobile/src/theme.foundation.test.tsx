// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootstrapAppearance, ThemeProvider, useTheme } from "./theme";
import { DEFAULT_APPEARANCE, saveAppearance } from "./appearance";

function Controls() {
  const { theme, setTheme } = useTheme();
  return <><output>{theme}</output>{(["system", "light", "dark", "amoled"] as const).map((value) =>
    <button key={value} onClick={() => setTheme(value)}>{value}</button>)}</>;
}

afterEach(() => {
  cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear();
  document.documentElement.className = "";
});

describe("consumer theme foundation", () => {
  it("bootstraps persisted AMOLED and accent synchronously before a React mount", () => {
    localStorage.setItem("findback.theme", "amoled");
    saveAppearance({ ...DEFAULT_APPEARANCE, accent: "violet" });
    bootstrapAppearance();
    expect(document.documentElement.classList.contains("amoled")).toBe(true);
    expect(document.documentElement.dataset.accent).toBe("violet");
    expect(document.documentElement.style.getPropertyValue("--fb-primary-dark")).toBe("#cfbdff");
  });
  it.each(["system", "light", "dark", "amoled"])("preserves persisted %s", (value) => {
    localStorage.setItem("findback.theme", value);
    render(<ThemeProvider><Controls /></ThemeProvider>);
    expect(screen.getByRole("status").textContent).toBe(value);
    if (value === "amoled") {
      expect(document.documentElement.classList.contains("amoled")).toBe(true);
      expect(document.documentElement.classList.contains("dark")).toBe(true);
    }
  });

  it("removes AMOLED when switching to another mode and retains storage key", () => {
    render(<ThemeProvider><Controls /></ThemeProvider>);
    act(() => screen.getByRole("button", { name: "amoled" }).click());
    expect(localStorage.getItem("findback.theme")).toBe("amoled");
    act(() => screen.getByRole("button", { name: "light" }).click());
    expect(document.documentElement.classList.contains("amoled")).toBe(false);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.documentElement.classList.contains("light")).toBe(true);
  });

  it("System follows live OS changes without opting into AMOLED", () => {
    let dark = false;
    const listeners = new Set<() => void>();
    vi.stubGlobal("matchMedia", (query: string) => ({
      get matches() { return query.includes("color-scheme") && dark; },
      addEventListener: (_: string, cb: () => void) => listeners.add(cb),
      removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
    }));
    const view = render(<ThemeProvider><Controls /></ThemeProvider>);
    expect(document.documentElement.classList.contains("light")).toBe(true);
    act(() => { dark = true; for (const cb of listeners) cb(); });
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.classList.contains("amoled")).toBe(false);
    view.unmount();
    expect(listeners.size).toBe(0);
  });

  it("syncs theme changes from another tab", () => {
    render(<ThemeProvider><Controls /></ThemeProvider>);
    localStorage.setItem("findback.theme", "amoled");
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: "findback.theme" })));
    expect(screen.getByRole("status").textContent).toBe("amoled");
    expect(document.documentElement.classList.contains("amoled")).toBe(true);
  });

  it("keeps the CSS motion marker in sync with OS changes, preserving a blocked-storage live accent", () => {
    let reduced = false;
    const listeners = new Set<() => void>();
    vi.stubGlobal("matchMedia", (query: string) => ({
      get matches() { return query.includes("reduced-motion") && reduced; },
      addEventListener: (_: string, cb: () => void) => { if (query.includes("reduced-motion")) listeners.add(cb); },
      removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
    }));
    render(<ThemeProvider><Controls /></ThemeProvider>);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    act(() => saveAppearance({ ...DEFAULT_APPEARANCE, accent: "blue" }));
    act(() => { reduced = true; for (const cb of listeners) cb(); });
    expect(document.documentElement.classList.contains("fb-reduce-motion")).toBe(true);
    expect(document.documentElement.dataset.accent).toBe("blue");
  });

  it("falls back safely with invalid or unavailable storage", () => {
    localStorage.setItem("findback.theme", "invalid");
    render(<ThemeProvider><Controls /></ThemeProvider>);
    expect(screen.getByRole("status").textContent).toBe("system");
    cleanup();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    render(<ThemeProvider><Controls /></ThemeProvider>);
    act(() => screen.getByRole("button", { name: "amoled" }).click());
    expect(document.documentElement.classList.contains("amoled")).toBe(true);
  });
});
