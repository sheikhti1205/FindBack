/**
 * Minimal key/value storage used for auth session persistence.
 *
 * Uses `localStorage` when it is available and usable (browser + Capacitor
 * WebView), and falls back to an in-memory map otherwise (unit tests, SSR). No
 * storage library is introduced — this is the same mechanism the app already
 * used, just with a safe fallback so it is testable.
 */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function memoryStore(): KeyValueStore {
  const map = new Map<string, string>();
  return {
    getItem: (key) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

function pickStorage(): KeyValueStore {
  try {
    const ls = globalThis.localStorage;
    if (ls) {
      const probe = "__findback_probe__";
      ls.setItem(probe, "1");
      ls.removeItem(probe);
      return ls;
    }
  } catch {
    /* storage unavailable or blocked */
  }
  return memoryStore();
}

export const storage: KeyValueStore = pickStorage();
