/**
 * Client-side encryption for the optional Drive backup.
 *
 * The payload never leaves the device in plaintext: every chunk and the
 * manifest are AES-GCM sealed here before the Drive store sees them. The
 * account data key is admission-gated by the canonical server (never stored in
 * Drive beside the ciphertext), account-scoped, and versioned by `generation`,
 * so a new device can recover it after enrollment, an authorised second device
 * can read the same backup, and a revoked installation can no longer obtain it.
 *
 * The AAD binds each ciphertext to its own generation and object name, so a
 * valid chunk cannot be replayed as the manifest, moved between accounts with
 * different keys, or reused after a key rotation without failing to open.
 */

export const BACKUP_CRYPTO_VERSION = 1;
export const BACKUP_KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEX256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type BackupCryptoErrorCode =
  | "backup: invalid key"
  | "backup: invalid payload"
  | "backup: decryption failed";

export class BackupCryptoError extends Error {
  constructor(public code: BackupCryptoErrorCode) {
    super(code);
    this.name = "BackupCryptoError";
  }
}

export interface BackupKey {
  generation: string;
  key: CryptoKey;
}

/** Length-bounded object name; it is part of the AAD, so it must be exact. */
function objectName(value: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 200
    || [...value].some((char) => char.charCodeAt(0) < 0x20)) {
    throw new BackupCryptoError("backup: invalid payload");
  }
  return value;
}

function additionalData(generation: string, name: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`norfold.backup.v${BACKUP_CRYPTO_VERSION}|${generation}|${objectName(name)}`);
}

function subtle(crypto: Crypto): SubtleCrypto {
  if (!crypto?.subtle) throw new BackupCryptoError("backup: invalid key");
  return crypto.subtle;
}

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function unhex(value: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(value.length / 2);
  for (let index = 0; index < out.length; index++) {
    out[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

/** A fresh 32-byte account key. The server hands these out; the client never invents its own. */
export function backupKeyHex(value: unknown): string {
  if (typeof value !== "string" || !HEX256.test(value)) throw new BackupCryptoError("backup: invalid key");
  return value;
}

export async function importBackupKey(generation: unknown, keyHex: unknown,
  crypto: Crypto = globalThis.crypto): Promise<BackupKey> {
  if (typeof generation !== "string" || !UUID.test(generation)) throw new BackupCryptoError("backup: invalid key");
  const raw = unhex(backupKeyHex(keyHex));
  if (raw.byteLength !== BACKUP_KEY_BYTES) throw new BackupCryptoError("backup: invalid key");
  try {
    const key = await subtle(crypto).importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    return { generation, key };
  } catch {
    throw new BackupCryptoError("backup: invalid key");
  }
}

/**
 * Seal one object. Framing is `[version][iv 12][ciphertext||tag]`; the version
 * byte is authenticated as part of the AAD so a future format cannot be read
 * as this one.
 */
export async function sealBackupObject(key: BackupKey, name: string,
  plaintext: Uint8Array, crypto: Crypto = globalThis.crypto): Promise<ArrayBuffer> {
  if (!(plaintext instanceof Uint8Array) || plaintext.byteLength === 0) {
    throw new BackupCryptoError("backup: invalid payload");
  }
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = await subtle(crypto).encrypt({ name: "AES-GCM", iv,
    additionalData: additionalData(key.generation, name) }, key.key, plaintext as unknown as BufferSource);
  const body = new Uint8Array(sealed);
  const framed = new Uint8Array(1 + IV_BYTES + body.byteLength);
  framed[0] = BACKUP_CRYPTO_VERSION;
  framed.set(iv, 1);
  framed.set(body, 1 + IV_BYTES);
  return framed.buffer;
}

/** Open one object, failing closed on any framing, version, AAD or tag mismatch. */
export async function openBackupObject(key: BackupKey, name: string,
  framed: ArrayBuffer, crypto: Crypto = globalThis.crypto): Promise<Uint8Array> {
  if (!(framed instanceof ArrayBuffer) || framed.byteLength < 1 + IV_BYTES + TAG_BYTES + 1) {
    throw new BackupCryptoError("backup: invalid payload");
  }
  const bytes = new Uint8Array(framed);
  if (bytes[0] !== BACKUP_CRYPTO_VERSION) throw new BackupCryptoError("backup: invalid payload");
  const iv = bytes.slice(1, 1 + IV_BYTES);
  try {
    const opened = await subtle(crypto).decrypt({ name: "AES-GCM", iv,
      additionalData: additionalData(key.generation, name) }, key.key, bytes.slice(1 + IV_BYTES) as unknown as BufferSource);
    return new Uint8Array(opened);
  } catch {
    // A wrong key, a moved object or a tampered byte is indistinguishable here
    // by design: the caller must treat all of them as "cannot open".
    throw new BackupCryptoError("backup: decryption failed");
  }
}

export async function sha256Hex(bytes: Uint8Array, crypto: Crypto = globalThis.crypto): Promise<string> {
  const digest = await subtle(crypto).digest("SHA-256", bytes as unknown as BufferSource);
  return hex(new Uint8Array(digest));
}
