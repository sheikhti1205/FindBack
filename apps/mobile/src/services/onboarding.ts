/**
 * First-run onboarding state (Task B, packet 05_ONBOARDING).
 *
 * Versioned persistence: localStorage key `findback.onboarding.version` holds
 * the completed version (`2`). Completion is recorded on Skip OR Get started
 * and is never cleared — replaying onboarding finishes again without clearing.
 *
 * This module deliberately exposes no clear/reset API: completion is sticky
 * by design, and returning signed-in users bypass onboarding entirely (see
 * `shouldBypassOnboarding`), so upgrading users are never forced through it.
 *
 * Pure guard helpers stay storage-free and injectable for tests; the two
 * convenience readers (`isOnboardingComplete()` / `completeOnboarding()`
 * defaults) touch guarded localStorage and never throw.
 */

import { getPendingReportRoute } from "../utils/pendingReportLink";

/** Current onboarding version. Fresh guests see onboarding until this is stored. */
export const ONBOARDING_VERSION = 2 as const;

/** Persistence key holding the completed onboarding version. */
export const ONBOARDING_STORAGE_KEY = "findback.onboarding.version" as const;

/** Minimal storage surface (localStorage-compatible; fakes welcome in tests). */
export interface OnboardingStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function resolveStore(explicit?: OnboardingStore | null): OnboardingStore | null {
  if (explicit) return explicit;
  try {
    return typeof globalThis.localStorage !== "undefined" ? globalThis.localStorage : null;
  } catch {
    return null;
  }
}

/**
 * Read the stored onboarding version. Returns null when never completed or
 * when storage is missing/corrupt (never throws).
 */
export function readOnboardingVersion(store?: OnboardingStore | null): number | null {
  const resolved = resolveStore(store);
  if (!resolved) return null;
  try {
    const raw = resolved.getItem(ONBOARDING_STORAGE_KEY);
    if (raw == null) return null;
    const parsed = Number.parseInt(raw.trim(), 10);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  } catch {
    return null;
  }
}

/** True once onboarding completed (Skip or Get started) at the current version. */
export function isOnboardingComplete(store?: OnboardingStore | null): boolean {
  return readOnboardingVersion(store) === ONBOARDING_VERSION;
}

/**
 * Record onboarding completion. Idempotent — calling it on a replay keeps
 * completion and never clears it. Never throws.
 */
export function completeOnboarding(store?: OnboardingStore | null): void {
  const resolved = resolveStore(store);
  if (!resolved) return;
  try {
    resolved.setItem(ONBOARDING_STORAGE_KEY, String(ONBOARDING_VERSION));
  } catch {
    /* completion stays in memory-only; navigation still proceeds */
  }
}

export interface OnboardingBypassInput {
  /** A signed-in session exists (returning user). */
  signedIn: boolean;
  /** A pending shared-report link awaits (must not be stolen by onboarding). */
  hasPendingLink: boolean;
}

/**
 * Returning signed-in users bypass onboarding; a pending shared-report launch
 * may also bypass so the link destination wins over first-run flow.
 */
export function shouldBypassOnboarding(input: OnboardingBypassInput): boolean {
  return input.signedIn || input.hasPendingLink;
}

export interface ShouldShowOnboardingInput extends OnboardingBypassInput {
  /** Current completion state from `isOnboardingComplete()`. */
  complete: boolean;
}

/** Fresh-launch rule: show only when incomplete and no bypass applies. */
export function shouldShowOnboarding(input: ShouldShowOnboardingInput): boolean {
  if (input.complete) return false;
  return !shouldBypassOnboarding(input);
}

/** True while a pending shared-report route awaits (link never consumed here). */
export function hasPendingReportLink(): boolean {
  try {
    return getPendingReportRoute() !== null;
  } catch {
    return false;
  }
}

/**
 * Destination when a pending shared-report launch bypasses onboarding.
 * The link itself is resolved by the ReportLinkHandler/auth flow afterwards —
 * this only keeps a guest on the auth path (`/auth`) while a signed-in
 * replay lands back in settings (`/settings`).
 */
export function resolvePendingLinkBypassDestination(signedIn: boolean): "/auth" | "/settings" {
  return signedIn ? "/settings" : "/auth";
}
