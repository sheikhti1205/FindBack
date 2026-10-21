import type { ProviderId } from "./providerContract";

/** Release evidence, not adapter existence or a saved key. Offline is a core feature. */
export const LIVE_TESTED_PROVIDERS: readonly ProviderId[] = ["openrouter"];
/**
 * Truthful scope for the experimental-provider switch: it gates WHICH
 * providers this technical list shows and tests. It does not disable a
 * provider anywhere else (the consumer Providers screen lists every wired
 * adapter), and it never deletes a saved key.
 */
export const EXPERIMENTAL_PROVIDER_NOTICE =
  "Experimental remote adapters are not live-send verified. A saved key or a catalogue listing does not prove a successful answer — the real test is a message in Chat. To check one: add the provider key under Providers, choose the model, send a non-sensitive question, and confirm the answer arrives. This switch only controls which providers appear in this technical list below; it does not disable them elsewhere and it never deletes your keys.";

export function isExperimentalProvider(provider: ProviderId): boolean {
  return provider !== "offline" && !LIVE_TESTED_PROVIDERS.includes(provider);
}

export function experimentalProvidersKey(accountId: string): string {
  return `findback.ai.experimentalProviders.v1.${accountId.trim() || "local"}`;
}

export function experimentalProvidersEnabled(accountId: string): boolean {
  try { return globalThis.localStorage?.getItem(experimentalProvidersKey(accountId)) === "true"; }
  catch { return false; }
}

export function setExperimentalProvidersEnabled(accountId: string, enabled: boolean): void {
  try { globalThis.localStorage?.setItem(experimentalProvidersKey(accountId), String(enabled)); }
  catch { /* Storage failure stays off: opt-in is fail closed. */ }
}

export function isProviderEnabled(accountId: string, provider: ProviderId): boolean {
  return !isExperimentalProvider(provider) || experimentalProvidersEnabled(accountId);
}
