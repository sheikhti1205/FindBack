import { uuid } from "./validation";

interface StatsSource { getStats(): Promise<{ values(): IterableIterator<unknown>; get(id: string): unknown }> }
const unavailable = () => new Error("Peer channel binding unavailable");
function certificate(input: unknown): string {
  if (!input || typeof input !== "object") throw unavailable();
  const value = input as Record<string, unknown>;
  if (value.type !== "certificate" || value.fingerprintAlgorithm !== "sha-256"
    || typeof value.fingerprint !== "string" || !/^(?:[0-9a-fA-F]{2}:){31}[0-9a-fA-F]{2}$/.test(value.fingerprint)) throw unavailable();
  return value.fingerprint.replaceAll(":", "").toLowerCase();
}

/** Read only from the locally owned RTC connection after DTLS negotiation, not
 * remote SDP or a peer's claimed hash. The owner uses a dedicated DataChannel-only
 * connection; ambiguous/missing transport stats fail closed to normal sync.
 * Synthetic stats tests validate derivation, not genuine browser/DTLS acceptance. */
export async function derivePeerChannelBinding(connection: StatsSource, localDeviceId: string, remoteDeviceId: string,
  crypto: Crypto = globalThis.crypto): Promise<string> {
  const local = uuid(localDeviceId), remote = uuid(remoteDeviceId);
  if (local === remote) throw unavailable();
  const stats = await connection.getStats();
  const transports = Array.from(stats.values()).filter(value => value && typeof value === "object"
    && (value as Record<string, unknown>).type === "transport") as Record<string, unknown>[];
  if (transports.length !== 1) throw unavailable();
  const transport = transports[0]!;
  if (transport.dtlsState !== "connected" || typeof transport.localCertificateId !== "string"
    || typeof transport.remoteCertificateId !== "string") throw unavailable();
  const pairs = [[local, certificate(stats.get(transport.localCertificateId))],
    [remote, certificate(stats.get(transport.remoteCertificateId))]].sort((a, b) => a[0]! < b[0]! ? -1 : 1);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(["norfold-dtls-binding", 1, pairs])));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
