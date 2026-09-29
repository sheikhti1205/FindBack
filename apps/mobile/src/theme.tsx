import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import {
  APPEARANCE_EVENT,
  applyAppearance,
  loadAppearance,
} from "./appearance";

export type Theme = "light" | "dark" | "system";

interface ThemeContextValue {
  theme: Theme;
  setTheme: (t: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: "system",
  setTheme: () => undefined,
});

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const stored = localStorage.getItem("findback.theme") as Theme | null;
      return stored === "light" || stored === "dark" || stored === "system"
        ? stored
        : "system";
    } catch {
      return "system";
    }
  });

  useEffect(() => {
    // AI-011: apply persisted Quick Appearance (accent vars, root text
    // scale, reduce-motion markers) once at startup; AppearancePanel
    // re-applies on every change and notifies via APPEARANCE_EVENT.
    applyAppearance(loadAppearance());
    const syncAppearance = () => applyAppearance(loadAppearance());
    window.addEventListener(APPEARANCE_EVENT, syncAppearance);
    window.addEventListener("storage", syncAppearance);
    return () => {
      window.removeEventListener(APPEARANCE_EVENT, syncAppearance);
      window.removeEventListener("storage", syncAppearance);
    };
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove("light", "dark");
    if (theme === "light") root.classList.add("light");
    else if (theme === "dark") root.classList.add("dark");
    try {
      localStorage.setItem("findback.theme", theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}
