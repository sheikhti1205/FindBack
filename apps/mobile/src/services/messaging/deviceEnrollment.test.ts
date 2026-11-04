// @vitest-environment node
import { describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { createDeviceEnrollment } from "./deviceEnrollment";
import { openWebDeviceIdentity, verifyDeviceProof, type DeviceChallenge } from "./webDeviceIdentity";

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const scope = { backendUrl: "https://enrollment.example.test", accountId: id(1), deviceId: id(2) };
const sessionId = id(3), generation = id(4);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  const controller = new AbortController(), indexedDB = new IDBFactory();
  const released = deferred<void>();
  let challengeCalls = 0, commits = 0, closed = 0;
  let challenge: Record<string, unknown>;
  const ports = {
    openIdentity: async () => {
      const signer = await openWebDeviceIdentity(scope, { indexedDB });
      return { publicKey: signer.publicKey, sign: signer.sign, close() { closed++; signer.close(); released.resolve(); } };
    },
    challenge: async (publicKey: string) => {
      challengeCalls++;
      challenge = { challengeId: id(5), ...scope, sessionId, publicKey, nonce: "a".repeat(64),
        issuedAt: Date.now() - 1, expiresAt: Date.now() + 60_000 };
      return challenge;
    },
    commit: async (challengeId: string, signature: string) => {
      expect(challengeId).toBe(id(5));
      const proof: DeviceChallenge = { version: 1, purpose: "REGISTER", accountId: scope.accountId,
        signerDeviceId: scope.deviceId, peerDeviceId: scope.deviceId, sessionId,
        nonce: challenge.nonce as string, channelBinding: "0".repeat(64),
        issuedAt: challenge.issuedAt as number, expiresAt: challenge.expiresAt as number };
      const bytes = Uint8Array.from(signature.match(/../g)!, pair => parseInt(pair, 16)).buffer;
      expect(await verifyDeviceProof(scope, challenge.publicKey as string, proof, bytes, { now: Date.now() })).toBe(true);
      commits++;
      return { accountId: scope.accountId, sessionId, deviceId: scope.deviceId, generation };
    },
  };
  const open = () => createDeviceEnrollment({ ...scope, sessionId }, controller.signal, ports);
  return { ports, controller, open, released, publicKey: () => challenge.publicKey as string,
    counts: () => ({ challengeCalls, commits, closed }) };
}
describe("session-owned signed device enrollment", () => {
  it("coalesces callers, verifies the real persistent signer and closes on session abort", async () => {
    const f = fixture(), owner = f.open();
    const [a, b] = await Promise.all([owner.ready(), owner.ready()]);
    expect(a).toEqual({ accountId: scope.accountId, sessionId, deviceId: scope.deviceId, generation });
    expect(b).toEqual(a);
    expect(f.counts()).toEqual({ challengeCalls: 1, commits: 1, closed: 0 });
    f.controller.abort();
    expect(f.counts().closed).toBe(1);
    await expect(owner.ready()).rejects.toThrow();
  });
  it.each(["accountId", "deviceId", "sessionId", "publicKey"])("rejects a substituted challenge %s before signing/commit", async field => {
    const f = fixture(), real = f.ports.challenge;
    f.ports.challenge = async publicKey => ({ ...await real(publicKey), [field]: id(9) });
    await expect(f.open().ready()).rejects.toThrow();
    expect(f.counts().commits).toBe(0);
    f.controller.abort();
  });
  it("never commits after session cancellation while key opening finishes late", async () => {
    const f = fixture(), real = f.ports.openIdentity, pending = deferred<void>();
    f.ports.openIdentity = async () => { await pending.promise; return real(); };
    const ready = f.open().ready();
    f.controller.abort();
    await expect(ready).rejects.toThrow();
    pending.resolve();
    await f.released.promise;
    expect(f.counts()).toEqual({ challengeCalls: 0, commits: 0, closed: 1 });
  });
  it("retries an uncertain response with the same persisted identity, not a new installation", async () => {
    const f = fixture(), real = f.ports.commit;
    let failed = false;
    f.ports.commit = async (...args) => { const result = await real(...args); if (!failed) { failed = true; throw new Error("lost response"); } return result; };
    const owner = f.open();
    await expect(owner.ready()).rejects.toThrow();
    await expect(owner.ready()).resolves.toMatchObject({ generation });
    expect(f.counts().challengeCalls).toBe(2);
    f.controller.abort();
  });
  it("rejects another session's successful commit response", async () => {
    const f = fixture(), real = f.ports.commit;
    f.ports.commit = async (...args) => ({ ...await real(...args), sessionId: id(9) });
    await expect(f.open().ready()).rejects.toThrow();
    f.controller.abort();
  });
  it("signs PEER proofs bound to the peer, transfer, nonce and DTLS channel", async () => {
    const f = fixture(), owner = f.open(), peerDeviceId = id(6);
    await owner.ready();
    const transferId = id(7), nonce = "b".repeat(64), channelBinding = "c".repeat(64);
    const { proof, signature } = await owner.signPeer({ peerDeviceId, transferId, nonce, channelBinding });
    expect(proof).toEqual({ version: 1, purpose: "PEER", accountId: scope.accountId,
      signerDeviceId: scope.deviceId, peerDeviceId, sessionId: transferId, nonce, channelBinding,
      issuedAt: expect.any(Number), expiresAt: expect.any(Number) });
    expect(await verifyDeviceProof(scope, f.publicKey(), proof, signature, { now: Date.now() })).toBe(true);
    // Neither the channel binding nor the peer device can be swapped after signing.
    expect(await verifyDeviceProof(scope, f.publicKey(), { ...proof, channelBinding: "d".repeat(64) },
      signature, { now: Date.now() })).toBe(false);
    expect(await verifyDeviceProof(scope, f.publicKey(), { ...proof, peerDeviceId: id(8) },
      signature, { now: Date.now() })).toBe(false);
    await expect(owner.signPeer({ peerDeviceId: scope.deviceId, transferId, nonce, channelBinding }))
      .rejects.toThrow();
    f.controller.abort();
    await expect(owner.signPeer({ peerDeviceId, transferId, nonce, channelBinding })).rejects.toThrow();
  });
});
