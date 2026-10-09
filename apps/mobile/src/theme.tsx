import {
  createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState,
  type ReactNode,
} from "react";
import { APPEARANCE_EVENT, APPEARANCE_STORAGE_KEY, applyAppearance, loadAppearance, migrateAppearance } from "./appearance";

export type Theme = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark" | "amoled";

/** Top-level theme choice plus the independent true-black (AMOLED) modifier. */
export interface ThemeSetting {
  theme: Theme;
  trueBlackDark: boolean;
}

export const THEME_STORAGE_KEY = "findback.theme";
export const DEFAULT_THEME_SETTING: ThemeSetting = { theme: "system", trueBlackDark: false };

function isTheme(value: unknown): value is Theme {
  return value === "system" || value === "light" || value === "dark";
}

/**
 * Pure migration at the persistence boundary. Legacy single-string values keep
 * the user's choice: `amoled` becomes dark + true-black, `dark` becomes dark +
 * false, and `light`/`system` are preserved. The new object payload round-trips
 * unchanged, so re-loading the stored value is idempotent.
 */
export function migrateTheme(value: unknown): ThemeSetting {
  if (value === "amoled") return { theme: "dark", trueBlackDark: true };
  if (value === "dark") return { theme: "dark", trueBlackDark: false };
  if (value === "light") return { theme: "light", trueBlackDark: false };
  if (value === "system") return { theme: "system", trueBlackDark: false };
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const parsed = value as Partial<ThemeSetting>;
    return {
      theme: isTheme(parsed.theme) ? parsed.theme : DEFAULT_THEME_SETTING.theme,
      trueBlackDark: typeof parsed.trueBlackDark === "boolean"
        ? parsed.trueBlackDark
        : DEFAULT_THEME_SETTING.trueBlackDark,
    };
  }
  return { ...DEFAULT_THEME_SETTING };
}

export function loadThemeSetting(): ThemeSetting {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_THEME_SETTING };
    return migrateTheme(raw.startsWith("{") ? JSON.parse(raw) : raw);
  } catch { return { ...DEFAULT_THEME_SETTING }; }
}

function osIsDark(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)").matches : false;
}

/**
 * Resolve the preference against the OS and the true-black modifier. True-black
 * only ever produces `.amoled` when the resolved mode is dark; a light
 * resolution stays light regardless of `trueBlackDark`.
 */
export function resolveTheme(theme: Theme, osDark: boolean, trueBlackDark = false): ResolvedTheme {
  const mode: "light" | "dark" = theme === "light" ? "light" : theme === "dark" ? "dark" : (osDark ? "dark" : "light");
  return mode === "dark" && trueBlackDark ? "amoled" : mode;
}

/**
 * `.dark` covers both normal dark and true black; `.amoled` only ever layers on
 * top of a resolved dark mode. `.light` stays mutually exclusive.
 */
export function applyTheme(setting: ThemeSetting, osDark = osIsDark()): void {
  if (typeof document === "undefined") return;
  const resolved = resolveTheme(setting.theme, osDark, setting.trueBlackDark);
  const root = document.documentElement;
  root.classList.toggle("light", resolved === "light");
  root.classList.toggle("dark", resolved !== "light");
  root.classList.toggle("amoled", resolved === "amoled");
  root.dataset.theme = setting.theme;
  root.dataset.trueBlack = setting.trueBlackDark ? "true" : "false";
}

/** Synchronous module bootstrap: persisted preferences apply before React mounts. */
export function bootstrapAppearance(): void {
  applyTheme(loadThemeSetting());
  applyAppearance(loadAppearance());
}
bootstrapAppearance();

export interface ThemeContextValue {
  theme: Theme;
  trueBlackDark: boolean;
  setTheme: (theme: Theme) => void;
  setTrueBlackDark: (trueBlackDark: boolean) => void;
}
const ThemeContext = createContext<ThemeContextValue>({
  theme: "system",
  trueBlackDark: false,
  setTheme: () => undefined,
  setTrueBlackDark: () => undefined,
});

export function useTheme(): ThemeContextValue { return useContext(ThemeContext); }

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [setting, updateSetting] = useState<ThemeSetting>(loadThemeSetting);
  const current = useRef(setting);
  const appearance = useRef(loadAppearance());

  const persist = useCallback((next: ThemeSetting) => {
    current.current = next;
    applyTheme(next);
    updateSetting(next);
    try { localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(next)); } catch { /* local-only session */ }
  }, []);

  const setTheme = useCallback((theme: Theme) => persist({ ...current.current, theme }), [persist]);
  const setTrueBlackDark = useCallback((trueBlackDark: boolean) => persist({ ...current.current, trueBlackDark }), [persist]);

  useLayoutEffect(() => { current.current = setting; applyTheme(setting); }, [setting]);

  useEffect(() => {
    applyAppearance(appearance.current);
    const syncAppearance = (event: Event) => {
      appearance.current = event instanceof CustomEvent && event.detail
        ? migrateAppearance(event.detail) : loadAppearance();
      applyAppearance(appearance.current);
    };
    const syncStorage = (event: StorageEvent) => {
      if (event.key === THEME_STORAGE_KEY || event.key === null) {
        const next = loadThemeSetting();
        current.current = next;
        applyTheme(next);
        updateSetting(next);
      }
      if (event.key === APPEARANCE_STORAGE_KEY || event.key === null) syncAppearance(event);
    };
    window.addEventListener(APPEARANCE_EVENT, syncAppearance);
    window.addEventListener("storage", syncStorage);
    return () => {
      window.removeEventListener(APPEARANCE_EVENT, syncAppearance);
      window.removeEventListener("storage", syncStorage);
    };
  }, []);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const color = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = () => applyTheme(current.current, color.matches);
    color.addEventListener("change", sync);
    return () => color.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => applyAppearance(appearance.current);
    motion.addEventListener("change", sync);
    return () => motion.removeEventListener("change", sync);
  }, []);

  return <ThemeContext.Provider value={{
    theme: setting.theme,
    trueBlackDark: setting.trueBlackDark,
    setTheme,
    setTrueBlackDark,
  }}>{children}</ThemeContext.Provider>;
}
