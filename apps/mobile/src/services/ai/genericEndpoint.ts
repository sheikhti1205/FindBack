/**
 * Custom-endpoint configuration for the `generic` OpenAI-compatible provider.
 *
 * The generic adapter needs a caller-supplied base URL and the registry
 * invents none: without a configured endpoint a generic key is unusable, and
 * construction fails closed with {@link GENERIC_ENDPOINT_MISSING_COPY}.
 *
 * Plain-HTTP policy (explicit): HTTPS endpoints are preferred and stored
 * without warnings. Plain HTTP is accepted ONLY for loopback hosts
 * (`localhost`, `127.0.0.0/8`, `::1`) — the Ollama / LM Studio LAN case —
 * and is always surfaced with {@link GENERIC_HTTP_LOOPBACK_COPY}. Plain HTTP
 * for any non-loopback host is rejected at save time. No credentials may ever
 * appear in the URL.
 *
 * Persistence is scoped to one account (`accountId`) for the `generic`
 * provider slot only, and holds only the endpoint URL — never key material.
 */
import { normalizeBaseURL } from "./providers/generic";
import { storage, type KeyValueStore } from "../storage";

export const GENERIC_ENDPOINT_MISSING_COPY =
  "A generic key without an endpoint is unusable: set a custom endpoint base URL for this account first. No default endpoint is assumed.";

export const GENERIC_HTTP_POLICY_COPY =
  "HTTPS is required, except plain HTTP to a loopback host (localhost or 127.x) for local tools such as Ollama. Non-loopback HTTP is rejected.";

export const GENERIC_HTTP_LOOPBACK_COPY =
  "Warning: this endpoint uses plain HTTP on a loopback host. Traffic to it is unencrypted; use HTTPS for anything beyond this device.";

function loopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1") return true;
  const quad = host.split(".");
  if (quad.length === 4 && quad[0] === "127") {
    return quad.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
  }
  return false;
}

export type GenericEndpointValidation =
  | { readonly ok: true; readonly endpoint: string; readonly insecure: boolean }
  | { readonly ok: false; readonly error: string; readonly insecure: false };

/**
 * Validate a raw endpoint input. Success returns the normalized endpoint
 * (trailing slashes stripped, via the adapter's own normalizer) plus whether
 * the caller must show the plain-HTTP warning (`insecure`). Failure returns a
 * user-visible reason; nothing is persisted here.
 */
export function validateGenericEndpoint(raw: string): GenericEndpointValidation {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") {
    return { ok: false, error: GENERIC_ENDPOINT_MISSING_COPY, insecure: false };
  }
  let normalized: string;
  try {
    normalized = normalizeBaseURL(trimmed);
  } catch {
    return {
      ok: false,
      error: `That endpoint is not a usable http(s) base URL without credentials. ${GENERIC_HTTP_POLICY_COPY}`,
      insecure: false,
    };
  }
  let protocol = "";
  let hostname = "";
  try {
    const parsed = new URL(normalized);
    protocol = parsed.protocol;
    hostname = parsed.hostname;
  } catch {
    return { ok: false, error: GENERIC_ENDPOINT_MISSING_COPY, insecure: false };
  }
  if (protocol === "https:") return { ok: true, endpoint: normalized, insecure: false };
  if (protocol === "http:" && loopbackHost(hostname)) {
    return { ok: true, endpoint: normalized, insecure: true };
  }
  return {
    ok: false,
    error: `Plain HTTP is rejected for non-loopback hosts. ${GENERIC_HTTP_POLICY_COPY}`,
    insecure: false,
  };
}

/** Account-scoped storage key for the generic endpoint (URL only, never a key). */
export function genericEndpointKey(accountId: string): string {
  return `findback.ai.generic.endpoint.v1.${encodeURIComponent(accountId)}`;
}

/** Load the configured endpoint for one account, or null when none is set. */
export function loadGenericEndpoint(
  accountId: string,
  store: KeyValueStore = storage,
): string | null {
  if (!accountId) return null;
  try {
    const raw = store.getItem(genericEndpointKey(accountId));
    if (raw === null || raw.trim() === "") return null;
    const checked = validateGenericEndpoint(raw);
    return checked.ok ? checked.endpoint : null;
  } catch {
    return null;
  }
}

/**
 * Validate and persist the endpoint for one account. Throws a user-visible
 * error on invalid input; never persists invalid input.
 */
export function saveGenericEndpoint(
  accountId: string,
  raw: string,
  store: KeyValueStore = storage,
): string {
  if (!accountId) throw new Error("An account is required to save the endpoint.");
  const checked = validateGenericEndpoint(raw);
  if (!checked.ok) throw new Error(checked.error);
  try {
    store.setItem(genericEndpointKey(accountId), checked.endpoint);
  } catch {
    throw new Error("Could not save the endpoint on this device. Try again.");
  }
  return checked.endpoint;
}

/** Remove the configured endpoint for one account (key slots are untouched). */
export function removeGenericEndpoint(
  accountId: string,
  store: KeyValueStore = storage,
): void {
  if (!accountId) return;
  try {
    store.removeItem(genericEndpointKey(accountId));
  } catch {
    // Best effort; a missing key is already the desired end state.
  }
}
