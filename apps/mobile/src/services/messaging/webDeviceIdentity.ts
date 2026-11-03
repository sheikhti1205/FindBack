import { deviceChallengeBytes as challengeBytes, normalizeDeviceScope as normalizeScope,
  type DeviceChallenge, type DeviceIdentityScope } from "../../../../../supabase/functions/_shared/deviceProof";
export { verifyDeviceProof, type DeviceChallenge, type DeviceIdentityScope } from "../../../../../supabase/functions/_shared/deviceProof";

export interface WebDeviceIdentity {
  /** Hex SEC1 public P-256 point. The private CryptoKey is never returned/exported. */
  readonly publicKey: string;
  sign(challenge: DeviceChallenge): Promise<ArrayBuffer>;
  close(): void;
}

const KEY_ALGORITHM = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN_ALGORITHM = { name: "ECDSA", hash: "SHA-256" } as const;

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
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
