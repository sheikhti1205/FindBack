import type { KeyValueStore } from "./storage";

const PREFIX = "findback.ai.openrouter.v1.";
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

/** Browser persistence is opt-in; only salt/nonce/ciphertext are written. */
export function createBrowserAiCredentials(store: KeyValueStore) {
  const session = new Map<string, string>();
  const recordKey = (userId: string) => `${PREFIX}${encodeURIComponent(userId)}`;
  return {
    connect: async (userId: string, key: string, options: { remember: boolean; passphrase?: string }): Promise<void> => {
      if (!userId || !key.trim()) throw new Error("A user and API key are required.");
      if (options.remember) {
        const passphrase = options.passphrase ?? "";
        if (passphrase.length < 12) throw new Error("Choose an unlock phrase of at least 12 characters.");
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const nonce = crypto.getRandomValues(new Uint8Array(12));
        const cipher = await crypto.subtle.encrypt(
          { name: "AES-GCM", iv: nonce, additionalData: encoder.encode(userId) },
          await cipherKey(passphrase, salt), encoder.encode(key.trim()),
        );
        store.setItem(recordKey(userId), JSON.stringify({ version: 1, salt: base64(salt), nonce: base64(nonce), ciphertext: base64(new Uint8Array(cipher)) }));
      } else {
        store.removeItem(recordKey(userId));
      }
      session.set(userId, key.trim());
    },
    get: async (userId: string): Promise<string | null> => session.get(userId) ?? null,
    hasSaved: (userId: string): boolean => !!userId && store.getItem(recordKey(userId)) !== null,
    unlock: async (userId: string, passphrase: string): Promise<void> => {
      try {
        const saved = store.getItem(recordKey(userId));
        if (!saved) throw new Error("missing");
        const record: unknown = JSON.parse(saved);
        if (!record || typeof record !== "object") throw new Error("invalid");
        const { version, salt, nonce, ciphertext } = record as Record<string, unknown>;
        if (version !== 1 || typeof salt !== "string" || typeof nonce !== "string" || typeof ciphertext !== "string") throw new Error("invalid");
        const plain = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: bytes(nonce), additionalData: encoder.encode(userId) },
          await cipherKey(passphrase, bytes(salt)), bytes(ciphertext),
        );
        const key = decoder.decode(plain);
        if (!key.trim()) throw new Error("invalid");
        session.set(userId, key);
      } catch {
        throw new Error("Cannot unlock the saved key. Check your unlock phrase.");
      }
    },
    remove: async (userId: string): Promise<void> => {
      session.delete(userId);
      store.removeItem(recordKey(userId));
    },
    clearSession: (): void => { session.clear(); },
  };
}
