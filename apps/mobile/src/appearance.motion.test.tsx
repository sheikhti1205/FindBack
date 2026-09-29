// @vitest-environment jsdom
/**
 * H1-motion: ONE authoritative effective motion preference.
 *
 * Matrix: OS-reduce+System→reduced; OS-full+System→full; any-OS+Reduce→
 * reduced; any-OS+Full→full. Runtime changes (stored override or OS signal)
 * take effect WITHOUT reload across: MotionConfig mapping, uiMotion
 * imperative helpers + hook, and the `fb-reduce-motion` CSS class.
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APPEARANCE_STORAGE_KEY,
  DEFAULT_APPEARANCE,
  effectiveReduceMotion,
  motionConfigValueFor,
  resolveReduceMotion,
  saveAppearance,
} from "./appearance";
import { shouldReduceMotion, useShouldReduceMotion } from "./components/uiMotion";

type Listener = (event: Event) => void;

function mockOsPrefersReduced(matches: boolean): { listeners: Set<Listener>; restore: () => void } {
  const realMatchMedia = window.matchMedia;
  const listeners = new Set<Listener>();
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: /prefers-reduced-motion/.test(query) ? matches : false,
    media: query,
    onchange: null,
    addEventListener: (_type: string, cb: Listener) => {
      listeners.add(cb);
    },
    removeEventListener: (_type: string, cb: Listener) => {
      listeners.delete(cb);
    },
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
  return {
    listeners,
    restore: () => {
      window.matchMedia = realMatchMedia;
    },
  };
}

function persistReduceMotion(value: "system" | "reduce" | "full"): void {
  saveAppearance({ ...DEFAULT_APPEARANCE, reduceMotion: value });
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.classList.remove("fb-reduce-motion");
  delete document.documentElement.dataset.reduceMotionOverride;
});

describe("motionConfigValueFor (Framer Motion tristate)", () => {
  it('maps reduce→"always", full→"never", system→"user"', () => {
    expect(motionConfigValueFor("reduce")).toBe("always");
    expect(motionConfigValueFor("full")).toBe("never");
    expect(motionConfigValueFor("system")).toBe("user");
  });
});

describe("effective motion matrix (OS × override)", () => {
  it.each([
    { os: true, override: "system" as const, expected: true },
    { os: false, override: "system" as const, expected: false },
    { os: true, override: "reduce" as const, expected: true },
    { os: false, override: "reduce" as const, expected: true },
    { os: true, override: "full" as const, expected: false },
    { os: false, override: "full" as const, expected: false },
  ])("OS=$os override=$override → $expected", ({ os, override, expected }) => {
    expect(resolveReduceMotion(override, os)).toBe(expected);
  });

  it("effectiveReduceMotion reads the persisted override against the live OS signal", () => {
    const os = mockOsPrefersReduced(true);
    try {
      persistReduceMotion("system");
      expect(effectiveReduceMotion()).toBe(true);
      persistReduceMotion("full");
      expect(effectiveReduceMotion()).toBe(false);
      persistReduceMotion("reduce");
      expect(effectiveReduceMotion()).toBe(true);
    } finally {
      os.restore();
    }
  });
});

describe("shouldReduceMotion (imperative helper honors the override, not just the OS)", () => {
  it("follows the OS when the override is system", () => {
    persistReduceMotion("system");
    const os = mockOsPrefersReduced(true);
    try {
      expect(shouldReduceMotion()).toBe(true);
    } finally {
      os.restore();
    }
    const osFull = mockOsPrefersReduced(false);
    try {
      expect(shouldReduceMotion()).toBe(false);
    } finally {
      osFull.restore();
    }
  });

  it("forces reduced when the override is reduce even with a full-motion OS", () => {
    persistReduceMotion("reduce");
    const os = mockOsPrefersReduced(false);
    try {
      expect(shouldReduceMotion()).toBe(true);
    } finally {
      os.restore();
    }
  });

  it("forces full when the override is full even with a reduced-motion OS", () => {
    persistReduceMotion("full");
    const os = mockOsPrefersReduced(true);
    try {
      expect(shouldReduceMotion()).toBe(false);
    } finally {
      os.restore();
    }
  });

  it("never throws when matchMedia and storage are unavailable", () => {
    const realMatchMedia = window.matchMedia;
    // @ts-expect-error jsdom without matchMedia (SSR-like guard)
    delete window.matchMedia;
    try {
      expect(() => shouldReduceMotion()).not.toThrow();
    } finally {
      window.matchMedia = realMatchMedia;
    }
  });
});

describe("useShouldReduceMotion (reactive, no reload)", () => {
  it("flips when the stored override changes at runtime", () => {
    persistReduceMotion("system");
    const os = mockOsPrefersReduced(false);
    try {
      const { result } = renderHook(() => useShouldReduceMotion());
      expect(result.current).toBe(false);
      act(() => {
        persistReduceMotion("reduce");
      });
      expect(result.current).toBe(true);
      act(() => {
        persistReduceMotion("full");
      });
      expect(result.current).toBe(false);
    } finally {
      os.restore();
    }
  });

  it("flips when the OS signal changes at runtime", () => {
    persistReduceMotion("system");
    let osMatches = false;
    const realMatchMedia = window.matchMedia;
    const listeners = new Set<Listener>();
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      get matches() {
        return /prefers-reduced-motion/.test(query) ? osMatches : false;
      },
      media: query,
      onchange: null,
      addEventListener: (_type: string, cb: Listener) => {
        listeners.add(cb);
      },
      removeEventListener: (_type: string, cb: Listener) => {
        listeners.delete(cb);
      },
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia;
    try {
      const { result } = renderHook(() => useShouldReduceMotion());
      expect(result.current).toBe(false);
      act(() => {
        osMatches = true;
        for (const cb of listeners) cb(new Event("change"));
      });
      expect(result.current).toBe(true);
    } finally {
      window.matchMedia = realMatchMedia;
    }
  });
});

describe("applyAppearance motion markers stay in sync (CSS kill-switch input)", () => {
  it("toggles fb-reduce-motion from the effective flag on every override", async () => {
    const { applyAppearance } = await import("./appearance");
    const os = mockOsPrefersReduced(false);
    try {
      applyAppearance({ ...DEFAULT_APPEARANCE, reduceMotion: "reduce" });
      expect(document.documentElement.classList.contains("fb-reduce-motion")).toBe(true);
      applyAppearance({ ...DEFAULT_APPEARANCE, reduceMotion: "full" });
      expect(document.documentElement.classList.contains("fb-reduce-motion")).toBe(false);
      applyAppearance({ ...DEFAULT_APPEARANCE, reduceMotion: "system" });
      expect(document.documentElement.classList.contains("fb-reduce-motion")).toBe(false);
    } finally {
      os.restore();
    }
    expect(localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBeNull();
  });
});
