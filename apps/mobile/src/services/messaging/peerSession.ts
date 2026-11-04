import { normalizeDeviceScope, verifyDeviceProof, type DeviceChallenge, type DeviceIdentityScope }
  from "../../../../../supabase/functions/_shared/deviceProof";
import { derivePeerChannelBinding } from "./peerChannelBinding";
import { diffPeerManifest, parsePeerManifest, type PeerManifest, type PeerManifestDiff } from "./peerManifest";
import type { PeerTransferChannel } from "./peerTransfer";
import { isUuid, uuid } from "./validation";

/** Server-admitted peer session returned by findback_peer_signal OPEN/READ. */
export interface PeerSessionInfo {
  accountId: string;
  sessionId: string;
  initiatorDeviceId: string;
  targetDeviceId: string;
  peerPublicKey: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
}
export interface PeerSignal { position: number; type: "offer" | "answer" | "candidate"; data: Record<string, unknown> }
export interface PeerDescription { type: "offer" | "answer"; sdp: string }
export interface PeerIceCandidate { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null }
export interface PeerStats { values(): IterableIterator<unknown>; get(id: string): unknown }

/** Mirrors RTCPeerConnection; the production adapter lives in this module. */
export interface PeerConnectionPort {
  readonly connectionState: string;
  onicecandidate: ((event: { candidate: PeerIceCandidate | null }) => void) | null;
  ondatachannel: ((event: { channel: PeerTransferChannel }) => void) | null;
  createDataChannel(label: string, options: { ordered: boolean }): PeerTransferChannel;
  createOffer(): Promise<PeerDescription>;
  createAnswer(): Promise<PeerDescription>;
  setLocalDescription(description: PeerDescription): Promise<void>;
  setRemoteDescription(description: PeerDescription): Promise<void>;
  addIceCandidate(candidate: PeerIceCandidate): Promise<void>;
  getStats(): Promise<PeerStats>;
  close(): void;
}

export interface PeerSignalingPort {
  open(targetDeviceId: string, signal: AbortSignal): Promise<unknown>;
  write(sessionId: string, type: PeerSignal["type"], data: unknown, signal: AbortSignal): Promise<unknown>;
  read(sessionId: string, after: number, signal: AbortSignal): Promise<unknown>;
  close(sessionId: string, signal: AbortSignal): Promise<void>;
}

export interface PeerSessionPorts {
  signal: AbortSignal;
  backendUrl: string;
  /** findback_devices LIST: current account-owned installations only. */
  devices(signal: AbortSignal): Promise<unknown>;
  signaling: PeerSignalingPort;
  connection(): PeerConnectionPort;
  /** Session-owned signer; the returned proof must be a PEER challenge. */
  signPeer(input: { peerDeviceId: string; transferId: string; nonce: string; channelBinding: string },
    signal: AbortSignal): Promise<{ proof: DeviceChallenge; signature: ArrayBuffer }>;
  /** Locally built, read-only description of what this device can offer. */
  manifest(): Promise<PeerManifest>;
  /** Conversations/media already visible locally; never used to grant authority. */
  known(): { conversations: readonly string[]; media: readonly string[] };
  onFailure?(): void;
  crypto?: Crypto;
  now?(): number;
  sleep?(ms: number): Promise<void>;
  timeoutMs?: number;
  pollMs?: number;
}

export interface PeerSession {
  readonly accountId: string;
  readonly deviceId: string;
  readonly peerDeviceId: string;
  readonly sessionId: string;
  /** SHA-256 over both actual DTLS certificate fingerprints, never SDP claims. */
  readonly channelBinding: string;
  readonly plan: PeerManifestDiff;
  /** Both sides' content-free manifests, exactly as exchanged. */
  readonly localManifest: PeerManifest;
  readonly remoteManifest: PeerManifest;
  readonly channel: PeerTransferChannel;
  close(): void;
}

export interface PeerSessionInput { accountId: string; deviceId: string; targetDeviceId: string; sessionId?: string }

const unavailable = () => new Error("Peer sync is unavailable");
const MAX_MESSAGE = 64 * 1024 + 4_096;
const MAX_PROOF_AGE = 120_000;
const PUBLIC_KEY = /^04[0-9a-f]{128}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const FINGERPRINT = /a=fingerprint:sha-256 [0-9A-Fa-f:]+/;

function exact(input: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).length !== fields.length || fields.some(field => !Object.hasOwn(input, field))) throw unavailable();
  return input as Record<string, unknown>;
}
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw unavailable();
  return value;
}
function sdp(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 65_536
    || !value.startsWith("v=0") || !FINGERPRINT.test(value)) throw unavailable();
  return value;
}
function sessionInfo(input: unknown, scope: DeviceIdentityScope, now: number, withSignals = false): PeerSessionInfo {
  const value = exact(input, ["accountId", "sessionId", "initiatorDeviceId", "targetDeviceId",
    "peerPublicKey", "nonce", "issuedAt", "expiresAt", ...(withSignals ? ["signals"] : [])]);
  if (value.accountId !== scope.accountId || !isUuid(value.sessionId)
    || !isUuid(value.initiatorDeviceId) || !isUuid(value.targetDeviceId)
    || value.initiatorDeviceId === value.targetDeviceId
    || (value.initiatorDeviceId !== scope.deviceId && value.targetDeviceId !== scope.deviceId)
    || typeof value.peerPublicKey !== "string" || !PUBLIC_KEY.test(value.peerPublicKey)
    || typeof value.nonce !== "string" || !SHA256.test(value.nonce)) throw unavailable();
  const issuedAt = integer(value.issuedAt, 0, Number.MAX_SAFE_INTEGER);
  const expiresAt = integer(value.expiresAt, 0, Number.MAX_SAFE_INTEGER);
  // A short, server-issued lifetime bounds stale/replayed signaling.
  if (expiresAt <= now || issuedAt > now + 5_000 || expiresAt - issuedAt > MAX_PROOF_AGE) throw unavailable();
  return { accountId: scope.accountId, sessionId: uuid(value.sessionId),
    initiatorDeviceId: uuid(value.initiatorDeviceId), targetDeviceId: uuid(value.targetDeviceId),
    peerPublicKey: value.peerPublicKey, nonce: value.nonce, issuedAt, expiresAt };
}
function candidate(input: unknown): PeerIceCandidate {
  const value = exact(input, ["candidate", "sdpMid", "sdpMLineIndex"]);
  if (typeof value.candidate !== "string" || value.candidate.length > 2_048
    || (value.candidate !== "" && !value.candidate.startsWith("candidate:"))
    || !(value.sdpMid === null || typeof value.sdpMid === "string" && value.sdpMid.length <= 64)
    || !(value.sdpMLineIndex === null || Number.isSafeInteger(value.sdpMLineIndex)
      && (value.sdpMLineIndex as number) >= 0 && (value.sdpMLineIndex as number) <= 16)) throw unavailable();
  return { candidate: value.candidate, sdpMid: value.sdpMid as string | null, sdpMLineIndex: value.sdpMLineIndex as number | null };
}
function signalList(input: unknown, after: number): PeerSignal[] {
  if (!Array.isArray(input) || input.length > 64) throw unavailable();
  let position = after;
  return input.map(entry => {
    const value = exact(entry, ["position", "type", "data"]);
    const next = integer(value.position, after + 1, 64);
    if (next <= position || !["offer", "answer", "candidate"].includes(value.type as string)
      || !value.data || typeof value.data !== "object" || Array.isArray(value.data)) throw unavailable();
    position = next;
    const type = value.type as PeerSignal["type"], data = value.data as Record<string, unknown>;
    if (type === "candidate") candidate(data); else sdp(data.sdp);
    return { position: next, type, data };
  });
}
function roster(input: unknown, scope: DeviceIdentityScope, targetDeviceId: string): void {
  if (!Array.isArray(input) || input.length > 64) throw unavailable();
  let self = false, target = 0;
  for (const entry of input) {
    const value = exact(entry, ["deviceId", "name", "platform", "lastSeenAt", "current"]);
    if (!isUuid(value.deviceId) || typeof value.name !== "string" || typeof value.platform !== "string"
      || typeof value.current !== "boolean" || !Number.isSafeInteger(value.lastSeenAt)) throw unavailable();
    if (value.deviceId === scope.deviceId) self = value.current === true;
    if (value.deviceId === targetDeviceId) target++;
  }
  // Only a current, key-enrolled roster is usable; the peer must still exist.
  if (!self || target !== 1) throw unavailable();
}
function signature(value: unknown): ArrayBuffer {
  if (typeof value !== "string" || !/^[0-9a-f]{128}$/.test(value)) throw unavailable();
  return Uint8Array.from(value.match(/../g)!, pair => Number.parseInt(pair, 16)).buffer;
}
function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}
function challenge(input: unknown): DeviceChallenge {
  const value = exact(input, ["version", "purpose", "accountId", "signerDeviceId", "peerDeviceId",
    "sessionId", "nonce", "channelBinding", "issuedAt", "expiresAt"]);
  if (value.version !== 1 || !["REGISTER", "PEER"].includes(value.purpose as string)
    || typeof value.accountId !== "string" || typeof value.signerDeviceId !== "string"
    || typeof value.peerDeviceId !== "string" || !isUuid(value.sessionId)
    || typeof value.nonce !== "string" || typeof value.channelBinding !== "string") throw unavailable();
  return { version: 1, purpose: value.purpose as DeviceChallenge["purpose"],
    accountId: value.accountId, signerDeviceId: value.signerDeviceId, peerDeviceId: value.peerDeviceId,
    sessionId: uuid(value.sessionId), nonce: value.nonce, channelBinding: value.channelBinding,
    issuedAt: integer(value.issuedAt, 0, Number.MAX_SAFE_INTEGER),
    expiresAt: integer(value.expiresAt, 0, Number.MAX_SAFE_INTEGER) };
}

/**
 * Opens one same-account peer session: server-admitted signaling, an ordered
 * DataChannel, locally derived DTLS binding, mutual PEER proofs and a bounded
 * manifest exchange. It never writes history or media; the caller performs
 * repair through canonical paths and hands the channel to createPeerTransfer.
 * Any ambiguity fails closed to the ordinary server sync.
 */
export async function openPeerSession(input: PeerSessionInput, ports: PeerSessionPorts): Promise<PeerSession> {
  const scope = normalizeDeviceScope({ backendUrl: ports.backendUrl, accountId: input.accountId, deviceId: input.deviceId });
  const targetDeviceId = uuid(input.targetDeviceId);
  if (targetDeviceId === scope.deviceId) throw unavailable();
  const now = ports.now ?? Date.now, crypto = ports.crypto ?? globalThis.crypto;
  const sleep = ports.sleep ?? ((ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); }));
  const timeout = ports.timeoutMs ?? 60_000, poll = ports.pollMs ?? 250;
  if (!Number.isSafeInteger(timeout) || timeout < 5_000 || timeout > 60_000
    || !Number.isSafeInteger(poll) || poll < 50 || poll > 2_000) throw unavailable();

  const lifetime = new AbortController();
  const abort = () => lifetime.abort();
  if (ports.signal.aborted) throw unavailable();
  ports.signal.addEventListener("abort", abort, { once: true });
  const live = () => { if (ports.signal.aborted || lifetime.signal.aborted) throw unavailable(); };
  const deadline = now() + timeout;
  const remaining = () => { const left = deadline - now(); if (left <= 0) throw unavailable(); return left; };

  let connection: PeerConnectionPort | undefined, sessionId: string | undefined, closed = false;
  const close = (failed: boolean) => {
    if (closed) return;
    closed = true;
    lifetime.abort();
    ports.signal.removeEventListener("abort", abort);
    try { connection?.close(); } catch { /* transport teardown is best effort */ }
    if (sessionId) {
      const id = sessionId;
      // Signaling cleanup never authorizes anything and must not mask failure.
      void Promise.resolve().then(() => ports.signaling.close(id, new AbortController().signal)).catch(() => undefined);
    }
    if (failed) { try { ports.onFailure?.(); } catch { /* fallback belongs to the caller */ } }
  };

  try {
    roster(await ports.devices(lifetime.signal), scope, targetDeviceId); live();
    // INITIATOR: OPEN creates the server-admitted session. TARGET: the id was
    // delivered out of band (wake/UI); adopt it with one READ that also carries
    // the already-written offer, never a second session or a competing owner.
    let adopted: PeerSignal[] | undefined;
    let info: PeerSessionInfo;
    if (input.sessionId !== undefined) {
      const adopt = uuid(input.sessionId);
      const page = await ports.signaling.read(adopt, 0, lifetime.signal);
      live();
      info = sessionInfo(page, scope, now(), true);
      if (info.sessionId !== adopt) throw unavailable();
      adopted = signalList((page as Record<string, unknown>).signals, 0);
    } else {
      info = sessionInfo(await ports.signaling.open(targetDeviceId, lifetime.signal), scope, now());
    }
    sessionId = info.sessionId;
    const initiator = info.initiatorDeviceId === scope.deviceId;
    const peerDeviceId = initiator ? info.targetDeviceId : info.initiatorDeviceId;
    if (peerDeviceId !== targetDeviceId) throw unavailable();

    const conn = ports.connection();
    connection = conn;
    const queued: PeerIceCandidate[] = [];
    conn.onicecandidate = event => {
      if (closed || !event.candidate || event.candidate.candidate === "") return;
      if (queued.length >= 256) { close(true); return; }
      queued.push(candidate(event.candidate));
    };
    let channel: PeerTransferChannel | undefined;
    // Messages can legitimately arrive before this side reaches the handshake
    // (the peer may finish negotiation first). Buffer them, bounded, so an early
    // proof/manifest can never be lost by a not-yet-attached listener.
    const early: unknown[] = [];
    let earlyBytes = 0;
    const sink: { deliver: ((data: unknown) => void) | null } = { deliver: null };
    const onEarly = (event: Event) => {
      const data = (event as MessageEvent).data;
      if (sink.deliver) { sink.deliver(data); return; }
      const size = typeof data === "string" ? data.length : MAX_MESSAGE;
      if (early.length >= 16 || earlyBytes + size > 2 * MAX_MESSAGE) { close(true); return; }
      earlyBytes += size; early.push(data);
    };
    conn.ondatachannel = event => {
      if (closed) return;
      channel = event.channel;
      channel.addEventListener("message", onEarly);
    };

    let after = 0, answered = false, remoteSet = false, seeded = adopted;
    const drain = async () => {
      let signals: PeerSignal[];
      if (seeded) { signals = seeded; seeded = undefined; }
      else {
        const page = await ports.signaling.read(info.sessionId, after, lifetime.signal);
        live();
        if (!page || typeof page !== "object" || Array.isArray(page)) throw unavailable();
        signals = signalList((page as Record<string, unknown>).signals, after);
      }
      for (const signal of signals) {
        after = signal.position;
        if (signal.type === "candidate") { await conn.addIceCandidate(candidate(signal.data)); continue; }
        // Exactly one offer and one answer; any second description is a changed
        // negotiation and must not be adopted mid-session.
        if (remoteSet) throw unavailable();
        if (signal.type === "offer") {
          if (initiator) throw unavailable();
          await conn.setRemoteDescription({ type: "offer", sdp: sdp(signal.data.sdp) });
          const answer = await conn.createAnswer();
          await conn.setLocalDescription(answer);
          await ports.signaling.write(info.sessionId, "answer", { sdp: answer.sdp }, lifetime.signal);
          answered = true;
        } else {
          if (!initiator) throw unavailable();
          await conn.setRemoteDescription({ type: "answer", sdp: sdp(signal.data.sdp) });
        }
        remoteSet = true;
      }
      while (queued.length) await ports.signaling.write(info.sessionId, "candidate", queued.shift(), lifetime.signal);
      live();
    };

    if (initiator) {
      channel = conn.createDataChannel("norfold-sync-v1", { ordered: true });
      channel.addEventListener("message", onEarly);
      const offer = await conn.createOffer();
      await conn.setLocalDescription(offer);
      await ports.signaling.write(info.sessionId, "offer", { sdp: offer.sdp }, lifetime.signal);
    }
    // ICE/description exchange proceeds until both sides see an open channel and
    // the remote description has been adopted. The final drain flushes our
    // trailing ICE candidates and adopts the peer's.
    while (!channel || channel.readyState !== "open" || !remoteSet) {
      remaining(); await drain(); live();
      if (channel?.readyState === "open" && remoteSet) break;
      await sleep(Math.min(poll, remaining()));
    }
    await drain();
    if (!remoteSet || (!initiator && !answered)) throw unavailable();
    if (!channel) throw unavailable();
    const transport = channel;
    if (transport.protocol !== "norfold-sync-v1" || !transport.ordered
      || transport.maxRetransmits !== null || transport.maxPacketLifeTime !== null) throw unavailable();

    const channelBinding = await derivePeerChannelBinding(conn, scope.deviceId, peerDeviceId, crypto);
    live();
    const transferId = uuid(crypto.randomUUID());
    const local = await ports.signPeer({ peerDeviceId, transferId, nonce: info.nonce, channelBinding }, lifetime.signal);
    live();
    const localManifest = await ports.manifest();
    transport.send(JSON.stringify({ version: 1, type: "PROOF", transferId,
      proof: local.proof, signature: hex(local.signature) }));
    transport.send(JSON.stringify({ version: 1, type: "MANIFEST", manifest: localManifest }));

    const result = await new Promise<{ proof: DeviceChallenge; signature: ArrayBuffer; manifest: PeerManifest }>(
      (resolve, reject) => {
        let proof: DeviceChallenge | undefined, proofSignature: ArrayBuffer | undefined, manifest: PeerManifest | undefined;
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          sink.deliver = null;
          clearTimeout(timer);
          transport.removeEventListener("message", onEarly);
          transport.removeEventListener("close", onClose);
          transport.removeEventListener("error", onClose);
          lifetime.signal.removeEventListener("abort", onAbort);
          if (error) reject(error);
          else resolve({ proof: proof!, signature: proofSignature!, manifest: manifest! });
        };
        const onAbort = () => finish(unavailable());
        const onClose = () => finish(unavailable());
        function handle(data: unknown) {
          try {
            if (typeof data !== "string" || data.length > MAX_MESSAGE) throw unavailable();
            const value = JSON.parse(data) as Record<string, unknown>;
            if (value.type === "PROOF") {
              if (proof) throw unavailable(); // replay
              exact(value, ["version", "type", "transferId", "proof", "signature"]);
              if (value.version !== 1 || !isUuid(value.transferId)) throw unavailable();
              const remoteTransferId = uuid(value.transferId as string);
              proofSignature = signature(value.signature);
              proof = challenge(value.proof);
              // The transfer id, channel binding and server nonce tie this proof
              // to exactly this connection and admitted session.
              if (proof.purpose !== "PEER" || proof.accountId !== scope.accountId
                || proof.signerDeviceId !== peerDeviceId || proof.peerDeviceId !== scope.deviceId
                || proof.sessionId !== remoteTransferId || proof.nonce !== info.nonce
                || proof.channelBinding !== channelBinding) throw unavailable();
            } else if (value.type === "MANIFEST") {
              if (manifest) throw unavailable();
              exact(value, ["version", "type", "manifest"]);
              if (value.version !== 1) throw unavailable();
              manifest = parsePeerManifest(value.manifest, { accountId: scope.accountId, deviceId: peerDeviceId }, now());
            } else throw unavailable();
            if (proof && proofSignature && manifest) finish();
          } catch { finish(unavailable()); }
        }
        const timer = setTimeout(() => finish(unavailable()), remaining());
        transport.addEventListener("close", onClose);
        transport.addEventListener("error", onClose);
        lifetime.signal.addEventListener("abort", onAbort);
        sink.deliver = handle;
        for (const pendingMessage of early.splice(0)) handle(pendingMessage);
      });
    live();
    if (!await verifyDeviceProof({ backendUrl: scope.backendUrl, accountId: scope.accountId, deviceId: peerDeviceId },
      info.peerPublicKey, result.proof, result.signature, { crypto, now: now() })) throw unavailable();
    live();
    const plan = diffPeerManifest(localManifest, ports.known(), result.manifest, now());
    const owner = () => close(false);
    return Object.freeze({ accountId: scope.accountId, deviceId: scope.deviceId, peerDeviceId,
      sessionId: info.sessionId, channelBinding, plan, localManifest, remoteManifest: result.manifest,
      channel: transport, close: owner });
  } catch (error) {
    close(true);
    // One fail-closed error for every transport/signaling/authority ambiguity.
    throw error instanceof Error && error.message === "Peer sync is unavailable" ? error : unavailable();
  }
}

/** Production adapter over the platform RTCPeerConnection. No WebRTC means the
 * optional transport is unavailable, so callers continue on canonical sync. */
export function browserPeerConnection(): PeerConnectionPort {
  if (typeof RTCPeerConnection === "undefined") throw new Error("Peer transport unavailable");
  const connection = new RTCPeerConnection({ iceServers: [] });
  return {
    get connectionState() { return connection.connectionState; },
    onicecandidate: null,
    ondatachannel: null,
    createDataChannel(label, options) { return connection.createDataChannel(label, options) as PeerTransferChannel; },
    async createOffer() { const offer = await connection.createOffer();
      return { type: "offer", sdp: offer.sdp ?? "" }; },
    async createAnswer() { const answer = await connection.createAnswer();
      return { type: "answer", sdp: answer.sdp ?? "" }; },
    async setLocalDescription(value) { await connection.setLocalDescription(value); },
    async setRemoteDescription(value) { await connection.setRemoteDescription(value); },
    async addIceCandidate(value) { await connection.addIceCandidate(value); },
    async getStats() { return connection.getStats(); },
    close() { connection.close(); },
  };
}
