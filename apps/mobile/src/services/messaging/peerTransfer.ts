import { isUuid, uuid } from "./validation";
import { MEDIA_MAX_BYTES } from "./media";

export interface PeerTransferDescriptor {
  version: 1;
  transferId: string;
  conversationId: string;
  kind: "history" | "media";
  byteSize: number;
  sha256: string;
  attachmentId?: string;
}

/** Actual RTCDataChannel implements this port; no mock-only production methods. */
export interface PeerTransferChannel extends EventTarget {
  readonly readyState: string;
  readonly ordered: boolean;
  readonly maxRetransmits: number | null;
  readonly maxPacketLifeTime: number | null;
  readonly protocol: string;
  binaryType: "arraybuffer" | "blob";
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  send(data: string | ArrayBuffer): void;
  close(): void;
}

const PACKET_BYTES = 16_384, HEADER_BYTES = 24;
const HIGH_WATER = 262_144, LOW_WATER = 65_536;
const HISTORY_LIMIT = 1_048_576;
const unavailable = () => new Error("Peer repair unavailable");

function exact(input: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).length !== fields.length || fields.some(field => !Object.hasOwn(input, field))) throw unavailable();
  return input as Record<string, unknown>;
}

function descriptor(input: unknown): PeerTransferDescriptor {
  const value = input as Record<string, unknown>;
  const media = value?.kind === "media";
  exact(value, ["version", "transferId", "conversationId", "kind", "byteSize", "sha256", ...(media ? ["attachmentId"] : [])]);
  if (value.version !== 1 || !["history", "media"].includes(value.kind as string)
    || !isUuid(value.transferId) || !isUuid(value.conversationId) || (media && !isUuid(value.attachmentId))
    || typeof value.byteSize !== "number" || !Number.isSafeInteger(value.byteSize)
    || value.byteSize <= 0 || value.byteSize > (media ? MEDIA_MAX_BYTES : HISTORY_LIMIT)
    || typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.sha256)) throw unavailable();
  return { version: 1, transferId: uuid(value.transferId), conversationId: uuid(value.conversationId),
    kind: media ? "media" : "history", byteSize: value.byteSize, sha256: value.sha256,
    ...(media ? { attachmentId: uuid(value.attachmentId as string) } : {}) };
}

function transferBytes(id: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(id.replaceAll("-", "").match(/../g)!, pair => Number.parseInt(pair, 16));
}

function pending() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  // DONE can be rejected while send() still waits for READY. Observe it now,
  // without changing the rejection the subsequent original await must see.
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

interface Outgoing {
  entry: PeerTransferDescriptor;
  ready: ReturnType<typeof pending>;
  done: ReturnType<typeof pending>;
  phase: "ready" | "sending" | "done";
  timer: ReturnType<typeof setTimeout>;
}
interface Incoming {
  entry: PeerTransferDescriptor;
  idBytes: Uint8Array<ArrayBuffer>;
  bytes: Uint8Array<ArrayBuffer> | null;
  through: number;
  phase: "authorizing" | "receiving" | "committing";
  timer: ReturnType<typeof setTimeout>;
}

/** Use only AFTER mutual DTLS-bound device authentication/current roster checks.
 * This is optional transport, never server authority or a history checkpoint.
 * authorize must revalidate current account/device/conversation/erasure scope.
 * commit must enforce the caller's authority generation inside its durable write:
 * checking again after an already-persisted stale write cannot undo resurrection. */
export function createPeerTransfer(channel: PeerTransferChannel, ports: {
  signal: AbortSignal;
  crypto?: Crypto;
  authorize(descriptor: PeerTransferDescriptor, signal: AbortSignal): boolean | Promise<boolean>;
  commit(descriptor: PeerTransferDescriptor, bytes: ArrayBuffer, signal: AbortSignal): Promise<void>;
  onFailure(): void;
  timeoutMs?: number;
}) {
  const timeout = ports.timeoutMs ?? 60_000;
  if (channel.readyState !== "open" || !channel.ordered || channel.maxRetransmits !== null
    || channel.maxPacketLifeTime !== null || channel.protocol !== "norfold-sync-v1"
    || !Number.isSafeInteger(timeout) || timeout < 100 || timeout > 120_000) throw unavailable();
  channel.binaryType = "arraybuffer";
  channel.bufferedAmountLowThreshold = LOW_WATER;
  const crypto = ports.crypto ?? globalThis.crypto, lifetime = new AbortController();
  let closed = false, outgoing: Outgoing | null = null, incoming: Incoming | null = null;
  const seen = new Set<string>();
  const live = () => { if (closed || lifetime.signal.aborted || channel.readyState !== "open") throw unavailable(); };
  function stop(failed: boolean) {
    if (closed) return;
    closed = true; lifetime.abort();
    if (outgoing) { clearTimeout(outgoing.timer); outgoing.ready.reject(unavailable()); outgoing.done.reject(unavailable()); outgoing = null; }
    if (incoming) { clearTimeout(incoming.timer); incoming.bytes?.fill(0); incoming = null; }
    channel.removeEventListener("message", onMessage); channel.removeEventListener("close", onClose);
    channel.removeEventListener("error", onClose); ports.signal.removeEventListener("abort", onAbort);
    channel.close();
    if (failed) { try { ports.onFailure(); } catch { /* fallback belongs to the runtime owner */ } }
  }
  const fail = () => stop(true), onClose = () => stop(true), onAbort = () => stop(false);
  function control(type: "BEGIN" | "READY" | "END" | "DONE", entry: PeerTransferDescriptor) {
    live();
    channel.send(JSON.stringify(type === "BEGIN" ? { version: 1, type, descriptor: entry }
      : { version: 1, type, transferId: entry.transferId }));
  }
  async function begin(entry: PeerTransferDescriptor) {
    if (incoming || seen.has(entry.transferId) || seen.size >= 256) throw unavailable();
    seen.add(entry.transferId);
    const state: Incoming = { entry, idBytes: transferBytes(entry.transferId), bytes: null, through: 0,
      phase: "authorizing", timer: setTimeout(fail, timeout) };
    incoming = state;
    const allowed = await ports.authorize(entry, lifetime.signal);
    live(); if (incoming !== state || !allowed) throw unavailable();
    // No bytes/allocation before authorization and the bounded descriptor check.
    state.bytes = new Uint8Array(entry.byteSize); state.phase = "receiving";
    control("READY", entry);
  }
  function chunk(packet: ArrayBuffer) {
    const state = incoming;
    if (!state || state.phase !== "receiving" || !state.bytes
      || packet.byteLength <= HEADER_BYTES || packet.byteLength > PACKET_BYTES) throw unavailable();
    const view = new Uint8Array(packet), offset = new DataView(packet).getUint32(20, false);
    if (new DataView(packet).getUint32(0, false) !== 0x4e465331
      || state.idBytes.some((byte, n) => byte !== view[n + 4]) || offset !== state.through
      || offset + packet.byteLength - HEADER_BYTES > state.entry.byteSize) throw unavailable();
    state.bytes.set(view.subarray(HEADER_BYTES), offset);
    state.through += packet.byteLength - HEADER_BYTES;
  }
  async function finish(id: string) {
    const state = incoming;
    if (!state || state.entry.transferId !== id || state.phase !== "receiving" || !state.bytes
      || state.through !== state.entry.byteSize) throw unavailable();
    state.phase = "committing";
    const digest = await crypto.subtle.digest("SHA-256", state.bytes);
    const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    live(); if (incoming !== state || hash !== state.entry.sha256) throw unavailable();
    if (!await ports.authorize(state.entry, lifetime.signal)) throw unavailable();
    live(); if (incoming !== state || !state.bytes) throw unavailable();
    await ports.commit(state.entry, state.bytes.buffer, lifetime.signal);
    if (!await ports.authorize(state.entry, lifetime.signal)) throw unavailable();
    live(); if (incoming !== state) throw unavailable();
    // DONE acknowledges the peer's committed import only, never a server ACK.
    control("DONE", state.entry); clearTimeout(state.timer); incoming = null;
  }
  function onMessage(event: Event) {
    try {
      live(); const payload: unknown = (event as MessageEvent).data;
      if (payload instanceof ArrayBuffer) { chunk(payload); return; }
      if (typeof payload !== "string" || payload.length > 1_024) throw unavailable();
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      if (parsed?.type === "BEGIN") {
        exact(parsed, ["version", "type", "descriptor"]); if (parsed.version !== 1) throw unavailable();
        void begin(descriptor(parsed.descriptor)).catch(fail); return;
      }
      exact(parsed, ["version", "type", "transferId"]); if (parsed.version !== 1) throw unavailable();
      if (!isUuid(parsed.transferId)) throw unavailable();
      const id = uuid(parsed.transferId);
      if (parsed.type === "END") { void finish(id).catch(fail); return; }
      const state = outgoing;
      if (!state || state.entry.transferId !== id) throw unavailable();
      if (parsed.type === "READY" && state.phase === "ready") { state.phase = "sending"; state.ready.resolve(); return; }
      if (parsed.type === "DONE" && state.phase === "done") { state.done.resolve(); return; }
      throw unavailable();
    } catch { fail(); }
  }
  async function backpressure() {
    live(); if (channel.bufferedAmount < HIGH_WATER) return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        channel.removeEventListener("bufferedamountlow", drained); lifetime.signal.removeEventListener("abort", aborted);
      };
      const drained = () => { if (channel.bufferedAmount <= LOW_WATER) { cleanup(); resolve(); } };
      const aborted = () => { cleanup(); reject(unavailable()); };
      channel.addEventListener("bufferedamountlow", drained); lifetime.signal.addEventListener("abort", aborted);
      if (lifetime.signal.aborted) aborted(); else drained();
    });
    live();
  }
  channel.addEventListener("message", onMessage); channel.addEventListener("close", onClose);
  channel.addEventListener("error", onClose); ports.signal.addEventListener("abort", onAbort);
  if (ports.signal.aborted) stop(false);
  return { async send(input: PeerTransferDescriptor, bytes: ArrayBuffer): Promise<void> {
    live(); const entry = descriptor(input);
    if (!(bytes instanceof ArrayBuffer) || bytes.byteLength !== entry.byteSize || outgoing) throw unavailable();
    const state: Outgoing = { entry, ready: pending(), done: pending(), phase: "ready", timer: setTimeout(fail, timeout) };
    outgoing = state;
    try {
      if (!await ports.authorize(entry, lifetime.signal)) throw unavailable();
      live();
      control("BEGIN", entry); await state.ready.promise;
      const idBytes = transferBytes(entry.transferId);
      for (let offset = 0; offset < bytes.byteLength; offset += PACKET_BYTES - HEADER_BYTES) {
        await backpressure(); live();
        if (!await ports.authorize(entry, lifetime.signal)) throw unavailable();
        live();
        const payload = new Uint8Array(bytes, offset, Math.min(PACKET_BYTES - HEADER_BYTES, bytes.byteLength - offset));
        const packet = new ArrayBuffer(HEADER_BYTES + payload.byteLength), view = new DataView(packet);
        view.setUint32(0, 0x4e465331, false); new Uint8Array(packet).set(idBytes, 4); view.setUint32(20, offset, false);
        new Uint8Array(packet).set(payload, HEADER_BYTES); channel.send(packet);
      }
      live(); state.phase = "done"; control("END", entry); await state.done.promise; live();
    } catch { fail(); throw unavailable(); }
    finally { clearTimeout(state.timer); if (outgoing === state) outgoing = null; }
  }, close() { stop(false); } };
}
