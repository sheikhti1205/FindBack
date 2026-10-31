import { useSyncExternalStore } from "react";

export const FINE_POINTER_QUERY = "(hover: hover) and (pointer: fine)";

export function hasFinePointer(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(FINE_POINTER_QUERY).matches;
}

function subscribe(onChange: () => void) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const query = window.matchMedia(FINE_POINTER_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** Input capability, not a phone/tablet or touch-device guess. */
export function useFinePointer(): boolean { return useSyncExternalStore(subscribe, hasFinePointer, () => false); }
