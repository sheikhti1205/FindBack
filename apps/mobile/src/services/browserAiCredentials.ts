import type { CredentialHandle, ProviderId } from "./ai/providerContract";
import type { KeyValueStore } from "./storage";

/** The five BYOK providers. Every vault slot is namespaced by one of these. */
export const SUPPORTED_AI_PROVIDERS: readonly ProviderId[] = [
  "openrouter",
  "openai",
  "anthropic",
  "google",
  "deepseek",
];

const PROVIDER_SET: ReadonlySet<string> = new Set(SUPPORTED_AI_PROVIDERS);
const DEFAULT_PROVIDER: ProviderId = "openrouter";
/** Opaque storage reference carried inside `CredentialHandle.handle`. Never key material. */
const HANDLE_TAG = "vault-v1";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ITERATIONS = 210_000;

function base64(data: Uint8Array): string {
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function bytes(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

async function cipherKey(passphrase: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const input = await crypto.subtle.importKey("raw", encoder.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" },
    input,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Strict provider resolution: unknown names throw a generic error that never
 * carries key material. Callers that only probe presence use the lenient
 * read path (`get`/`hasSaved` return null/false for unknown slots).
 */
export function resolveAiProvider(provider: unknown): ProviderId {
  if (provider === undefined) return DEFAULT_PROVIDER;
  if (typeof provider === "string" && PROVIDER_SET.has(provider)) return provider as ProviderId;
  throw new Error("Unknown AI provider.");
}

function lenientProvider(provider: unknown): ProviderId | null {
  try {
    return resolveAiProvider(provider);
  } catch {
    return null;
  }
}

/**
 * Per-account, per-provider storage key. The `openrouter` shape is exactly
 * the legacy `findback.ai.openrouter.v1.<user>` record, so previously saved
 * OpenRouter keys stay readable; every other provider gets a disjoint slot.
 * Isolation is by distinct keys (same-origin `localStorage` scoping applies);
 * the record format (version 1, AAD = userId) is unchanged on purpose so old
 * saves keep decrypting.
 */
function recordKey(userId: string, provider: ProviderId): string {
  return `findback.ai.${provider}.v1.${encodeURIComponent(userId)}`;
}

function sessionKey(userId: string, provider: ProviderId): string {
  return `${provider}\0${userId}`;
}

/** Opaque handle for one account/provider slot. Carries no key material. */
export function aiCredentialHandle(accountId: string, provider: ProviderId): CredentialHandle {
  return { accountId, provider, handle: `${HANDLE_TAG}:${provider}` };
}

/** Browser persistence is opt-in; only salt/nonce/ciphertext are written. */
export function createBrowserAiCredentials(store: KeyValueStore) {
  const session = new Map<string, string>();
  return {
    connect: async (
      userId: string,
      key: string,
      options: { remember: boolean; passphrase?: string; provider?: ProviderId },
    ): Promise<void> => {
      if (!userId || !key.trim()) throw new Error("A user and API key are required.");
      const provider = resolveAiProvider(options.provider);
      if (options.remember) {
        const passphrase = options.passphrase ?? "";
        if (passphrase.length < 12) throw new Error("Choose an unlock phrase of at least 12 characters.");
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const nonce = crypto.getRandomValues(new Uint8Array(12));
        const cipher = await crypto.subtle.encrypt(
          { name: "AES-GCM", iv: nonce, additionalData: encoder.encode(userId) },
          await cipherKey(passphrase, salt),
          encoder.encode(key.trim()),
        );
        store.setItem(
          recordKey(userId, provider),
          JSON.stringify({
            version: 1,
            salt: base64(salt),
            nonce: base64(nonce),
            ciphertext: base64(new Uint8Array(cipher)),
          }),
        );
      } else {
        store.removeItem(recordKey(userId, provider));
      }
      session.set(sessionKey(userId, provider), key.trim());
    },
    get: async (userId: string, provider?: ProviderId): Promise<string | null> => {
      const slot = lenientProvider(provider);
      if (!userId || !slot) return null;
      return session.get(sessionKey(userId, slot)) ?? null;
    },
    hasSaved: (userId: string, provider?: ProviderId): boolean => {
      const slot = lenientProvider(provider);
      if (!userId || !slot) return false;
      return store.getItem(recordKey(userId, slot)) !== null;
    },
    unlock: async (userId: string, passphrase: string, provider?: ProviderId): Promise<void> => {
      const slot = resolveAiProvider(provider);
      try {
        const saved = store.getItem(recordKey(userId, slot));
        if (!saved) throw new Error("missing");
        const record: unknown = JSON.parse(saved);
        if (!record || typeof record !== "object") throw new Error("invalid");
        const { version, salt, nonce, ciphertext } = record as Record<string, unknown>;
        if (version !== 1 || typeof salt !== "string" || typeof nonce !== "string" || typeof ciphertext !== "string")
          throw new Error("invalid");
        const plain = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: bytes(nonce), additionalData: encoder.encode(userId) },
          await cipherKey(passphrase, bytes(salt)),
          bytes(ciphertext),
        );
        const key = decoder.decode(plain);
        if (!key.trim()) throw new Error("invalid");
        session.set(sessionKey(userId, slot), key);
      } catch {
        throw new Error("Cannot unlock the saved key. Check your unlock phrase.");
      }
    },
    remove: async (userId: string, provider?: ProviderId): Promise<void> => {
      const slot = resolveAiProvider(provider);
      session.delete(sessionKey(userId, slot));
      store.removeItem(recordKey(userId, slot));
    },
    /** Logout: clear every provider slot (persisted + session) for one account only. */
    removeAccount: async (userId: string): Promise<void> => {
      for (const provider of SUPPORTED_AI_PROVIDERS) {
        session.delete(sessionKey(userId, provider));
        store.removeItem(recordKey(userId, provider));
      }
    },
    credentialHandle: (userId: string, provider?: ProviderId): CredentialHandle => {
      if (!userId) throw new Error("A user and provider are required.");
      return aiCredentialHandle(userId, resolveAiProvider(provider));
    },
    clearSession: (): void => {
      session.clear();
    },
  };
}
