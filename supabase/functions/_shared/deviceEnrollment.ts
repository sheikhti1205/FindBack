import { verifyDeviceProof, type DeviceChallenge } from "./deviceProof.ts";

const unavailable = () => new Error("Device proof unavailable");
const isUuid = (value: unknown): value is string => typeof value === "string"
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);

/** Called only behind verified USER auth. Fields come from the authenticated
 * context and user-scoped challenge read, NEVER caller-supplied account/session.
 * SQL commit rechecks fences/expiry and consumes the nonce with enrollment under
 * its exclusive authority lock, even if revocation races crypto verification. */
export async function completeDeviceEnrollment(body: unknown, ports: {
  backendUrl: string; accountId: string; sessionId: string; now?: () => number; crypto?: Crypto;
  readChallenge(id: string): Promise<unknown>;
  commit(id: string): Promise<unknown>;
}): Promise<unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 2
    || !Object.hasOwn(body, "challengeId") || !Object.hasOwn(body, "signature")) throw unavailable();
  const input = body as Record<string, unknown>;
  if (!isUuid(input.challengeId) || typeof input.signature !== "string" || !/^[0-9a-f]{128}$/.test(input.signature)
    || !isUuid(ports.accountId) || !isUuid(ports.sessionId)) throw unavailable();
  const result = await ports.readChallenge(input.challengeId);
  if (!result || typeof result !== "object" || Array.isArray(result)) throw unavailable();
  const entry = result as Record<string, unknown>;
  if (entry.challengeId !== input.challengeId || entry.accountId !== ports.accountId || entry.sessionId !== ports.sessionId
    || !isUuid(entry.deviceId) || typeof entry.publicKey !== "string"
    || typeof entry.nonce !== "string" || typeof entry.issuedAt !== "number" || typeof entry.expiresAt !== "number") throw unavailable();
  const proof: DeviceChallenge = { version: 1, purpose: "REGISTER", accountId: ports.accountId,
    signerDeviceId: entry.deviceId, peerDeviceId: entry.deviceId, sessionId: ports.sessionId,
    nonce: entry.nonce, channelBinding: "0".repeat(64), issuedAt: entry.issuedAt, expiresAt: entry.expiresAt };
  const signature = Uint8Array.from(input.signature.match(/../g)!, pair => Number.parseInt(pair, 16)).buffer;
  if (!await verifyDeviceProof({ backendUrl: ports.backendUrl, accountId: ports.accountId, deviceId: entry.deviceId },
    entry.publicKey, proof, signature, { crypto: ports.crypto, now: (ports.now ?? Date.now)() })) throw unavailable();
  return await ports.commit(input.challengeId);
}
