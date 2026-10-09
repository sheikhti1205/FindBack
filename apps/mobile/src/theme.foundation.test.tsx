// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_THEME_SETTING,
  THEME_STORAGE_KEY,
  ThemeProvider,
  applyTheme,
  bootstrapAppearance,
  loadThemeSetting,
  migrateTheme,
  resolveTheme,
  useTheme,
} from "./theme";
import { DEFAULT_APPEARANCE, saveAppearance } from "./appearance";

function Controls() {
  const { theme, trueBlackDark, setTheme, setTrueBlackDark } = useTheme();
  return <>
    <output>{theme}</output>
    <span data-testid="true-black">{String(trueBlackDark)}</span>
    {(["system", "light", "dark"] as const).map((value) =>
      <button key={value} onClick={() => setTheme(value)}>{value}</button>)}
    <button onClick={() => setTrueBlackDark(!trueBlackDark)}>toggle-true-black</button>
  </>;
}

afterEach(() => {
  cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear();
  document.documentElement.className = "";
  for (const key of ["theme", "trueBlack"]) delete document.documentElement.dataset[key];
});

describe("theme migration (pure migrateTheme)", () => {
  it.each([
    ["amoled", { theme: "dark", trueBlackDark: true }],
    ["dark", { theme: "dark", trueBlackDark: false }],
    ["light", { theme: "light", trueBlackDark: false }],
    ["system", { theme: "system", trueBlackDark: false }],
  ] as const)("maps legacy %s -> %o, preserving the user's choice", (legacy, expected) => {
    expect(migrateTheme(legacy)).toEqual(expected);
  });

  it("accepts the stable object shape and keeps both fields", () => {
    expect(migrateTheme({ theme: "dark", trueBlackDark: true })).toEqual({ theme: "dark", trueBlackDark: true });
    expect(migrateTheme({ theme: "light", trueBlackDark: true })).toEqual({ theme: "light", trueBlackDark: true });
    expect(migrateTheme({ theme: "system", trueBlackDark: false })).toEqual({ theme: "system", trueBlackDark: false });
  });

  it("falls back to defaults for invalid or missing payloads", () => {
    for (const bad of [undefined, null, 42, "nope", [], {}, { theme: "amoled" }, { trueBlackDark: "yes" }]) {
      expect(migrateTheme(bad)).toEqual(DEFAULT_THEME_SETTING);
    }
  });

  it("is idempotent: re-migrating an already-migrated value is stable", () => {
    for (const legacy of ["amoled", "dark", "light", "system"] as const) {
      const once = migrateTheme(legacy);
      expect(migrateTheme(once)).toEqual(once);
    }
  });
});

describe("resolveTheme matrix (theme x OS x trueBlack)", () => {
  it.each([
    ["light", true, false, "light"],
    ["light", true, true, "light"],
    ["light", false, false, "light"],
    ["dark", false, false, "dark"],
    ["dark", false, true, "amoled"],
    ["dark", true, false, "dark"],
    ["dark", true, true, "amoled"],
    ["system", false, false, "light"],
    ["system", false, true, "light"],
    ["system", true, false, "dark"],
    ["system", true, true, "amoled"],
  ] as const)("%s + OSdark=%s + trueBlack=%s -> %s", (theme, osDark, trueBlack, expected) => {
    expect(resolveTheme(theme, osDark, trueBlack)).toBe(expected);
  });
});

describe("applyTheme class contract", () => {
  const root = () => document.documentElement;
  it("dark + trueBlack applies .dark and .amoled, never .light", () => {
    applyTheme({ theme: "dark", trueBlackDark: true }, false);
    expect(root().classList.contains("dark")).toBe(true);
    expect(root().classList.contains("amoled")).toBe(true);
    expect(root().classList.contains("light")).toBe(false);
    expect(root().dataset.theme).toBe("dark");
  });
  it("dark + false applies .dark only", () => {
    applyTheme({ theme: "dark", trueBlackDark: false }, false);
    expect(root().classList.contains("dark")).toBe(true);
    expect(root().classList.contains("amoled")).toBe(false);
  });
  it("light stays light and ignores trueBlack", () => {
    applyTheme({ theme: "light", trueBlackDark: true }, true);
    expect(root().classList.contains("light")).toBe(true);
    expect(root().classList.contains("dark")).toBe(false);
    expect(root().classList.contains("amoled")).toBe(false);
  });
  it("system + OS dark + trueBlack resolves to true black", () => {
    applyTheme({ theme: "system", trueBlackDark: true }, true);
    expect(root().classList.contains("dark")).toBe(true);
    expect(root().classList.contains("amoled")).toBe(true);
  });
});

describe("consumer theme foundation", () => {
  it("bootstraps persisted legacy AMOLED as dark + true-black synchronously before a React mount", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "amoled");
    saveAppearance({ ...DEFAULT_APPEARANCE, accent: "violet" });
    bootstrapAppearance();
    expect(document.documentElement.classList.contains("amoled")).toBe(true);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.dataset.accent).toBe("violet");
    expect(document.documentElement.style.getPropertyValue("--fb-primary-dark")).toBe("#cfbdff");
  });

  it.each([
    ["amoled", "dark", true],
    ["dark", "dark", false],
    ["light", "light", false],
    ["system", "system", false],
  ] as const)("preserves persisted legacy %s through migration as %s / trueBlack=%s", (legacy, theme, trueBlack) => {
    localStorage.setItem(THEME_STORAGE_KEY, legacy);
    render(<ThemeProvider><Controls /></ThemeProvider>);
    expect(screen.getByRole("status").textContent).toBe(theme);
    expect(screen.getByTestId("true-black").textContent).toBe(String(trueBlack));
  });

  it("writes the stable object format and reloads it idempotently", () => {
    render(<ThemeProvider><Controls /></ThemeProvider>);
    act(() => screen.getByRole("button", { name: "dark" }).click());
    act(() => screen.getByRole("button", { name: "toggle-true-black" }).click());
    expect(JSON.parse(localStorage.getItem(THEME_STORAGE_KEY)!)).toEqual({ theme: "dark", trueBlackDark: true });
    expect(loadThemeSetting()).toEqual({ theme: "dark", trueBlackDark: true });
    expect(document.documentElement.classList.contains("amoled")).toBe(true);
  });

  it("selecting Dark alone does not force AMOLED", () => {
    render(<ThemeProvider><Controls /></ThemeProvider>);
    act(() => screen.getByRole("button", { name: "dark" }).click());
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.classList.contains("amoled")).toBe(false);
  });

  it("turning true-black off returns migrated AMOLED to normal dark", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "amoled");
    render(<ThemeProvider><Controls /></ThemeProvider>);
    expect(document.documentElement.classList.contains("amoled")).toBe(true);
    act(() => screen.getByRole("button", { name: "toggle-true-black" }).click());
    expect(document.documentElement.classList.contains("amoled")).toBe(false);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
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

  it("System + trueBlack follows the OS into true black", () => {
    localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify({ theme: "system", trueBlackDark: true }));
    let dark = false;
    const listeners = new Set<() => void>();
    vi.stubGlobal("matchMedia", (query: string) => ({
      get matches() { return query.includes("color-scheme") && dark; },
      addEventListener: (_: string, cb: () => void) => listeners.add(cb),
      removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
    }));
    render(<ThemeProvider><Controls /></ThemeProvider>);
    expect(document.documentElement.classList.contains("light")).toBe(true);
    act(() => { dark = true; for (const cb of listeners) cb(); });
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.classList.contains("amoled")).toBe(true);
  });

  it("syncs a legacy theme change from another tab through migration", () => {
    render(<ThemeProvider><Controls /></ThemeProvider>);
    localStorage.setItem(THEME_STORAGE_KEY, "amoled");
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: THEME_STORAGE_KEY })));
    expect(screen.getByRole("status").textContent).toBe("dark");
    expect(screen.getByTestId("true-black").textContent).toBe("true");
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
    localStorage.setItem(THEME_STORAGE_KEY, "invalid");
    render(<ThemeProvider><Controls /></ThemeProvider>);
    expect(screen.getByRole("status").textContent).toBe("system");
    cleanup();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    render(<ThemeProvider><Controls /></ThemeProvider>);
    act(() => screen.getByRole("button", { name: "dark" }).click());
    act(() => screen.getByRole("button", { name: "toggle-true-black" }).click());
    expect(document.documentElement.classList.contains("amoled")).toBe(true);
  });
});
