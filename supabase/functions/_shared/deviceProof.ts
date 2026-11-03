/** Canonical wire proof used by device-local signers and the server verifier.
 * No credentials/private keys or platform imports. The registry/nonce owner must
 * supply current authority separately: a signature alone never authorizes sync. */
export interface DeviceIdentityScope { backendUrl: string; accountId: string; deviceId: string }
export interface DeviceChallenge {
  version: 1;
  purpose: "REGISTER" | "PEER";
  accountId: string;
  signerDeviceId: string;
  peerDeviceId: string;
  /** Verified Auth session for REGISTER; fresh transfer ID for PEER. */
  sessionId: string;
  nonce: string;
  /** Local transport's hash of both actual DTLS fingerprints; zero for REGISTER. */
  channelBinding: string;
  issuedAt: number;
  expiresAt: number;
}
const fields = ["version", "purpose", "accountId", "signerDeviceId", "peerDeviceId",
  "sessionId", "nonce", "channelBinding", "issuedAt", "expiresAt"];
function uuid(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) throw new Error("Invalid device identity");
  return value;
}
export function normalizeDeviceScope(scope: DeviceIdentityScope): DeviceIdentityScope {
  const url = new URL(scope.backendUrl);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Invalid device backend");
  return { backendUrl: url.origin, accountId: uuid(scope.accountId), deviceId: uuid(scope.deviceId) };
}
export function deviceChallengeBytes(scope: DeviceIdentityScope, proof: DeviceChallenge, now: number): Uint8Array<ArrayBuffer> {
  if (!proof || typeof proof !== "object" || Object.keys(proof).length !== fields.length
    || fields.some(field => !Object.hasOwn(proof, field))
    || proof.version !== 1 || !["REGISTER", "PEER"].includes(proof.purpose)
    || proof.accountId !== scope.accountId || proof.signerDeviceId !== scope.deviceId
    || typeof proof.nonce !== "string" || !/^[0-9a-f]{64}$/.test(proof.nonce) || !Number.isSafeInteger(now)
    || typeof proof.channelBinding !== "string" || !/^[0-9a-f]{64}$/.test(proof.channelBinding)
    || !Number.isSafeInteger(proof.issuedAt) || proof.issuedAt < 0
    || !Number.isSafeInteger(proof.expiresAt) || proof.expiresAt <= proof.issuedAt
    || proof.expiresAt - proof.issuedAt > 120_000 || proof.issuedAt > now + 5_000
    || proof.expiresAt <= now) throw new Error("Invalid device challenge");
  uuid(proof.sessionId); uuid(proof.peerDeviceId);
  if ((proof.purpose === "PEER") === (proof.peerDeviceId === scope.deviceId)) throw new Error("Invalid device challenge");
  if ((proof.purpose === "REGISTER") !== (proof.channelBinding === "0".repeat(64))) throw new Error("Invalid device channel binding");
  return new TextEncoder().encode(JSON.stringify(["norfold-device-proof", 1, scope.backendUrl,
    proof.purpose, proof.accountId, proof.signerDeviceId, proof.peerDeviceId,
    proof.sessionId, proof.nonce, proof.channelBinding, proof.issuedAt, proof.expiresAt]));
}
export async function verifyDeviceProof(scope: DeviceIdentityScope, publicKey: string,
  challenge: DeviceChallenge, signature: ArrayBuffer, options: { crypto?: Crypto; now: number }): Promise<boolean> {
  try {
    const bytes = deviceChallengeBytes(normalizeDeviceScope(scope), challenge, options.now);
    if (typeof publicKey !== "string" || !/^04[0-9a-f]{128}$/.test(publicKey)
      || !(signature instanceof ArrayBuffer) || signature.byteLength !== 64) return false;
    const crypto = options.crypto ?? globalThis.crypto;
    const raw = Uint8Array.from(publicKey.match(/../g)!, pair => Number.parseInt(pair, 16));
    const key = await crypto.subtle.importKey("raw", raw, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]);
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signature, bytes);
  } catch { return false; }
}
