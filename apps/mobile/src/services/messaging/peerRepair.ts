import type { MediaMetadata } from "./media";
import { peerServeManifest } from "./peerManifest";
import type { PeerSession } from "./peerSession";
import { createPeerTransfer, type PeerTransferDescriptor } from "./peerTransfer";
import { isUuid, uuid } from "./validation";

/** One inbound attachment the canonical server currently authorizes for this
 * device. The peer's bytes never substitute for this row. */
export interface PeerInboundMedia { metadata: MediaMetadata }

export interface PeerRepairPorts {
  signal: AbortSignal;
  /** Canonical server catch-up for a conversation the peer is ahead on. The
   * peer's head position is a hint only and is never applied as authority. */
  reconcile(conversationId: string): Promise<void>;
  /** Locally committed READY bytes, or null. Recomputed/verified before offer. */
  bytes(attachmentId: string): Promise<ArrayBuffer | null>;
  /** findback_fetch_chat_media_delivery row for one attachment. */
  delivery(attachmentId: string): Promise<PeerInboundMedia | null>;
  /** Canonical inbound import; the session revalidates the server delivery again. */
  importMedia(metadata: MediaMetadata, bytes: ArrayBuffer): Promise<void>;
  onFailure?(): void;
  crypto?: Crypto;
  now?(): number;
  timeoutMs?: number;
  /** Bounded work per repair round. */
  maxSends?: number;
}

export interface PeerRepairResult { reconciled: number; sent: number; received: number }

const unavailable = () => new Error("Peer repair unavailable");
const MAX_PLAN = 32;

function exact(input: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).length !== fields.length || fields.some(field => !Object.hasOwn(input, field))) throw unavailable();
  return input as Record<string, unknown>;
}
function plan(input: unknown): string[] {
  const value = exact(input, ["version", "type", "entries"]);
  if (value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > MAX_PLAN
    || new Set(value.entries).size !== value.entries.length
    || value.entries.some(entry => !isUuid(entry))) throw unavailable();
  return value.entries.map(entry => uuid(entry as string));
}
async function hex(bytes: ArrayBuffer, crypto: Crypto): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * One bounded repair round over an authenticated peer channel.
 *
 * History never crosses the peer: a conversation the peer is ahead on is
 * reconciled through the canonical server, with the peer position used only as
 * a hint. Only already-server-authorized media bytes may cross, and the
 * receiver revalidates the delivery row before and inside the canonical import.
 * The transfer DONE message acknowledges a local commit, never a server ACK.
 */
export async function repairPeerSession(session: PeerSession, ports: PeerRepairPorts): Promise<PeerRepairResult> {
  if (!session || session.channel.readyState !== "open") throw unavailable();
  const now = ports.now ?? Date.now, crypto = ports.crypto ?? globalThis.crypto;
  const timeout = ports.timeoutMs ?? 30_000, maxSends = ports.maxSends ?? 16;
  if (!Number.isSafeInteger(timeout) || timeout < 5_000 || timeout > 60_000
    || !Number.isSafeInteger(maxSends) || maxSends < 0 || maxSends > MAX_PLAN) throw unavailable();
  if (ports.signal.aborted) throw unavailable();

  const offer = peerServeManifest(session.localManifest, session.remoteManifest, now()).slice(0, maxSends);
  const outgoing: Array<{ entry: PeerTransferDescriptor; bytes: ArrayBuffer }> = [];
  const localTransfers = new Set<string>();

  let peerPlan: string[] | null = null, peerComplete = false, received = 0, failed = false;
  let settle!: { resolve: (value: PeerRepairResult) => void; reject: (error: Error) => void };
  const completed = new Promise<PeerRepairResult>((resolve, reject) => { settle = { resolve, reject }; });
  // A failure may precede the await; observe it now without changing the state.
  void completed.catch(() => undefined);
  const fail = (error: Error) => {
    if (failed) return;
    failed = true;
    try { ports.onFailure?.(); } catch { /* caller owns fallback */ }
    settle.reject(error);
  };
  const checkDone = () => {
    if (peerPlan && peerComplete && received === peerPlan.length) {
      settle.resolve({ reconciled: 0, sent: outgoing.length, received });
    }
  };
  const timer = setTimeout(() => fail(unavailable()), timeout);
  const onAbort = () => fail(unavailable());
  ports.signal.addEventListener("abort", onAbort);
  const transfer = createPeerTransfer(session.channel, {
    signal: ports.signal,
    crypto,
    timeoutMs: timeout,
    onFailure: () => fail(unavailable()),
    authorize: async (entry, signal) => {
      if (signal.aborted || entry.kind !== "media" || !entry.attachmentId) return false;
      // Our own outgoing descriptor was already digest-verified above; re-check
      // the immutable identity rather than the peer's delivery row.
      if (localTransfers.has(entry.transferId)) return outgoing.some(
        item => item.entry.transferId === entry.transferId && item.entry.attachmentId === entry.attachmentId
          && item.entry.sha256 === entry.sha256 && item.entry.byteSize === entry.byteSize);
      const delivery = await ports.delivery(entry.attachmentId);
      const metadata = delivery?.metadata;
      return !!metadata && metadata.id === entry.attachmentId && metadata.sha256 === entry.sha256
        && metadata.byteSize === entry.byteSize && metadata.expiresAt !== null && metadata.expiresAt > now();
    },
    commit: async (entry, bytes, signal) => {
      if (signal.aborted || !entry.attachmentId) throw unavailable();
      // Revalidate the authoritative delivery immediately before the durable write.
      const delivery = await ports.delivery(entry.attachmentId);
      if (!delivery || delivery.metadata.sha256 !== entry.sha256) throw unavailable();
      await ports.importMedia(delivery.metadata, bytes);
      received++;
      checkDone();
    },
    onControl: (type, message) => {
      try {
        if (type === "PLAN") {
          if (peerPlan) throw unavailable();
          peerPlan = plan(message);
          checkDone();
          return true;
        }
        if (type === "COMPLETE") {
          exact(message, ["version", "type"]);
          if ((message as Record<string, unknown>).version !== 1 || peerComplete) throw unavailable();
          peerComplete = true;
          checkDone();
          return true;
        }
        return false;
      } catch (error) { fail(error instanceof Error ? error : unavailable()); return true; }
    },
  });

  try {
    // Build the offer first, but only after the transfer listener exists: an
    // early peer PLAN/COMPLETE must never be dropped while bytes are hashed.
    for (const entry of offer) {
      if (ports.signal.aborted) throw unavailable();
      const bytes = await ports.bytes(entry.attachmentId);
      // Advertise only bytes this device actually holds with the claimed digest.
      if (!(bytes instanceof ArrayBuffer) || bytes.byteLength !== entry.byteSize) continue;
      if (await hex(bytes, crypto) !== entry.sha256) continue;
      const transferId = uuid(crypto.randomUUID());
      localTransfers.add(transferId);
      outgoing.push({ entry: { version: 1, transferId, conversationId: entry.conversationId,
        kind: "media", byteSize: entry.byteSize, sha256: entry.sha256, attachmentId: entry.attachmentId }, bytes });
    }
    // Server-authoritative catch-up first; the peer never supplies history.
    let reconciled = 0;
    for (const item of session.plan.conversations.slice(0, MAX_PLAN)) {
      if (ports.signal.aborted) throw unavailable();
      await ports.reconcile(item.conversationId);
      reconciled++;
    }
    session.channel.send(JSON.stringify({ version: 1, type: "PLAN",
      entries: outgoing.map(item => item.entry.attachmentId) }));
    // Announce the plan before streaming, so the receiver can bound its wait.
    for (const item of outgoing) await transfer.send(item.entry, item.bytes);
    session.channel.send(JSON.stringify({ version: 1, type: "COMPLETE" }));
    // COMPLETE from the peer means it finished its own sends and received ours.
    const result = await Promise.race([completed, new Promise<never>((_resolve, reject) => {
      ports.signal.addEventListener("abort", () => reject(unavailable()), { once: true });
    })]);
    return { ...result, reconciled, sent: outgoing.length };
  } catch (error) {
    fail(error instanceof Error && error.message === "Peer repair unavailable" ? error : unavailable());
    transfer.close();
    throw error instanceof Error && error.message === "Peer repair unavailable" ? error : unavailable();
  } finally {
    clearTimeout(timer);
    ports.signal.removeEventListener("abort", onAbort);
    // The session owner closes the transport after the whole exchange; closing
    // here would race the peer's final COMPLETE/PROOF observation.
  }
}
