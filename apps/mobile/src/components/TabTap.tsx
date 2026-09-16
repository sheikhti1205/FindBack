import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

interface TabTapContextValue {
  /** Increments every time the active tab is tapped again. */
  tapCount: number;
  /** Called by the bottom nav when the active tab is re-tapped. */
  notifyTabTap: () => void;
}

const TabTapContext = createContext<TabTapContextValue | null>(null);

export function TabTapProvider({ children }: { children: ReactNode }) {
  const [tapCount, setTapCount] = useState(0);
  const notifyTabTap = useCallback(() => setTapCount((c) => c + 1), []);
  const value = useMemo(() => ({ tapCount, notifyTabTap }), [tapCount, notifyTabTap]);
  return <TabTapContext.Provider value={value}>{children}</TabTapContext.Provider>;
}

export function useTabTap(): TabTapContextValue {
  const ctx = useContext(TabTapContext);
  if (!ctx) throw new Error("useTabTap must be used inside TabTapProvider");
  return ctx;
}