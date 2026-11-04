// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import type { MediaMetadata } from "./media";
import type { PeerManifest, PeerManifestDiff } from "./peerManifest";
import type { PeerSession } from "./peerSession";
import type { PeerTransferChannel } from "./peerTransfer";
import { repairPeerSession, type PeerRepairPorts } from "./peerRepair";

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const accountId = id(1), deviceA = id(2), deviceB = id(3), peerId = id(4), conversationId = id(10);
const attachmentId = id(20), messageId = id(21);
const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
const sha256 = createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
const expiresAt = Date.now() + 60_000;

function media(overrides: Partial<MediaMetadata> = {}): MediaMetadata {
  return { id: attachmentId, messageId, direction: "IN", sha256, mime: "image/png",
    byteSize: 4, width: 1, height: 1, expiresAt, ...overrides };
}
function manifest(deviceId: string, withMedia: boolean): PeerManifest {
  return { version: 1, accountId, deviceId, generatedAt: Date.now(),
    conversations: [{ conversationId, peerId, revision: 1, epoch: "e1", headPosition: withMedia ? 14 : 10 }],
    stateSequence: 0,
    media: withMedia ? [{ attachmentId, conversationId, messageId, sha256, byteSize: 4, mime: "image/png",
      width: 1, height: 1, expiresAt }] : [] };
}

class Channel extends EventTarget implements PeerTransferChannel {
  readyState = "open";
  readonly ordered = true;
  readonly maxRetransmits = null;
  readonly maxPacketLifeTime = null;
  readonly protocol = "norfold-sync-v1";
  binaryType: "arraybuffer" | "blob" = "arraybuffer";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  peer!: Channel;
  send(data: string | ArrayBuffer) {
    if (this.readyState !== "open") throw new Error("closed");
    queueMicrotask(() => { if (this.peer.readyState === "open") this.peer.dispatchEvent(new MessageEvent("message", { data })); });
  }
  close() {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
    this.peer.close();
  }
}
function channelPair() {
  const a = new Channel(), b = new Channel();
  a.peer = b; b.peer = a;
  return { a, b };
}

function session(deviceId: string, peerDeviceId: string, channel: PeerTransferChannel,
  local: PeerManifest, remote: PeerManifest, plan: PeerManifestDiff): PeerSession {
  return { accountId, deviceId, peerDeviceId, sessionId: id(30), channelBinding: "a".repeat(64),
    plan, localManifest: local, remoteManifest: remote, channel, close() { channel.close(); } };
}

function ports(overrides: Partial<PeerRepairPorts>): PeerRepairPorts {
  return { signal: new AbortController().signal, reconcile: async () => undefined,
    bytes: async () => null, delivery: async () => null, importMedia: async () => undefined,
    timeoutMs: 5_000, maxSends: 4, ...overrides };
}

describe("bounded peer repair", () => {
  it("reconciles history only from the server and imports peer bytes only for a delivery row", async () => {
    const pair = channelPair();
    const reconciled: string[] = [], imported: MediaMetadata[] = [], importedBytes: ArrayBuffer[] = [];
    const localA = manifest(deviceA, true), localB = manifest(deviceB, false);
    const planA: PeerManifestDiff = { conversations: [{ conversationId,
      expectedHead: localB.conversations[0]!, afterPosition: 10 }], media: [], stateAfter: 0 };
    const planB: PeerManifestDiff = { conversations: [], media: [], stateAfter: 0 };
    const [a, b] = await Promise.all([
      repairPeerSession(session(deviceA, deviceB, pair.a, localA, localB, planA), ports({
        bytes: async id => id === attachmentId ? bytes : null,
        reconcile: async id => { reconciled.push(id); },
      })),
      repairPeerSession(session(deviceB, deviceA, pair.b, localB, localA, planB), ports({
        delivery: async id => id === attachmentId ? { metadata: media() } : null,
        importMedia: async (metadata, value) => { imported.push(metadata); importedBytes.push(value); },
      })),
    ]);
    expect(reconciled).toEqual([conversationId]);
    expect(a).toEqual({ reconciled: 1, sent: 1, received: 0 });
    expect(b).toEqual({ reconciled: 0, sent: 0, received: 1 });
    expect(imported).toHaveLength(1);
    expect(imported[0]).toMatchObject({ id: attachmentId, messageId, sha256, byteSize: 4 });
    expect(new Uint8Array(importedBytes[0]!)).toEqual(new Uint8Array(bytes));
  });

  it("refuses bytes whose canonical delivery row does not match", async () => {
    const pair = channelPair();
    let imported = 0, failures = 0;
    const localA = manifest(deviceA, true), localB = manifest(deviceB, false);
    const plan = (): PeerManifestDiff => ({ conversations: [], media: [], stateAfter: 0 });
    const a = repairPeerSession(session(deviceA, deviceB, pair.a, localA, localB, plan()),
      ports({ bytes: async () => bytes, onFailure: () => { failures++; } }));
    a.catch(() => undefined);
    const b = repairPeerSession(session(deviceB, deviceA, pair.b, localB, localA, plan()),
      ports({ delivery: async () => ({ metadata: media({ sha256: "f".repeat(64) }) }),
        importMedia: async () => { imported++; } }));
    b.catch(() => undefined);
    await expect(a).rejects.toThrow("Peer repair unavailable");
    await expect(b).rejects.toThrow("Peer repair unavailable");
    expect(imported).toBe(0);
    expect(failures).toBeGreaterThan(0);
  });
});
