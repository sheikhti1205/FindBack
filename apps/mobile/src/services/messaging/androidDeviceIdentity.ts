import { Capacitor, registerPlugin } from "@capacitor/core";
import { deviceChallengeBytes, normalizeDeviceScope, verifyDeviceProof, type DeviceChallenge, type DeviceIdentityScope } from "../../../../../supabase/functions/_shared/deviceProof";
import type { WebDeviceIdentity } from "./webDeviceIdentity";

interface NativeIdentity {
  open(scope: DeviceIdentityScope): Promise<unknown>;
  sign(input: { handle: string; payload: string }): Promise<unknown>;
  close(input: { handle: string }): Promise<unknown>;
}
let bridge: NativeIdentity | undefined;
const unavailable = () => new Error("Device signing is unavailable. Try again.");
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");

/** Keystore-backed Android bridge, not a WebCrypto/native fallback chain. Keys
 * stay in AndroidKeyStore; only public point and an ephemeral handle cross JS.
 * Hardware security level requires real-device evidence, not this source path. */
export async function openAndroidDeviceIdentity(input: DeviceIdentityScope): Promise<WebDeviceIdentity> {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "android") throw unavailable();
  const scope = normalizeDeviceScope(input);
  const native = bridge ??= registerPlugin<NativeIdentity>("NorfoldDeviceIdentity");
  let result: { publicKey?: unknown; handle?: unknown };
  try { result = await native.open(scope) as typeof result; } catch { throw unavailable(); }
  const handle = result?.handle, publicKey = result?.publicKey;
  if (typeof handle !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(handle)) throw unavailable();
  const release = () => { void native.close({ handle }).catch(() => undefined); };
  if (typeof publicKey !== "string" || !/^04[0-9a-f]{128}$/.test(publicKey)) { release(); throw unavailable(); }
  let closed = false;
  return { publicKey, async sign(proof: DeviceChallenge) {
    if (closed) throw unavailable();
    const payload = hex(deviceChallengeBytes(scope, proof, Date.now()).buffer);
    let response: { signature?: unknown };
    try { response = await native.sign({ handle, payload }) as typeof response; } catch { throw unavailable(); }
    if (closed || typeof response?.signature !== "string" || !/^[0-9a-f]{128}$/.test(response.signature)) throw unavailable();
    const signature = Uint8Array.from(response.signature.match(/../g)!, p => parseInt(p, 16)).buffer;
    if (!await verifyDeviceProof(scope, publicKey, proof, signature, { now: Date.now() }) || closed) throw unavailable();
    return signature;
  }, close() { if (closed) return; closed = true; release(); } };
}
