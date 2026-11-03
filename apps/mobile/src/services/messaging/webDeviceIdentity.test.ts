// @vitest-environment node
import { webcrypto } from "node:crypto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it } from "vitest";
import { openWebDeviceIdentity, verifyDeviceProof, type DeviceChallenge } from "./webDeviceIdentity";

// Fresh synthetic keys and disposable databases only; never personal credentials.
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { backendUrl: "https://synthetic.supabase.co", accountId: id(1), deviceId: id(2) };
const crypto = webcrypto as unknown as Crypto;
const NOW = 1_000_000;
const opened: Array<{ close(): void }> = [];
afterEach(() => { for (const handle of opened.splice(0)) handle.close(); });
const challenge = (overrides: Partial<DeviceChallenge> = {}): DeviceChallenge => ({
  version: 1, purpose: "PEER", accountId: id(1), signerDeviceId: id(2), peerDeviceId: id(3),
  sessionId: id(4), nonce: "a".repeat(64), channelBinding: "c".repeat(64),
  issuedAt: NOW - 1_000, expiresAt: NOW + 30_000, ...overrides,
});
async function open(factory = new IDBFactory(), owner = scope) {
  const handle = await openWebDeviceIdentity(owner, { indexedDB: factory, crypto, now: () => NOW });
  opened.push(handle); return handle;
}

describe("device-local web identity", () => {
  it("persists the same public identity across close/reopen and never exposes a private key", async () => {
    const factory = new IDBFactory(), first = await open(factory), publicKey = first.publicKey;
    expect(Object.keys(first).sort()).toEqual(["close", "publicKey", "sign"]);
    first.close();
    const second = await open(factory);
    expect(second.publicKey === publicKey).toBe(true);
    const signature = await second.sign(challenge());
    expect(await verifyDeviceProof(scope, publicKey, challenge(), signature, { crypto, now: NOW })).toBe(true);
    await expect(first.sign(challenge())).rejects.toThrow("Device identity is closed");
  });
  it("concurrent opens converge on one persisted installation identity", async () => {
    const factory = new IDBFactory();
    const identities = await Promise.all([open(factory), open(factory), open(factory)]);
    expect(new Set(identities.map(identity => identity.publicKey)).size).toBe(1);
  });
  it("isolates keys by backend, account and installation", async () => {
    const factory = new IDBFactory();
    const identities = await Promise.all([open(factory), open(factory, { ...scope, accountId: id(5) }),
      open(factory, { ...scope, deviceId: id(6) }), open(factory, { ...scope, backendUrl: "https://other.supabase.co" })]);
    expect(new Set(identities.map(identity => identity.publicKey)).size).toBe(4);
  });
  it("stores a non-extractable private CryptoKey rather than exported secret bytes", async () => {
    const factory = new IDBFactory(); await open(factory);
    const request = factory.open("norfold-device-keys-v1", 1);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      const get = db.transaction("identities").objectStore("identities").getAll();
      const records = await new Promise<CryptoKeyPair[]>((resolve, reject) => {
        get.onsuccess = () => resolve(get.result); get.onerror = () => reject(get.error);
      });
      expect(records.length).toBe(1);
      expect(records[0]!.privateKey.extractable).toBe(false);
      await expect(crypto.subtle.exportKey("pkcs8", records[0]!.privateKey)).rejects.toThrow();
    } finally { db.close(); }
  });
  it("fails closed on a mismatched persisted pair without silently replacing it", async () => {
    const factory = new IDBFactory(), identity = await open(factory); identity.close();
    const request = factory.open("norfold-device-keys-v1", 1);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const other = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("identities", "readwrite"), store = transaction.objectStore("identities");
      const read = store.openCursor();
      read.onsuccess = () => {
        const cursor = read.result!;
        const original = cursor.value as CryptoKeyPair;
        cursor.update({ publicKey: original.publicKey, privateKey: other.privateKey });
      };
      transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error);
    });
    db.close();
    await expect(open(factory)).rejects.toThrow("Invalid saved device identity");
    await expect(open(factory)).rejects.toThrow("Invalid saved device identity");
  });
  it.each([
    { accountId: id(5) }, { signerDeviceId: id(5) }, { peerDeviceId: id(2) },
    { expiresAt: NOW - 1 }, { expiresAt: NOW + 300_000 }, { issuedAt: NOW + 10_000 },
    { nonce: "short" }, { nonce: ["a".repeat(64)] }, { sessionId: "not-a-session" }, { version: 2 },
    { channelBinding: "0".repeat(64) }, { channelBinding: "short" },
  ])("rejects invalid or foreign proof fields before signing", async fields => {
    const identity = await open();
    await expect(identity.sign(challenge(fields as Partial<DeviceChallenge>))).rejects.toThrow();
  });
  it("binds signatures to the backend, account, peer and exact session challenge", async () => {
    const identity = await open(), proof = challenge(), signature = await identity.sign(proof);
    for (const changed of [{ peerDeviceId: id(7) }, { sessionId: id(8) }, { nonce: "b".repeat(64) }, { purpose: "REGISTER" as const }]) {
      expect(await verifyDeviceProof(scope, identity.publicKey, challenge(changed), signature, { crypto, now: NOW })).toBe(false);
    }
    expect(await verifyDeviceProof({ ...scope, backendUrl: "https://other.supabase.co" }, identity.publicKey,
      proof, signature, { crypto, now: NOW })).toBe(false);
    expect(await verifyDeviceProof(scope, identity.publicKey, proof, signature, { crypto, now: NOW + 31_000 })).toBe(false);
    expect(await verifyDeviceProof(scope, "bad-key", proof, signature, { crypto, now: NOW })).toBe(false);
  });
  it("binds peer proof to the actual channel rather than an attacker-relayed challenge", async () => {
    const identity = await open();
    const proof = { ...challenge(), channelBinding: "c".repeat(64) } as DeviceChallenge;
    const signature = await identity.sign(proof);
    expect(await verifyDeviceProof(scope, identity.publicKey, proof, signature, { crypto, now: NOW })).toBe(true);
    const changed = { ...proof, channelBinding: "d".repeat(64) } as DeviceChallenge;
    expect(await verifyDeviceProof(scope, identity.publicKey, changed, signature, { crypto, now: NOW })).toBe(false);
  });
  it("rejects unsafe backend URLs rather than sharing an origin's key accidentally", async () => {
    for (const backendUrl of ["http://production.supabase.co", "https://user:password@synthetic.supabase.co", "https://synthetic.supabase.co/path"]) {
      await expect(open(new IDBFactory(), { ...scope, backendUrl })).rejects.toThrow();
    }
  });
  it("signs registration only for its own installation, not a peer session", async () => {
    const identity = await open(), proof = challenge({ purpose: "REGISTER", peerDeviceId: id(2), channelBinding: "0".repeat(64) });
    const signature = await identity.sign(proof);
    expect(await verifyDeviceProof(scope, identity.publicKey, proof, signature, { crypto, now: NOW })).toBe(true);
    await expect(identity.sign(challenge({ purpose: "REGISTER" }))).rejects.toThrow();
  });
});
