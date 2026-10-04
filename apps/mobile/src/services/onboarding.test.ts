// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ONBOARDING_STORAGE_KEY,
  ONBOARDING_VERSION,
  completeOnboarding,
  hasPendingReportLink,
  isOnboardingComplete,
  readOnboardingVersion,
  resolvePendingLinkBypassDestination,
  shouldBypassOnboarding,
  shouldShowOnboarding,
  type OnboardingStore,
} from "./onboarding";

function memoryStore(seed: Record<string, string> = {}): OnboardingStore {
  const map = new Map(Object.entries(seed));
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

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.unstubAllEnvs();
});

describe("onboarding versioned state", () => {
  it("uses the versioned persistence key with version 2", () => {
    expect(ONBOARDING_STORAGE_KEY).toBe("findback.onboarding.version");
    expect(ONBOARDING_VERSION).toBe(2);
  });

  it("fresh launch is not complete", () => {
    const store = memoryStore();
    expect(readOnboardingVersion(store)).toBeNull();
    expect(isOnboardingComplete(store)).toBe(false);
    expect(
      shouldShowOnboarding({ signedIn: false, hasPendingLink: false, complete: false }),
    ).toBe(true);
  });

  it("completing persists version 2 (Skip or Get started path)", () => {
    const store = memoryStore();
    completeOnboarding(store);
    expect(store.getItem(ONBOARDING_STORAGE_KEY)).toBe("2");
    expect(readOnboardingVersion(store)).toBe(2);
    expect(isOnboardingComplete(store)).toBe(true);
  });

  it("replay never clears completion", () => {
    const store = memoryStore();
    completeOnboarding(store);
    // Re-entering onboarding and finishing again keeps completion.
    completeOnboarding(store);
    expect(isOnboardingComplete(store)).toBe(true);
    expect(store.getItem(ONBOARDING_STORAGE_KEY)).toBe("2");
  });

  it("corrupt storage falls back safely instead of throwing", () => {
    const store = memoryStore({ [ONBOARDING_STORAGE_KEY]: "not-a-version!!" });
    expect(readOnboardingVersion(store)).toBeNull();
    expect(isOnboardingComplete(store)).toBe(false);
  });

  it("unavailable storage never throws", () => {
    expect(readOnboardingVersion(null)).toBeNull();
    expect(isOnboardingComplete(null)).toBe(false);
    expect(() => completeOnboarding(null)).not.toThrow();
  });
});

describe("onboarding guards", () => {
  it("returning signed-in users bypass", () => {
    expect(shouldBypassOnboarding({ signedIn: true, hasPendingLink: false })).toBe(true);
    expect(
      shouldShowOnboarding({ signedIn: true, hasPendingLink: false, complete: false }),
    ).toBe(false);
  });

  it("a pending shared-report launch may bypass without stealing the link", () => {
    expect(shouldBypassOnboarding({ signedIn: false, hasPendingLink: true })).toBe(true);
    expect(
      shouldShowOnboarding({ signedIn: false, hasPendingLink: true, complete: false }),
    ).toBe(false);
  });

  it("no bypass for a fresh guest with no pending link", () => {
    expect(shouldBypassOnboarding({ signedIn: false, hasPendingLink: false })).toBe(false);
  });

  it("never directs a pending link at onboarding: guest goes to /auth, signed-in replay to /settings", () => {
    expect(resolvePendingLinkBypassDestination(false)).toBe("/auth");
    expect(resolvePendingLinkBypassDestination(true)).toBe("/settings");
  });

  it("hasPendingReportLink reflects the stored pending report route", () => {
    expect(hasPendingReportLink()).toBe(false);
    vi.stubEnv("VITE_PUBLIC_SHARE_ORIGIN", "https://findbackapp.social");
    const id = "5b6f7c8d-1234-4abc-8def-123456789012";
    sessionStorage.setItem(
      "findback.pendingReportLink",
      JSON.stringify({
        url: `https://findbackapp.social/r/${id}`,
        expiresAt: Date.now() + 60_000,
      }),
    );
    expect(hasPendingReportLink()).toBe(true);
  });
});
