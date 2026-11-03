import { uuid } from "./validation";

export interface DeviceIdentityScope {
  backendUrl: string;
  accountId: string;
  deviceId: string;
}

/** Fixed metadata only: never a message, offer, credential or arbitrary signing oracle.
 * A server-issued single-use nonce and current roster must ALSO be validated by
 * the session owner. A valid signature alone is not current authorization. */
export interface DeviceChallenge {
  version: 1;
  purpose: "REGISTER" | "PEER";
  accountId: string;
  signerDeviceId: string;
  peerDeviceId: string;
  sessionId: string;
  nonce: string;
  /** Hash of both actual DTLS certificate fingerprints, computed by the local
   * transport owner. REGISTER uses all zeroes (no channel exists yet). */
  channelBinding: string;
  issuedAt: number;
  expiresAt: number;
}

export interface WebDeviceIdentity {
  /** Hex SEC1 public P-256 point. The private CryptoKey is never returned/exported. */
  readonly publicKey: string;
  sign(challenge: DeviceChallenge): Promise<ArrayBuffer>;
  close(): void;
}

const KEY_ALGORITHM = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN_ALGORITHM = { name: "ECDSA", hash: "SHA-256" } as const;
const CHALLENGE_FIELDS = ["version", "purpose", "accountId", "signerDeviceId", "peerDeviceId",
  "sessionId", "nonce", "channelBinding", "issuedAt", "expiresAt"] as const;

function normalizeScope(scope: DeviceIdentityScope): DeviceIdentityScope {
  const url = new URL(scope.backendUrl);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Invalid device backend");
  }
  return { backendUrl: url.origin, accountId: uuid(scope.accountId), deviceId: uuid(scope.deviceId) };
}

function challengeBytes(scope: DeviceIdentityScope, proof: DeviceChallenge, now: number): Uint8Array<ArrayBuffer> {
  if (!proof || typeof proof !== "object" || Object.keys(proof).length !== CHALLENGE_FIELDS.length
    || CHALLENGE_FIELDS.some(field => !Object.hasOwn(proof, field))
    || proof.version !== 1 || !["REGISTER", "PEER"].includes(proof.purpose)
    || proof.accountId !== scope.accountId || proof.signerDeviceId !== scope.deviceId
    || typeof proof.nonce !== "string" || !/^[0-9a-f]{64}$/.test(proof.nonce) || !Number.isSafeInteger(now)
    || typeof proof.channelBinding !== "string" || !/^[0-9a-f]{64}$/.test(proof.channelBinding)
    || !Number.isSafeInteger(proof.issuedAt) || proof.issuedAt < 0
    || !Number.isSafeInteger(proof.expiresAt) || proof.expiresAt <= proof.issuedAt
    || proof.expiresAt - proof.issuedAt > 120_000 || proof.issuedAt > now + 5_000
    || proof.expiresAt <= now) throw new Error("Invalid device challenge");
  uuid(proof.sessionId); uuid(proof.peerDeviceId);
  if ((proof.purpose === "PEER") === (proof.peerDeviceId === scope.deviceId)) {
    throw new Error("Invalid device challenge");
  }
  if ((proof.purpose === "REGISTER") !== (proof.channelBinding === "0".repeat(64))) {
    throw new Error("Invalid device channel binding");
  }
  return new TextEncoder().encode(JSON.stringify(["norfold-device-proof", 1, scope.backendUrl,
    proof.purpose, proof.accountId, proof.signerDeviceId, proof.peerDeviceId,
    proof.sessionId, proof.nonce, proof.channelBinding, proof.issuedAt, proof.expiresAt]));
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}

/** The scope/public key must come from the authenticated current registry, not
 * from a peer's claimed identity. Replay/roster/revocation checks remain mandatory. */
export async function verifyDeviceProof(scope: DeviceIdentityScope, publicKey: string,
  challenge: DeviceChallenge, signature: ArrayBuffer, options: { crypto?: Crypto; now: number }): Promise<boolean> {
  try {
    const bytes = challengeBytes(normalizeScope(scope), challenge, options.now);
    if (!/^04[0-9a-f]{128}$/.test(publicKey) || !(signature instanceof ArrayBuffer) || signature.byteLength !== 64) return false;
    const crypto = options.crypto ?? globalThis.crypto;
    const raw = Uint8Array.from(publicKey.match(/../g)!, pair => Number.parseInt(pair, 16));
    const key = await crypto.subtle.importKey("raw", raw, KEY_ALGORITHM, true, ["verify"]);
    return await crypto.subtle.verify(SIGN_ALGORITHM, key, signature, bytes);
  } catch { return false; }
}

function openKeys(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let abandoned = false;
    const request = factory.open("norfold-device-keys-v1", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("identities");
    request.onsuccess = () => {
      if (abandoned) { request.result.close(); return; }
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(new Error("Device identity could not be opened"));
    request.onblocked = () => { abandoned = true; reject(new Error("Device identity upgrade is blocked")); };
  });
}

function loadKeys(db: IDBDatabase, key: string): Promise<CryptoKeyPair | undefined> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("identities", "readonly");
    const request = transaction.objectStore("identities").get(key);
    request.onsuccess = () => resolve(request.result as CryptoKeyPair | undefined);
    request.onerror = () => reject(new Error("Device identity could not be read"));
  });
}

/** Crypto generation happens outside the transaction. Read + first-writer insert
 * is atomic in one readwrite transaction, including parallel tabs/openers. */
function persistKeys(db: IDBDatabase, key: string, candidate: CryptoKeyPair): Promise<CryptoKeyPair> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("identities", "readwrite");
    const store = transaction.objectStore("identities"), request = store.get(key);
    let winner: CryptoKeyPair;
    request.onsuccess = () => {
      winner = request.result as CryptoKeyPair | undefined ?? candidate;
      if (request.result === undefined) store.add(candidate, key);
    };
    transaction.oncomplete = () => resolve(winner);
    transaction.onabort = transaction.onerror = () => reject(new Error("Device identity could not be saved"));
  });
}

async function validateKeys(crypto: Crypto, keys: CryptoKeyPair): Promise<string> {
  for (const [key, type, usage] of [[keys?.privateKey, "private", "sign"], [keys?.publicKey, "public", "verify"]] as const) {
    if (!key || key.type !== type || key.algorithm.name !== "ECDSA"
      || (key.algorithm as EcKeyAlgorithm).namedCurve !== "P-256"
      || key.usages.length !== 1 || key.usages[0] !== usage) throw new Error("Invalid saved device identity");
  }
  if (keys.privateKey.extractable || !keys.publicKey.extractable) throw new Error("Invalid saved device identity");
  // Reject mismatched pairs/corrupted structured clones without rotating a live key.
  const probe = crypto.getRandomValues(new Uint8Array(32));
  const signature = await crypto.subtle.sign(SIGN_ALGORITHM, keys.privateKey, probe);
  if (!await crypto.subtle.verify(SIGN_ALGORITHM, keys.publicKey, signature, probe)) {
    throw new Error("Invalid saved device identity");
  }
  return hex(await crypto.subtle.exportKey("raw", keys.publicKey));
}

/** Web-only device-local signing owner. Native Keystore backing is separate;
 * never claim this WebCrypto store is Android hardware-backed. */
export async function openWebDeviceIdentity(owner: DeviceIdentityScope,
  options: { indexedDB?: IDBFactory; crypto?: Crypto; now?: () => number } = {}): Promise<WebDeviceIdentity> {
  const scope = normalizeScope(owner), crypto = options.crypto ?? globalThis.crypto;
  const now = options.now ?? Date.now;
  const db = await openKeys(options.indexedDB ?? globalThis.indexedDB);
  const key = JSON.stringify([scope.backendUrl, scope.accountId, scope.deviceId]);
  try {
    let keys = await loadKeys(db, key);
    if (keys === undefined) {
      const candidate = await crypto.subtle.generateKey(KEY_ALGORITHM, false, ["sign", "verify"]);
      keys = await persistKeys(db, key, candidate);
    }
    const publicKey = await validateKeys(crypto, keys);
    let closed = false;
    return { publicKey, async sign(proof) {
      if (closed) throw new Error("Device identity is closed");
      const bytes = challengeBytes(scope, proof, now());
      const signature = await crypto.subtle.sign(SIGN_ALGORITHM, keys.privateKey, bytes);
      if (closed) throw new Error("Device identity is closed");
      // Do not finish a proof that expired while cryptography was in flight.
      challengeBytes(scope, proof, now());
      return signature;
    }, close() { closed = true; db.close(); } };
  } catch (error) { db.close(); throw error; }
}
