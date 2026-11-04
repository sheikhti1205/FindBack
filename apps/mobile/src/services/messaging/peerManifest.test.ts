// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  PEER_MANIFEST_MAX_BYTES, PEER_MANIFEST_MAX_CONVERSATIONS, PEER_MANIFEST_MAX_MEDIA,
  buildPeerManifest, diffPeerManifest, parsePeerManifest, peerServeManifest,
  type PeerManifest, type PeerManifestMedia,
} from "./peerManifest";

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const accountId = id(1), deviceId = id(2), peerId = id(3), conversationId = id(4);
const sha = "a".repeat(64);
const base = (overrides: Partial<PeerManifest> = {}): PeerManifest => ({
  version: 1, accountId, deviceId, generatedAt: 1_000,
  conversations: [{ conversationId, peerId, revision: 3, epoch: "e1", headPosition: 10 }],
  stateSequence: 5, media: [], ...overrides,
});
const scope = { accountId, deviceId };

describe("peer manifest authority scoping", () => {
  it("builds from local summaries/head checkpoints and cached committed media only", async () => {
    const manifest = await buildPeerManifest({
      scope, now: () => 2_000,
      conversations: async () => [{ conversationId, peerId, revision: 4,
        cachedProjection: { conversationId, peerId, mode: "CONNECTED", request: "NONE", requestEpoch: null,
          ownBlocked: false, ownDeclined: false, ownHidden: false, revision: 4, epoch: "e2" } } as never],
      checkpoint: async () => ({ accountId, conversationId, streamId: "s", epoch: "e2", revision: 4,
        position: 12, messageHead: 11, stateHead: 5, serverTime: 1_900 } as never),
      media: async () => [
        { id: id(20), messageId: id(21), conversationId, sha256: sha, byteSize: 10, mime: "image/png",
          width: 1, height: 1, state: "READY", expiresAt: 9_000 } as never,
        { id: id(22), messageId: id(23), conversationId, sha256: sha, byteSize: 10, mime: "image/png",
          width: 1, height: 1, state: "UPLOADING", expiresAt: 9_000 } as never,
        { id: id(24), messageId: id(25), conversationId, sha256: sha, byteSize: 10, mime: "image/png",
          width: 1, height: 1, state: "READY", expiresAt: 1 } as never,
      ],
      stateCursor: async () => ({ sequence: 7 } as never),
    });
    expect(manifest).toMatchObject({ version: 1, accountId, deviceId, generatedAt: 2_000, stateSequence: 7 });
    expect(manifest.conversations).toEqual([{ conversationId, peerId, revision: 4, epoch: "e2", headPosition: 12 }]);
    // Only committed, unexpired, own-account bytes are offered.
    expect(manifest.media.map(entry => entry.attachmentId)).toEqual([id(20)]);
  });

  it("rejects a manifest for another account or device and any non-canonical field", () => {
    for (const overrides of [{ accountId: id(9) }, { deviceId: id(9) }, { version: 2 as unknown as 1 },
      { stateSequence: -1 }, { generatedAt: -1 }]) {
      expect(() => parsePeerManifest({ ...base(), ...overrides }, scope)).toThrow();
    }
    expect(() => parsePeerManifest({ ...base(), extra: true }, scope)).toThrow();
    expect(() => parsePeerManifest("{}", scope)).toThrow();
    expect(() => parsePeerManifest(base(), base())).toThrow(); // wrong expected key shape
    expect(parsePeerManifest(JSON.parse(JSON.stringify(base())), scope)).toEqual(base());
  });

  it("rejects duplicate conversations/media, self peers and expired or oversized entries", () => {
    const entry = base().conversations[0]!;
    expect(() => parsePeerManifest(base({ conversations: [entry, entry] }), scope)).toThrow();
    expect(() => parsePeerManifest(base({ conversations: [{ ...entry, peerId: accountId }] }), scope)).toThrow();
    expect(() => parsePeerManifest(base({ conversations: [{ ...entry, headPosition: 1.5 } as never] }), scope)).toThrow();
    const media = { attachmentId: id(30), conversationId, messageId: id(31), sha256: sha, byteSize: 10,
      mime: "image/png", width: 1, height: 1, expiresAt: 9_000 };
    expect(() => parsePeerManifest(base({ media: [media, { ...media, messageId: id(32) }] }), scope)).toThrow();
    expect(() => parsePeerManifest(base({ media: [{ ...media, byteSize: 0 }] }), scope)).toThrow();
    expect(() => parsePeerManifest(base({ media: [{ ...media, mime: "text/html" }] }), scope)).toThrow();
    expect(() => parsePeerManifest(base({ media: [media], generatedAt: 10_000 }), scope)).toThrow(); // expired
    expect(() => parsePeerManifest(base({ conversations: Array.from({ length: PEER_MANIFEST_MAX_CONVERSATIONS + 1 },
      () => ({ ...entry, conversationId: id(50) })) }), scope)).toThrow();
    expect(() => parsePeerManifest(base({ media: Array.from({ length: PEER_MANIFEST_MAX_MEDIA + 1 },
      (_, n) => ({ ...media, attachmentId: id(60 + n), messageId: id(200 + n) })) }), scope)).toThrow();
  });

  it("bounds a serialized manifest by bytes, not only entry counts", () => {
    const media = Array.from({ length: PEER_MANIFEST_MAX_MEDIA }, (_, n) => ({ attachmentId: id(1000 + n),
      conversationId, messageId: id(2000 + n), sha256: sha, byteSize: 10, mime: "image/png",
      width: 1, height: 1, expiresAt: 9_000 }));
    const text = JSON.stringify(base({ media }));
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(PEER_MANIFEST_MAX_BYTES);
    expect(() => parsePeerManifest(JSON.parse(text), scope, 1_000)).not.toThrow();
  });

  it("requests only conversations behind the peer plus media bytes this device lacks", () => {
    const local = base({ conversations: [
      { conversationId, peerId, revision: 3, epoch: "e1", headPosition: 10 },
      { conversationId: id(5), peerId, revision: 1, epoch: "e1", headPosition: 4 },
    ], stateSequence: 5, media: [] });
    const remote = base({ conversations: [
      { conversationId, peerId, revision: 4, epoch: "e2", headPosition: 14 },
      { conversationId: id(5), peerId, revision: 1, epoch: "e1", headPosition: 4 },
      { conversationId: id(6), peerId, revision: 1, epoch: "e1", headPosition: 2 },
    ], stateSequence: 5, media: [
      { attachmentId: id(40), conversationId, messageId: id(41), sha256: sha, byteSize: 10,
        mime: "image/png", width: 1, height: 1, expiresAt: 9_000 },
      { attachmentId: id(42), conversationId, messageId: id(43), sha256: sha, byteSize: 10,
        mime: "image/png", width: 1, height: 1, expiresAt: 9_000 },
    ] });
    const diff = diffPeerManifest(local, { conversations: [conversationId, id(5), id(9)], media: [id(40)] }, remote, 2_000);
    // id(5) is not behind the peer and id(9) is not in the peer manifest: no work.
    expect(diff.conversations).toEqual([{ conversationId, expectedHead: remote.conversations[0], afterPosition: 10 }]);
    // A local attachment set never asks for bytes it already holds.
    expect(diff.media.map(entry => entry.attachmentId)).toEqual([id(42)]);
    expect(diff.stateAfter).toBe(5);
  });

  it("plans which of its own media the peer's manifest does not list", () => {
    const entry = (n: number, extra: Partial<PeerManifestMedia> = {}): PeerManifestMedia => ({
      attachmentId: id(n), conversationId, messageId: id(n + 100), sha256: sha, byteSize: 10,
      mime: "image/png", width: 1, height: 1, expiresAt: 9_000, ...extra });
    const local = base({ media: [entry(70), entry(71), entry(72)] });
    const remote = base({ deviceId: peerId, media: [entry(70)] });
    expect(peerServeManifest(local, remote, 2_000).map(item => item.attachmentId))
      .toEqual([id(71), id(72)]);
    // A conversation the peer does not know, or an expired entry, is not offered.
    expect(peerServeManifest(local, base({ conversations: [], media: [entry(73)] }), 2_000)).toEqual([]);
    expect(peerServeManifest(local, remote, 9_000)).toEqual([]);
  });
});
