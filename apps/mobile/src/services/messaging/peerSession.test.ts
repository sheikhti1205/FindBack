// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { IDBFactory } from "fake-indexeddb";
import type { DeviceChallenge } from "../../../../../supabase/functions/_shared/deviceProof";
import { openWebDeviceIdentity } from "./webDeviceIdentity";
import type { PeerManifest } from "./peerManifest";
import type { PeerTransferChannel } from "./peerTransfer";
import {
  browserPeerConnection, openPeerSession, type PeerConnectionPort, type PeerIceCandidate, type PeerSessionPorts,
  type PeerSignal, type PeerSignalingPort, type PeerStats,
} from "./peerSession";

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const accountId = id(1), deviceA = id(2), deviceB = id(3), otherPeerId = id(4), conversationId = id(10);
const backendUrl = "https://peer.example.test";
const fingerprint = (pair: string) => Array(32).fill(pair).join(":");
const sdpFor = (pair: string) => `v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=fingerprint:sha-256 ${fingerprint(pair)}\r\n`;

describe("production peer adapter", () => {
  it("forwards native ICE and datachannel events and negotiates the required protocol", () => {
    let ice: ((event: { candidate: PeerIceCandidate | null }) => void) | null = null;
    let channel: ((event: { channel: PeerTransferChannel }) => void) | null = null;
    const native = {
      get onicecandidate() { return ice; }, set onicecandidate(value) { ice = value; },
      get ondatachannel() { return channel; }, set ondatachannel(value) { channel = value; },
      createDataChannel: (label: string, options: RTCDataChannelInit) => {
        expect(label).toBe("norfold-sync-v1");
        expect(options).toEqual({ ordered: true, protocol: "norfold-sync-v1" });
        return incoming;
      },
      close: () => undefined,
    };
    const incoming = new FakeChannel();
    vi.stubGlobal("RTCPeerConnection", function () { return native; });
    try {
      const adapter = browserPeerConnection();
      const candidates: Array<PeerIceCandidate | null> = [], channels: PeerTransferChannel[] = [];
      adapter.onicecandidate = event => candidates.push(event.candidate);
      adapter.ondatachannel = event => channels.push(event.channel);
      const candidate = { candidate: "candidate:1", sdpMid: "0", sdpMLineIndex: 0 };
      native.onicecandidate?.({ candidate });
      native.ondatachannel?.({ channel: incoming });
      expect(candidates).toEqual([candidate]);
      expect(channels).toEqual([incoming]);
      expect(adapter.createDataChannel("norfold-sync-v1", { ordered: true, protocol: "norfold-sync-v1" })).toBe(incoming);
      adapter.close();
      native.onicecandidate?.({ candidate });
      expect(candidates).toHaveLength(1);
    } finally { vi.unstubAllGlobals(); }
  });
});

function manifest(deviceId: string, headPosition: number, withMedia = false): PeerManifest {
  return { version: 1, accountId, deviceId, generatedAt: Date.now(),
    conversations: [{ conversationId, peerId: otherPeerId, revision: 1, epoch: "e1", headPosition }],
    stateSequence: 3,
    media: withMedia ? [{ attachmentId: id(40), conversationId, messageId: id(41), sha256: "a".repeat(64),
      byteSize: 10, mime: "image/png", width: 1, height: 1, expiresAt: Date.now() + 60_000 }] : [] };
}

class FakeChannel extends EventTarget implements PeerTransferChannel {
  readyState = "open";
  readonly ordered = true;
  readonly maxRetransmits = null;
  readonly maxPacketLifeTime = null;
  readonly protocol = "norfold-sync-v1";
  binaryType: "arraybuffer" | "blob" = "arraybuffer";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  peer!: FakeChannel;
  send(data: string | ArrayBuffer) {
    if (this.readyState !== "open") throw new Error("channel closed");
    queueMicrotask(() => {
      if (this.peer.readyState === "open") this.peer.dispatchEvent(new MessageEvent("message", { data }));
    });
  }
  close() {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
    this.peer.close();
  }
}

class FakeConnection implements PeerConnectionPort {
  connectionState = "connecting";
  onicecandidate: ((event: { candidate: PeerIceCandidate | null }) => void) | null = null;
  ondatachannel: ((event: { channel: PeerTransferChannel }) => void) | null = null;
  channel?: FakeChannel;
  pending?: FakeChannel;
  peer!: FakeConnection;
  constructor(readonly local: string, readonly remote: string, readonly role: "initiator" | "target") {}
  createDataChannel(_label: string, options: { ordered: boolean; protocol: string }): FakeChannel {
    expect(options.protocol).toBe("norfold-sync-v1");
    const first = new FakeChannel(), second = new FakeChannel();
    first.peer = second; second.peer = first;
    this.channel = first; this.connectionState = "connected"; this.peer.connectionState = "connected";
    // Delivered only once the remote peer adopts the offer, as real WebRTC does.
    this.peer.pending = second;
    return first;
  }
  async createOffer() { return { type: "offer" as const, sdp: sdpFor(this.local) }; }
  async createAnswer() { return { type: "answer" as const, sdp: sdpFor(this.local) }; }
  async setLocalDescription() { /* local SDP is not a binding source */ }
  async setRemoteDescription(value: { type: string }) {
    if (value.type !== "offer" || !this.pending) return;
    const channel = this.pending;
    this.pending = undefined;
    queueMicrotask(() => this.ondatachannel?.({ channel }));
  }
  async addIceCandidate() { /* fake transport does not trickle */ }
  async getStats(): Promise<PeerStats> {
    const values = new Map<string, unknown>([
      ["transport", { type: "transport", dtlsState: "connected",
        localCertificateId: "local", remoteCertificateId: "remote" }],
      ["local", { type: "certificate", fingerprintAlgorithm: "sha-256", fingerprint: fingerprint(this.local) }],
      ["remote", { type: "certificate", fingerprintAlgorithm: "sha-256", fingerprint: fingerprint(this.remote) }],
    ]);
    return values as unknown as PeerStats;
  }
  close() { this.channel?.close(); }
}
function connectionPair(a: FakeConnection, b: FakeConnection) {
  a.peer = b; b.peer = a; return { a, b };
}

interface BusSession {
  id: string; initiator: string; target: string; nonce: string;
  issuedAt: number; expiresAt: number;
  signals: Array<PeerSignal & { sender: string }>;
}
class Bus {
  readonly sessions = new Map<string, BusSession>();
  openCalls = 0;
  constructor(readonly keys: Record<string, string>, readonly ttl = 60_000,
    readonly accounts?: Record<string,string>) {}
  private info(session: BusSession, deviceId: string) {
    const peer = session.initiator === deviceId ? session.target : session.initiator;
    return { accountId:this.accounts?.[deviceId]??accountId, sessionId: session.id, initiatorDeviceId: session.initiator,
      targetDeviceId: session.target, peerPublicKey: this.keys[peer]!, nonce: session.nonce,
      issuedAt: session.issuedAt, expiresAt: session.expiresAt,
      ...(this.accounts ? {peerAccountId:this.accounts[peer],conversationId,epoch:"a".repeat(64)} : {}) };
  }
  latest() { return [...this.sessions.values()].at(-1); }
  port(deviceId: string): PeerSignalingPort {
    return {
      open: async (target: string) => {
        this.openCalls++;
        if (target === deviceId) throw new Error("own device");
        const issuedAt = Date.now();
        const session: BusSession = { id: randomUUID(), initiator: deviceId, target,
          nonce: randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""),
          issuedAt, expiresAt: issuedAt + this.ttl, signals: [] };
        this.sessions.set(session.id, session);
        return this.info(session, deviceId);
      },
      write: async (sessionId, type, data) => {
        const session = this.sessions.get(sessionId);
        if (!session || Date.now() > session.expiresAt) throw new Error("Peer unavailable");
        if (session.initiator !== deviceId && session.target !== deviceId) throw new Error("Peer unavailable");
        if (type === "offer" && deviceId !== session.initiator) throw new Error("role");
        if (type === "answer" && deviceId !== session.target) throw new Error("role");
        const position = session.signals.length + 1;
        if (position > 64) throw new Error("limit");
        session.signals.push({ position, type, data: data as Record<string, unknown>, sender: deviceId });
        return { position };
      },
      read: async (sessionId, after) => {
        const session = this.sessions.get(sessionId);
        if (!session || Date.now() > session.expiresAt) throw new Error("Peer unavailable");
        return { ...this.info(session, deviceId),
          signals: session.signals.filter(signal => signal.position > after && signal.sender !== deviceId)
            .map(({ position, type, data }) => ({ position, type, data })) };
      },
      close: async (sessionId) => { this.sessions.delete(sessionId); },
    };
  }
}

async function waitFor<T>(check: () => T | undefined | false | null): Promise<T> {
  for (let attempt = 0; attempt < 500; attempt++) {
    const value = check();
    if (value) return value;
    await new Promise(resolve => { setTimeout(resolve, 2); });
  }
  throw new Error("condition not reached");
}

async function setup(options: { bSigner?: (input: { peerDeviceId: string; transferId: string;
  nonce: string; channelBinding: string }) => Promise<{ proof: DeviceChallenge; signature: ArrayBuffer }>;
   bManifest?: () => PeerManifest; roster?: boolean; ttl?: number; crossAccount?: boolean } = {}) {
  const identityA = await openWebDeviceIdentity({ backendUrl, accountId, deviceId: deviceA }, { indexedDB: new IDBFactory() });
  const bAccount=options.crossAccount ? otherPeerId : accountId;
  const identityB = await openWebDeviceIdentity({ backendUrl, accountId:bAccount, deviceId: deviceB }, { indexedDB: new IDBFactory() });
  const bus = new Bus({ [deviceA]: identityA.publicKey, [deviceB]: identityB.publicKey }, options.ttl,
    options.crossAccount ? {[deviceA]:accountId,[deviceB]:bAccount}:undefined);
  const signer = (identity: Awaited<ReturnType<typeof openWebDeviceIdentity>>, deviceId: string) =>
    async (input: { peerDeviceId: string; transferId: string; nonce: string; channelBinding: string }) => {
      const issuedAt = Date.now();
      const proof: DeviceChallenge = { version: 1, purpose: "PEER", accountId:deviceId===deviceB ? bAccount:accountId, signerDeviceId: deviceId,
        peerDeviceId: input.peerDeviceId, sessionId: input.transferId, nonce: input.nonce,
        channelBinding: input.channelBinding, issuedAt, expiresAt: issuedAt + 30_000 };
      return { proof, signature: await identity.sign(proof) };
    };
  const connections = connectionPair(
    new FakeConnection("aa", "bb", "initiator"), new FakeConnection("bb", "aa", "target"));
  const roster = (caller: string) => async (signal: AbortSignal) => {
    if (signal.aborted) throw new Error("aborted");
    const rows = [
      { deviceId: deviceA, name: "A", platform: "web", lastSeenAt: Date.now(), current: caller === deviceA },
      { deviceId: deviceB, name: "B", platform: "web", lastSeenAt: Date.now(), current: caller === deviceB },
    ];
    return options.roster === false ? [rows[0]!] : rows;
  };
  const ports = (device: string, connection: FakeConnection, ownManifest: () => PeerManifest,
    sign: ReturnType<typeof signer>): PeerSessionPorts => ({
    signal: new AbortController().signal, backendUrl, devices: roster(device),
    signaling: bus.port(device), connection: () => connection, signPeer: sign,
    manifest: async () => ownManifest(), known: () => ({ conversations: [conversationId], media: [] }),
    timeoutMs: 10_000, pollMs: 50,
  });
  return { bus, ports, signer, connections, realSigns: { a: signer(identityA, deviceA), b: signer(identityB, deviceB) },
    aPorts: ports(deviceA, connections.a, () => manifest(deviceA, 10), signer(identityA, deviceA)),
    bPorts: ports(deviceB, connections.b, options.bManifest ?? (() => manifest(deviceB, 14, true)),
      options.bSigner ?? signer(identityB, deviceB)) };
}

describe("DTLS-bound same-account peer session", () => {
  it("authenticates correspondent accounts only inside the admitted conversation",async()=>{
    const f=await setup({crossAccount:true});
    const epoch="a".repeat(64);
    f.aPorts.manifest=async()=>({...manifest(deviceA,0),stateSequence:0,conversations:[{conversationId,peerId:otherPeerId,epoch,revision:0,headPosition:0}]});
    f.bPorts.manifest=async()=>({...manifest(deviceB,0),accountId:otherPeerId,stateSequence:0,conversations:[{conversationId,peerId:accountId,epoch,revision:0,headPosition:0}]});
    const aPromise=openPeerSession({accountId,deviceId:deviceA,targetDeviceId:deviceB,peerAccountId:otherPeerId,conversationId,epoch},f.aPorts);
    void aPromise.catch(()=>undefined);
    const session=await waitFor(()=>f.bus.latest());
    const bPromise=openPeerSession({accountId:otherPeerId,deviceId:deviceB,targetDeviceId:deviceA,peerAccountId:accountId,conversationId,epoch,sessionId:session.id},f.bPorts);
    const [a,b]=await Promise.all([aPromise,bPromise]);
    expect(a.remoteManifest.accountId).toBe(otherPeerId);expect(a.channelBinding).toBe(b.channelBinding);
    a.close();b.close();
  });
  it("authenticates both devices, binds the channel and plans bounded repair", async () => {
    const f = await setup();
    const aPromise = openPeerSession({ accountId, deviceId: deviceA, targetDeviceId: deviceB }, f.aPorts);
    const session = await waitFor(() => f.bus.latest());
    const bPromise = openPeerSession({ accountId, deviceId: deviceB, targetDeviceId: deviceA,
      sessionId: session.id }, f.bPorts);
    const [a, b] = await Promise.all([aPromise, bPromise]);
    expect(a.peerDeviceId).toBe(deviceB);
    expect(b.peerDeviceId).toBe(deviceA);
    expect(a.channelBinding).toBe(b.channelBinding);
    expect(a.channelBinding).toMatch(/^[0-9a-f]{64}$/);
    expect(a.plan.conversations).toEqual([{ conversationId, expectedHead: expect.objectContaining({
      conversationId, headPosition: 14 }), afterPosition: 10 }]);
    expect(a.plan.media.map(entry => entry.attachmentId)).toEqual([id(40)]);
    a.close(); b.close();
  });

  it("fails closed and reports fallback when a proof is bound to another channel", async () => {
    let failures = 0;
    const f = await setup();
    f.aPorts.onFailure = () => { failures++; };
    const aPromise = openPeerSession({ accountId, deviceId: deviceA, targetDeviceId: deviceB }, f.aPorts);
    aPromise.catch(() => undefined);
    const session = await waitFor(() => f.bus.latest());
    f.bPorts.signPeer = async input => f.realSigns.b({ ...input, channelBinding: "f".repeat(64) });
    const bPromise = openPeerSession({ accountId, deviceId: deviceB, targetDeviceId: deviceA,
      sessionId: session.id }, f.bPorts);
    bPromise.catch(() => undefined);
    await expect(aPromise).rejects.toThrow("Peer sync is unavailable");
    await bPromise.then(value => value.close()).catch(() => undefined);
    expect(failures).toBe(1);
  });

  it("rejects an unavailable roster or an expired adopted session before transport", async () => {
    const missing = await setup({ roster: false });
    await expect(openPeerSession({ accountId, deviceId: deviceA, targetDeviceId: deviceB },
      missing.aPorts)).rejects.toThrow("Peer sync is unavailable");
    expect(missing.bus.openCalls).toBe(0);

    const expired = await setup({ ttl: -1 });
    const session = await expired.bus.port(deviceA).open(deviceB, new AbortController().signal);
    await expect(openPeerSession({ accountId, deviceId: deviceB, targetDeviceId: deviceA,
      sessionId: (session as { sessionId: string }).sessionId }, expired.bPorts))
      .rejects.toThrow("Peer sync is unavailable");
  });

  it("rejects a peer manifest scoped to the wrong device", async () => {
    const f = await setup({ bManifest: () => manifest(deviceA, 14, true) });
    const aPromise = openPeerSession({ accountId, deviceId: deviceA, targetDeviceId: deviceB }, f.aPorts);
    aPromise.catch(() => undefined);
    const session = await waitFor(() => f.bus.latest());
    const bPromise = openPeerSession({ accountId, deviceId: deviceB, targetDeviceId: deviceA,
      sessionId: session.id }, f.bPorts);
    bPromise.catch(() => undefined);
    await expect(aPromise).rejects.toThrow("Peer sync is unavailable");
    await bPromise.then(value => value.close()).catch(() => undefined);
  });
});
