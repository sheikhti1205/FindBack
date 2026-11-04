// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deviceChallengeBytes, verifyDeviceProof, type DeviceChallenge } from "../../../../../supabase/functions/_shared/deviceProof";
const native = vi.hoisted(() => ({ platform: "android", isNative: true, plugin: { open: vi.fn(), sign: vi.fn(), close: vi.fn() }, register: vi.fn() }));
vi.mock("@capacitor/core", () => ({ Capacitor: { getPlatform: () => native.platform, isNativePlatform: () => native.isNative },
  registerPlugin: () => { native.register(); return native.plugin; } }));
const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const scope = { backendUrl: "https://native.example.test", accountId: id(1), deviceId: id(2) };
const handle = "a".repeat(43);
let keys: CryptoKeyPair;
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
const proof = (): DeviceChallenge => ({ version: 1, purpose: "REGISTER", accountId: scope.accountId,
  signerDeviceId: scope.deviceId, peerDeviceId: scope.deviceId, sessionId: id(3), nonce: "a".repeat(64),
  channelBinding: "0".repeat(64), issuedAt: Date.now() - 1, expiresAt: Date.now() + 60_000 });
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); native.isNative = true; native.platform = "android";
  keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  native.plugin.open.mockResolvedValue({ handle, publicKey: hex(await crypto.subtle.exportKey("raw", keys.publicKey)) });
  native.plugin.close.mockResolvedValue(undefined);
  native.plugin.sign.mockImplementation(async ({ payload }: { payload: string }) => ({ signature:
    hex(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey,
      Uint8Array.from(payload.match(/../g)!, p => parseInt(p, 16)))) }));
});
describe("Android identity bridge (synthetic keys, no Keystore/device acceptance)", () => {
  it("passes only canonical domain-separated proof bytes, verifies returned signature and fences close", async () => {
    const { openAndroidDeviceIdentity } = await import("./androidDeviceIdentity");
    const owner = await openAndroidDeviceIdentity(scope), p = proof(), signature = await owner.sign(p);
    expect(native.plugin.open).toHaveBeenCalledWith(scope);
    expect(native.plugin.sign).toHaveBeenCalledWith({ handle, payload: hex(deviceChallengeBytes(scope, p, Date.now()).buffer) });
    expect(await verifyDeviceProof(scope, owner.publicKey, p, signature, { now: Date.now() })).toBe(true);
    owner.close(); await expect(owner.sign(p)).rejects.toThrow();
    expect(native.plugin.close).toHaveBeenCalledWith({ handle });
  });
  it.each([["web", false], ["ios", true]])("rejects %s before registering any native bridge", async (platform, isNative) => {
    native.platform = platform as string; native.isNative = isNative as boolean;
    const { openAndroidDeviceIdentity } = await import("./androidDeviceIdentity");
    await expect(openAndroidDeviceIdentity(scope)).rejects.toThrow();
    expect(native.register).not.toHaveBeenCalled();
  });
  it("rejects tampered/malformed native signatures instead of advertising possession", async () => {
    const { openAndroidDeviceIdentity } = await import("./androidDeviceIdentity");
    const owner = await openAndroidDeviceIdentity(scope);
    native.plugin.sign.mockResolvedValue({ signature: "0".repeat(128) });
    await expect(owner.sign(proof())).rejects.toThrow(); owner.close();
  });
  it("cannot finish a native signature after its session closes", async () => {
    const { openAndroidDeviceIdentity } = await import("./androidDeviceIdentity");
    const owner = await openAndroidDeviceIdentity(scope);
    let release!: (value: { signature: string }) => void;
    native.plugin.sign.mockReturnValue(new Promise(done => { release = done; }));
    const work = owner.sign(proof()); owner.close(); release({ signature: "0".repeat(128) });
    await expect(work).rejects.toThrow();
  });
});
