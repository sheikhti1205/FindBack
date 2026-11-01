/**
 * Cross-component signal for local safety mutations.
 *
 * Blocking or unblocking in one surface changes what every other surface may
 * show — a chat's report preview, a feed row, a profile. Realtime covers the
 * other account's action, but a block made in THIS tab is local: whatever was
 * already loaded must be revoked now, not on the next focus event.
 */
export const SAFETY_CHANGED_EVENT = "findback:safety-changed";

/** Notify listeners that the signed-in reader's safety state changed locally. */
export function signalSafetyChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(SAFETY_CHANGED_EVENT));
}

/** Subscribe to local safety changes. Returns the unsubscribe handle. */
export function subscribeSafetyChanged(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(SAFETY_CHANGED_EVENT, listener);
  return () => window.removeEventListener(SAFETY_CHANGED_EVENT, listener);
}
