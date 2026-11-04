import { normalizeDeviceScope, deviceChallengeBytes, type DeviceChallenge, type DeviceIdentityScope } from "../../../../../supabase/functions/_shared/deviceProof";
import type { WebDeviceIdentity } from "./webDeviceIdentity";
import { uuid } from "./validation";

export interface EnrolledDevice {
  accountId: string;
  sessionId: string;
  deviceId: string;
  generation: string;
}
const unavailable = () => new Error("Device could not connect. Try again.");
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailable();
  return value as Record<string, unknown>;
}

/** One signer + enrollment per canonical Auth session, sharing the Chat abort
 * signal. No listener, alternate auth owner, silent key rotation or local-only
 * enrollment. SQL/Edge remain authority and recheck every subsequent request. */
export function createDeviceEnrollment(input: DeviceIdentityScope & { sessionId: string }, signal: AbortSignal, ports: {
  openIdentity(): Promise<WebDeviceIdentity>;
  challenge(publicKey: string): Promise<unknown>;
  commit(challengeId: string, signature: string): Promise<unknown>;
  now?: () => number;
}) {
  const scope = normalizeDeviceScope(input), sessionId = uuid(input.sessionId), now = ports.now ?? Date.now;
  let signer: WebDeviceIdentity | undefined, opening: Promise<WebDeviceIdentity> | undefined;
  let pending: Promise<EnrolledDevice> | undefined, enrolled: EnrolledDevice | undefined;
  const live = () => { if (signal.aborted) throw unavailable(); };
  const close = () => { signer?.close(); signer = undefined; };
  signal.addEventListener("abort", close, { once: true });
  const wait = async <T>(work: Promise<T>): Promise<T> => {
    let abort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => { abort = () => reject(unavailable()); });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    try { const result = await Promise.race([work, cancelled]); live(); return result; }
    finally { signal.removeEventListener("abort", abort); }
  };
  async function identity() {
    live();
    opening ??= ports.openIdentity().then(key => {
      if (signal.aborted) { key.close(); throw unavailable(); }
      signer = key; return key;
    }).catch(error => { opening = undefined; throw error; });
    return await wait(opening);
  }
  async function enroll(): Promise<EnrolledDevice> {
    live();
    const key = await identity();
    if (!/^04[0-9a-f]{128}$/.test(key.publicKey)) throw unavailable();
    const entry = object(await wait(ports.challenge(key.publicKey)));
    if (entry.accountId !== scope.accountId || entry.deviceId !== scope.deviceId
      || entry.sessionId !== sessionId || entry.publicKey !== key.publicKey) throw unavailable();
    const challengeId = uuid(entry.challengeId as string);
    const proof: DeviceChallenge = { version: 1, purpose: "REGISTER", accountId: scope.accountId,
      signerDeviceId: scope.deviceId, peerDeviceId: scope.deviceId, sessionId,
      nonce: entry.nonce as string, channelBinding: "0".repeat(64),
      issuedAt: entry.issuedAt as number, expiresAt: entry.expiresAt as number };
    deviceChallengeBytes(scope, proof, now());
    const signed = await wait(key.sign(proof));
    if (!(signed instanceof ArrayBuffer) || signed.byteLength !== 64) throw unavailable();
    deviceChallengeBytes(scope, proof, now()); live();
    const signature = Array.from(new Uint8Array(signed), byte => byte.toString(16).padStart(2, "0")).join("");
    const result = object(await wait(ports.commit(challengeId, signature)));
    if (result.accountId !== scope.accountId || result.deviceId !== scope.deviceId || result.sessionId !== sessionId) throw unavailable();
    return Object.freeze({ accountId: scope.accountId, sessionId, deviceId: scope.deviceId, generation: uuid(result.generation as string) });
  }
  function ready(): Promise<EnrolledDevice> {
    if (signal.aborted) return Promise.reject(unavailable());
    if (enrolled) return Promise.resolve(enrolled);
    pending ??= enroll().then(value => { live(); enrolled = value; return value; }).finally(() => { pending = undefined; });
    return pending;
  }
  async function signPeer(input: { peerDeviceId: string; transferId: string; nonce: string;
    channelBinding: string }): Promise<{ proof: DeviceChallenge; signature: ArrayBuffer }> {
    // Only an enrolled, still-admitted installation may prove possession. The
    // transfer id is the proof's session binding; the nonce/binding come from
    // the server-admitted session and the locally derived DTLS fingerprints.
    await ready(); live();
    const key = await identity();
    const peerDeviceId = uuid(input.peerDeviceId), transferId = uuid(input.transferId);
    if (peerDeviceId === scope.deviceId) throw unavailable();
    const issuedAt = now();
    const proof: DeviceChallenge = { version: 1, purpose: "PEER", accountId: scope.accountId,
      signerDeviceId: scope.deviceId, peerDeviceId, sessionId: transferId, nonce: input.nonce,
      channelBinding: input.channelBinding, issuedAt, expiresAt: issuedAt + 30_000 };
    deviceChallengeBytes(scope, proof, issuedAt);
    const signature = await wait(key.sign(proof));
    if (!(signature instanceof ArrayBuffer) || signature.byteLength !== 64) throw unavailable();
    deviceChallengeBytes(scope, proof, now()); live();
    return { proof, signature };
  }
  return { ready, signPeer };
}
