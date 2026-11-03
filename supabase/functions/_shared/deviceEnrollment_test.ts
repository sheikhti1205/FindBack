import { strict as assert } from "node:assert";
import { completeDeviceEnrollment } from "./deviceEnrollment.ts";
import { deviceChallengeBytes } from "./deviceProof.ts";

// Fresh synthetic keys/claims only; no live JWT/credential/session accesses.
const id = (n: number) => `00000000-0000-4000-9006-${String(n).padStart(12, "0")}`;
const NOW = 1_000_000, backendUrl = "https://synthetic.supabase.co";
async function fixture() {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const publicKey = Array.from(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)), b => b.toString(16).padStart(2, "0")).join("");
  const entry = { challengeId: id(9), accountId: id(1), sessionId: id(2), deviceId: id(3), publicKey,
    nonce: "a".repeat(64), issuedAt: NOW - 1_000, expiresAt: NOW + 30_000 };
  const proof = { version: 1 as const, purpose: "REGISTER" as const, accountId: entry.accountId, signerDeviceId: entry.deviceId,
    peerDeviceId: entry.deviceId, sessionId: entry.sessionId, nonce: entry.nonce, channelBinding: "0".repeat(64), issuedAt: entry.issuedAt, expiresAt: entry.expiresAt };
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey,
    deviceChallengeBytes({ backendUrl, accountId: id(1), deviceId: id(3) }, proof, NOW));
  const body = { challengeId: id(9), signature: Array.from(new Uint8Array(signature), b => b.toString(16).padStart(2, "0")).join("") };
  let commits = 0;
  const ports = { backendUrl, accountId: id(1), sessionId: id(2), now: () => NOW,
    readChallenge: () => Promise.resolve(entry), commit: (_id: string) => { commits++; return Promise.resolve({ deviceId: id(3) }); } };
  return { entry, body, ports, commits: () => commits };
}
Deno.test("server verifies the existing-key signature before the private enrollment commit", async () => {
  const f = await fixture(); const result = await completeDeviceEnrollment(f.body, f.ports);
  assert.deepEqual(result, { deviceId: id(3) }); assert.equal(f.commits(), 1);
});
Deno.test("altered signature/key/nonce/backend/verified session never commits", async () => {
  for (const variant of ["signature", "key", "nonce", "backend", "session", "account", "expiry", "id"]) {
    const f = await fixture();
    if (variant === "signature") f.body.signature = "0".repeat(128);
    if (variant === "key") { const other = await fixture(); f.entry.publicKey = other.entry.publicKey; }
    if (variant === "nonce") f.entry.nonce = "b".repeat(64);
    if (variant === "backend") f.ports.backendUrl = "https://other.supabase.co";
    if (variant === "session") f.ports.sessionId = id(4);
    if (variant === "account") f.ports.accountId = id(4);
    if (variant === "expiry") f.ports.now = () => NOW + 31_000;
    if (variant === "id") f.entry.challengeId = id(4);
    await assert.rejects(() => completeDeviceEnrollment(f.body, f.ports), /Device proof unavailable/);
    assert.equal(f.commits(), 0, variant);
  }
});
Deno.test("exact bounded request refuses arbitrary account/session/key/operation fields", async () => {
  const f = await fixture();
  for (const body of [{ ...f.body, accountId: id(1) }, { ...f.body, sessionId: id(2) },
    { ...f.body, publicKey: f.entry.publicKey }, { challengeId: id(9), signature: [f.body.signature] }, { ...f.body, signature: "a".repeat(129) }]) {
    await assert.rejects(() => completeDeviceEnrollment(body, f.ports));
  }
  assert.equal(f.commits(), 0);
});
Deno.test("revocation/CAS failure in private commit is not converted into success", async () => {
  const f = await fixture(); f.ports.commit = () => Promise.reject(new Error("Device proof unavailable"));
  await assert.rejects(() => completeDeviceEnrollment(f.body, f.ports));
});
