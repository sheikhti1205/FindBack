import { isUuid, uuid } from "./validation";
import type { ConversationSummary } from "./conversationIndex";
import type { ConversationHead } from "./conversationHead";
import type { MediaAttachment, MessagingScope } from "./history";
import type { StateCursor } from "./stateChanges";

/** Same-account fleet manifest. Content-free: no bodies, captions, coordinates,
 * tokens or keys ever leave this device through peer exchange. */
export interface PeerManifestConversation {
  conversationId: string;
  peerId: string;
  revision: number;
  epoch: string | null;
  /** Durable local catch-up position for this conversation, never an ACK. */
  headPosition: number;
}
export interface PeerManifestMedia {
  attachmentId: string;
  conversationId: string;
  messageId: string;
  sha256: string;
  byteSize: number;
  mime: string;
  width: number | null;
  height: number | null;
  expiresAt: number;
}
export interface PeerManifest {
  version: 1;
  accountId: string;
  deviceId: string;
  generatedAt: number;
  conversations: PeerManifestConversation[];
  media: PeerManifestMedia[];
  stateSequence: number;
}
export interface PeerManifestScope { accountId: string; deviceId: string }

export const PEER_MANIFEST_MAX_CONVERSATIONS = 256;
export const PEER_MANIFEST_MAX_MEDIA = 128;
export const PEER_MANIFEST_MAX_BYTES = 64 * 1024;

const unavailable = () => new Error("Peer sync is unavailable");
const MIME = /^image\/(?:png|jpeg|webp)$/;
const SHA256 = /^[0-9a-f]{64}$/;

function exact(input: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).length !== fields.length || fields.some(field => !Object.hasOwn(input, field))) throw unavailable();
  return input as Record<string, unknown>;
}
function integer(value: unknown, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) throw unavailable();
  return value;
}
function conversationEntry(input: unknown, scope: PeerManifestScope): PeerManifestConversation {
  const value = exact(input, ["conversationId", "peerId", "revision", "epoch", "headPosition"]);
  const conversationId = uuid(value.conversationId as string), peerId = uuid(value.peerId as string);
  if (peerId === scope.accountId || (value.epoch !== null && typeof value.epoch !== "string")) throw unavailable();
  if (typeof value.epoch === "string" && (value.epoch.length > 128
    || [...value.epoch].some(char => char.charCodeAt(0) < 0x20))) throw unavailable();
  return { conversationId, peerId, revision: integer(value.revision, 2 ** 31), epoch: value.epoch as string | null,
    headPosition: integer(value.headPosition, 2 ** 31) };
}
function mediaEntry(input: unknown, now: number): PeerManifestMedia {
  const value = exact(input, ["attachmentId", "conversationId", "messageId", "sha256", "byteSize", "mime", "width", "height", "expiresAt"]);
  const expiresAt = integer(value.expiresAt, Number.MAX_SAFE_INTEGER);
  const byteSize = integer(value.byteSize, 20 * 1024 * 1024);
  if (byteSize === 0 || !MIME.test(value.mime as string) || !SHA256.test(value.sha256 as string)
    || expiresAt <= now || typeof value.width !== "number" && value.width !== null
    || typeof value.height !== "number" && value.height !== null) throw unavailable();
  return { attachmentId: uuid(value.attachmentId as string), conversationId: uuid(value.conversationId as string),
    messageId: uuid(value.messageId as string), sha256: value.sha256 as string, byteSize,
    mime: value.mime as string, width: value.width as number | null, height: value.height as number | null, expiresAt };
}

/** Strictly validates a peer's manifest before any of it influences work. */
export function parsePeerManifest(input: unknown, scope: PeerManifestScope, now = Date.now()): PeerManifest {
  const scopeValue = exact(scope, ["accountId", "deviceId"]);
  if (!isUuid(scopeValue.accountId) || !isUuid(scopeValue.deviceId)) throw unavailable();
  const expected = { accountId: uuid(scopeValue.accountId), deviceId: uuid(scopeValue.deviceId) };
  const value = exact(input, ["version", "accountId", "deviceId", "generatedAt", "conversations", "media", "stateSequence"]);
  if (value.version !== 1 || value.accountId !== expected.accountId || value.deviceId !== expected.deviceId
    || !Array.isArray(value.conversations) || value.conversations.length > PEER_MANIFEST_MAX_CONVERSATIONS
    || !Array.isArray(value.media) || value.media.length > PEER_MANIFEST_MAX_MEDIA) throw unavailable();
  const conversations = value.conversations.map(entry => conversationEntry(entry, expected));
  const seen = new Set<string>();
  for (const entry of conversations) {
    if (seen.has(entry.conversationId)) throw unavailable();
    seen.add(entry.conversationId);
  }
  const media = value.media.map(entry => mediaEntry(entry, now));
  const attachments = new Set<string>();
  for (const entry of media) {
    if (attachments.has(entry.attachmentId) || !seen.has(entry.conversationId)) throw unavailable();
    attachments.add(entry.attachmentId);
  }
  const manifest: PeerManifest = { version: 1, accountId: expected.accountId, deviceId: expected.deviceId,
    generatedAt: integer(value.generatedAt, Number.MAX_SAFE_INTEGER), conversations, media,
    stateSequence: integer(value.stateSequence, Number.MAX_SAFE_INTEGER) };
  if (Buffer.byteLength(JSON.stringify(manifest)) > PEER_MANIFEST_MAX_BYTES) throw unavailable();
  return manifest;
}

export interface PeerManifestSource {
  scope: MessagingScope;
  now?: () => number;
  conversations(): Promise<ConversationSummary[]>;
  checkpoint(conversationId: string): Promise<ConversationHead | null>;
  /** Attachments visible in one conversation; media has no own conversation id. */
  media(conversationId: string): Promise<MediaAttachment[]>;
  stateCursor(): Promise<StateCursor | null>;
}

/** Describes what this device can offer. Cache/inventory only, never authority. */
export async function buildPeerManifest(source: PeerManifestSource): Promise<PeerManifest> {
  const now = source.now ?? Date.now, scope = { accountId: uuid(source.scope.accountId), deviceId: uuid(source.scope.deviceId) };
  const conversations: PeerManifestConversation[] = [];
  const media: PeerManifestMedia[] = [];
  const generatedAt = now();
  for (const summary of (await source.conversations()).slice(0, PEER_MANIFEST_MAX_CONVERSATIONS)) {
    const conversationId = uuid(summary.conversationId);
    const head = await source.checkpoint(conversationId);
    conversations.push({ conversationId, peerId: uuid(summary.peerId),
      revision: summary.cachedProjection?.revision ?? 0, epoch: summary.cachedProjection?.epoch ?? null,
      headPosition: head?.position ?? 0 });
    if (media.length >= PEER_MANIFEST_MAX_MEDIA) continue;
    for (const row of await source.media(conversationId)) {
      // Only committed, unexpired bytes are offerable. QUEUED/UPLOADING records
      // may still have no durable bytes and must never be advertised.
      if (row.state !== "READY" || row.expiresAt === null || row.expiresAt <= generatedAt) continue;
      media.push({ attachmentId: uuid(row.id), conversationId, messageId: uuid(row.messageId),
        sha256: row.sha256, byteSize: row.byteSize, mime: row.mime, width: row.width, height: row.height,
        expiresAt: row.expiresAt });
      if (media.length >= PEER_MANIFEST_MAX_MEDIA) break;
    }
  }
  const cursor = await source.stateCursor();
  return parsePeerManifest({ version: 1, accountId: scope.accountId, deviceId: scope.deviceId, generatedAt,
    conversations, media, stateSequence: cursor?.sequence ?? 0 }, scope, generatedAt);
}

/**
 * Media this device can offer because the peer manifest neither lists it nor
 * has the conversation. Bytes still determine sendability; a missing local
 * attachment is simply skipped, never invented.
 */
export function peerServeManifest(local: PeerManifest, remote: PeerManifest, now = Date.now()): PeerManifestMedia[] {
  const peerMedia = new Set(remote.media.map(entry => entry.attachmentId));
  const peerConversations = new Set(remote.conversations.map(entry => entry.conversationId));
  return local.media.filter(entry => peerConversations.has(entry.conversationId)
    && !peerMedia.has(entry.attachmentId) && entry.expiresAt > now);
}

export interface PeerManifestDiff {
  conversations: Array<{ conversationId: string; expectedHead: PeerManifestConversation; afterPosition: number }>;
  media: PeerManifestMedia[];
  stateAfter: number;
}

/**
 * Plans work from the peer manifest only. A conversation the local device has
 * never seen is NOT imported inside an agreement exception: the canonical server
 * remains the only authority, so the caller reconciles it through the ordinary
 * server path and the peer merely tells it what to ask for.
 */
export function diffPeerManifest(local: PeerManifest, known: { conversations: readonly string[]; media: readonly string[] },
  remote: PeerManifest, now = Date.now()): PeerManifestDiff {
  const knownConversations = new Set(known.conversations), knownMedia = new Set(known.media);
  const localPositions = new Map(local.conversations.map(entry => [entry.conversationId, entry.headPosition]));
  const conversations = remote.conversations
    .filter(entry => knownConversations.has(entry.conversationId)
      && entry.headPosition > (localPositions.get(entry.conversationId) ?? 0))
    .map(entry => ({ conversationId: entry.conversationId, expectedHead: entry,
      afterPosition: localPositions.get(entry.conversationId) ?? 0 }));
  const media = remote.media.filter(entry => knownConversations.has(entry.conversationId)
    && !knownMedia.has(entry.attachmentId) && entry.expiresAt > now);
  return { conversations, media, stateAfter: local.stateSequence };
}
