import {
  createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState,
  type ReactNode,
} from "react";
import { APPEARANCE_EVENT, APPEARANCE_STORAGE_KEY, applyAppearance, loadAppearance, migrateAppearance } from "./appearance";

export type Theme = "light" | "dark" | "system" | "amoled";
export const THEME_STORAGE_KEY = "findback.theme";

export function loadTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return stored === "light" || stored === "dark" || stored === "amoled" ? stored : "system";
  } catch { return "system"; }
}

export function resolveTheme(theme: Theme, osDark: boolean): "light" | "dark" | "amoled" {
  return theme === "system" ? (osDark ? "dark" : "light") : theme;
}

function osIsDark(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)").matches : false;
}

/** AMOLED also retains .dark for existing dark selectors, never vice versa. */
export function applyTheme(theme: Theme, osDark = osIsDark()): void {
  if (typeof document === "undefined") return;
  const resolved = resolveTheme(theme, osDark);
  const root = document.documentElement;
  root.classList.toggle("light", resolved === "light");
  root.classList.toggle("dark", resolved !== "light");
  root.classList.toggle("amoled", resolved === "amoled");
  root.dataset.theme = theme;
}

/** Synchronous module bootstrap: persisted preferences apply before React mounts. */
export function bootstrapAppearance(): void {
  applyTheme(loadTheme());
  applyAppearance(loadAppearance());
}
bootstrapAppearance();

export interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}
const ThemeContext = createContext<ThemeContextValue>({ theme: "system", setTheme: () => undefined });

export function useTheme(): ThemeContextValue { return useContext(ThemeContext); }

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, updateTheme] = useState<Theme>(loadTheme);
  const appearance = useRef(loadAppearance());
  const setTheme = useCallback((next: Theme) => {
    applyTheme(next);
    updateTheme(next);
    try { localStorage.setItem(THEME_STORAGE_KEY, next); } catch { /* local-only session */ }
  }, []);

  useLayoutEffect(() => { applyTheme(theme); }, [theme]);

  useEffect(() => {
    applyAppearance(appearance.current);
    const syncAppearance = (event: Event) => {
      appearance.current = event instanceof CustomEvent && event.detail
        ? migrateAppearance(event.detail) : loadAppearance();
      applyAppearance(appearance.current);
    };
    const syncStorage = (event: StorageEvent) => {
      if (event.key === THEME_STORAGE_KEY || event.key === null) {
        const next = loadTheme();
        applyTheme(next);
        updateTheme(next);
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
    const sync = () => applyTheme(theme, color.matches);
    color.addEventListener("change", sync);
    return () => color.removeEventListener("change", sync);
  }, [theme]);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => applyAppearance(appearance.current);
    motion.addEventListener("change", sync);
    return () => motion.removeEventListener("change", sync);
  }, []);

  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>;
}
