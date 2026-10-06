import type { ProviderId } from "./providerContract";

/** Release evidence, not adapter existence or a saved key. Offline is a core feature. */
export const LIVE_TESTED_PROVIDERS: readonly ProviderId[] = ["openrouter"];
export const EXPERIMENTAL_PROVIDER_NOTICE =
  "Experimental remote adapters are not live-send verified. A saved key or catalogue does not prove a successful answer. To smoke-test a configured provider: select a listed Free text model in Help, choose Cloud only, send a non-sensitive question, and check the provider/model and completed answer. Paid or unknown-price rows remain blocked in Help. Turn this switch off to disable these providers without deleting their keys.";

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
