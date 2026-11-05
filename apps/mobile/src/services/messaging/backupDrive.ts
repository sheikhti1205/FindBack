/**
 * Optional encrypted Google Drive backup: a versioned manifest plus
 * content-addressed per-conversation chunks in the narrow `appDataFolder`.
 *
 * ## Why content-addressed chunks
 *
 * A chunk's Drive name contains the SHA-256 of its plaintext, so writing a
 * changed part never overwrites the part the previous manifest still points at.
 * An interrupted pass therefore leaves the previous backup fully readable; the
 * new manifest is written last, and only then are superseded objects compacted.
 *
 * ## What a backup is
 *
 * A snapshot of accepted history and its suppressions — never mailbox receipts,
 * an outbox or per-device read state. Restoring merges through the ordinary
 * local import, which applies tombstones, unsends and clears; the caller must
 * still reconcile current conversation heads with the canonical server before
 * trusting stale content.
 *
 * ## What this module does not decide
 *
 * Drive is durable backup, never foreground transport and never authority. The
 * store is a port: production uses the Drive REST v3 client over the user's
 * separately chosen Google identity, tests use a synthetic in-memory store.
 * Every payload is sealed by `backupCrypto` before the store sees it, and the
 * key is admission-gated server-side, never stored beside the ciphertext.
 */
import type { HistorySnapshot, SnapshotMessage } from "./history";
import { normaliseSnapshot, validateSnapshot } from "./backup";
import { openBackupObject, sealBackupObject, sha256Hex, type BackupKey } from "./backupCrypto";
import { isUuid } from "./validation";

export const BACKUP_FORMAT = "norfold.drive.backup";
export const BACKUP_VERSION = 1;
export const BACKUP_PREFIX = "norfold.";
const CHUNK = /^norfold\.([0-9a-f-]{36})\.chunk\.([0-9a-f-]{36})\.([0-9a-f]{64})\.v1\.bin$/;
const MANIFEST = /^norfold\.([0-9a-f-]{36})\.manifest\.v1\.bin$/;
const HASH = /^[0-9a-f]{64}$/;

export const MAX_CONVERSATIONS = 512;
export const MAX_PARTS = 64;
export const MAX_MESSAGES_PER_PART = 500;
export const MAX_PART_BYTES = 2 * 1024 * 1024;
export const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
export const MAX_SUPPRESSION_ROWS = 20_000;

export interface BackupDriveFile { id: string; name: string; size: number }
export interface BackupDriveStore {
  list(): Promise<BackupDriveFile[]>;
  read(id: string): Promise<ArrayBuffer>;
  /** Overwrites `id` when given, otherwise creates in appDataFolder. */
  write(file: { id?: string; name: string; bytes: ArrayBuffer }): Promise<BackupDriveFile>;
  remove(id: string): Promise<void>;
}

export interface BackupScope { accountId: string; deviceId: string }

export interface BackupPart {
  /** 1-based position inside its conversation; content, not identity. */
  part: number;
  chunk: string;
  sha256: string;
  bytes: number;
  messages: number;
  firstSequence: number;
  lastSequence: number;
}

export interface BackupConversation {
  conversationId: string;
  headSequence: number;
  parts: BackupPart[];
}

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  accountId: string;
  deviceId: string;
  generation: string;
  exportedAt: number;
  conversations: BackupConversation[];
  tombstones: HistorySnapshot["tombstones"];
  deletedForMe: HistorySnapshot["deletedForMe"];
  clears: HistorySnapshot["clears"];
}

export type BackupDriveErrorCode =
  | "backup: invalid manifest"
  | "backup: account mismatch"
  | "backup: key generation changed"
  | "backup: empty snapshot"
  | "backup: incomplete snapshot"
  | "backup: unsupported version"
  | "backup: chunk missing"
  | "backup: chunk mismatch";

export class BackupDriveError extends Error {
  constructor(public code: BackupDriveErrorCode) {
    super(code);
    this.name = "BackupDriveError";
  }
}

const fail = (code: BackupDriveErrorCode) => new BackupDriveError(code);

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail("backup: invalid manifest");
  return value as Record<string, unknown>;
}
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const row = object(value);
  if (Object.keys(row).length !== keys.length || keys.some((key) => !Object.hasOwn(row, key))) {
    throw fail("backup: invalid manifest");
  }
  return row;
}
function nonNegative(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) {
    throw fail("backup: invalid manifest");
  }
  return value;
}
function positive(value: unknown): number {
  const number = nonNegative(value);
  if (number < 1) throw fail("backup: invalid manifest");
  return number;
}
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw fail("backup: invalid manifest");
  return value;
}

/**
 * A chunk name is exactly its account, conversation and plaintext hash. The
 * account prefix keeps two Norfold accounts that share one Google account from
 * listing, reusing or compacting each other's objects.
 */
export function chunkName(accountId: string, conversationId: string, sha256: string): string {
  if (!isUuid(accountId) || !isUuid(conversationId) || !HASH.test(sha256)) {
    throw fail("backup: invalid manifest");
  }
  return `norfold.${accountId}.chunk.${conversationId}.${sha256}.v1.bin`;
}

export function manifestName(accountId: string): string {
  if (!isUuid(accountId)) throw fail("backup: invalid manifest");
  return `norfold.${accountId}.manifest.v1.bin`;
}

/** Storage names are transport only; their shape is re-checked on read. */
export function isBackupName(name: string, accountId: string): boolean {
  if (!isUuid(accountId)) return false;
  const manifest = MANIFEST.exec(name);
  if (manifest) return manifest[1] === accountId;
  const chunk = CHUNK.exec(name);
  return chunk !== null && chunk[1] === accountId;
}

function part(input: unknown, accountId: string, conversationId: string): BackupPart {
  const row = exact(input, ["part", "chunk", "sha256", "bytes", "messages", "firstSequence", "lastSequence"]);
  const value: BackupPart = {
    part: positive(row.part),
    chunk: typeof row.chunk === "string" ? row.chunk : "",
    sha256: typeof row.sha256 === "string" ? row.sha256 : "",
    bytes: positive(row.bytes),
    messages: positive(row.messages),
    firstSequence: positive(row.firstSequence),
    lastSequence: positive(row.lastSequence),
  };
  const match = CHUNK.exec(value.chunk);
  if (!match || match[1] !== accountId || match[2] !== conversationId || match[3] !== value.sha256
    || value.bytes > MAX_PART_BYTES || value.messages > MAX_MESSAGES_PER_PART
    || value.lastSequence < value.firstSequence) throw fail("backup: invalid manifest");
  return value;
}

function conversation(input: unknown, accountId: string): BackupConversation {
  const row = exact(input, ["conversationId", "headSequence", "parts"]);
  const conversationId = isUuid(row.conversationId) ? row.conversationId : "";
  const parts = array(row.parts, MAX_PARTS).map((entry) => part(entry, accountId, conversationId));
  if (!conversationId || parts.length === 0) throw fail("backup: invalid manifest");
  const chunks = new Set<string>();
  parts.forEach((entry, index) => {
    if (entry.part !== index + 1 || chunks.has(entry.chunk)) throw fail("backup: invalid manifest");
    chunks.add(entry.chunk);
    if (index > 0 && entry.firstSequence <= parts[index - 1]!.lastSequence) {
      throw fail("backup: invalid manifest");
    }
  });
  const headSequence = positive(row.headSequence);
  // A part cannot claim to hold history beyond the conversation's own HEAD.
  if (parts.at(-1)!.lastSequence > headSequence) throw fail("backup: invalid manifest");
  return { conversationId, headSequence, parts };
}

function tombstones(input: unknown): HistorySnapshot["tombstones"] {
  return array(input, MAX_SUPPRESSION_ROWS).map((value) => {
    const row = exact(value, ["messageId", "conversationId", "recipientId", "unsentAt", "unsentBy"]);
    if (!isUuid(row.messageId) || !isUuid(row.conversationId) || !isUuid(row.unsentBy)
      || !(row.recipientId === null || isUuid(row.recipientId))) throw fail("backup: invalid manifest");
    return { messageId: row.messageId as string, conversationId: row.conversationId as string,
      recipientId: row.recipientId as string | null, unsentAt: positive(row.unsentAt),
      unsentBy: row.unsentBy as string };
  });
}
function deletedForMe(input: unknown): HistorySnapshot["deletedForMe"] {
  return array(input, MAX_SUPPRESSION_ROWS).map((value) => {
    const row = exact(value, ["messageId", "conversationId", "deletedAt"]);
    if (!isUuid(row.messageId) || !(row.conversationId === null || isUuid(row.conversationId))) {
      throw fail("backup: invalid manifest");
    }
    return { messageId: row.messageId as string, conversationId: row.conversationId as string | null,
      deletedAt: positive(row.deletedAt) };
  });
}
function clears(input: unknown): HistorySnapshot["clears"] {
  return array(input, MAX_SUPPRESSION_ROWS).map((value) => {
    const row = exact(value, ["conversationId", "throughSequence", "clearedAt"]);
    if (!isUuid(row.conversationId)) throw fail("backup: invalid manifest");
    return { conversationId: row.conversationId as string,
      throughSequence: positive(row.throughSequence), clearedAt: positive(row.clearedAt) };
  });
}

export function parseManifest(input: unknown): BackupManifest {
  const row = exact(input, ["format", "version", "accountId", "deviceId", "generation", "exportedAt",
    "conversations", "tombstones", "deletedForMe", "clears"]);
  if (row.format !== BACKUP_FORMAT) throw fail("backup: invalid manifest");
  if (row.version !== BACKUP_VERSION) throw fail("backup: unsupported version");
  if (!isUuid(row.accountId) || !isUuid(row.deviceId) || !isUuid(row.generation)) {
    throw fail("backup: invalid manifest");
  }
  const accountId = isUuid(row.accountId) ? row.accountId : "";
  if (!accountId) throw fail("backup: invalid manifest");
  const conversations = array(row.conversations, MAX_CONVERSATIONS)
    .map((entry) => conversation(entry, accountId));
  const ids = new Set(conversations.map((entry) => entry.conversationId));
  if (ids.size !== conversations.length) throw fail("backup: invalid manifest");
  return {
    format: BACKUP_FORMAT, version: BACKUP_VERSION,
    accountId: row.accountId as string, deviceId: row.deviceId as string,
    generation: row.generation as string, exportedAt: positive(row.exportedAt),
    conversations, tombstones: tombstones(row.tombstones),
    deletedForMe: deletedForMe(row.deletedForMe), clears: clears(row.clears),
  };
}

function portable(message: SnapshotMessage): Record<string, unknown> {
  // Always the full v3 shape: a partial record cannot be re-read by the shared
  // snapshot parser, and `null` is the format's "absent", not `undefined`.
  return {
    id: message.id, conversationId: message.conversationId,
    authorId: message.authorId, recipientId: message.recipientId, body: message.body,
    messageType: message.messageType ?? null,
    contextReportId: message.contextReportId ?? null,
    location: message.location ?? null,
    serverEventId: message.serverEventId, serverSequence: message.serverSequence,
    unsentAt: message.unsentAt, createdAt: message.createdAt,
  };
}

interface PreparedPart { plaintext: Uint8Array; sha256: string; messages: SnapshotMessage[] }

/** Sealed framing overhead: version byte + IV + GCM tag, plus slack. */
const FRAMING_BYTES = 64;
const MAX_PART_PLAINTEXT = MAX_PART_BYTES - FRAMING_BYTES;

function encodePart(messages: SnapshotMessage[]): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ version: BACKUP_VERSION,
    messages: messages.map(portable) }));
}

/**
 * Split one conversation's messages into ordered parts, each under both the
 * message and byte bounds. The bound is checked on plaintext with framing
 * headroom reserved so no sealed part can exceed the manifest's own limit.
 */
function partition(messages: SnapshotMessage[]): PreparedPart[] {
  const ordered = [...messages].sort((a, b) => a.serverSequence - b.serverSequence);
  const parts: PreparedPart[] = [];
  let current: SnapshotMessage[] = [];
  const flush = () => {
    if (current.length === 0) return;
    parts.push({ plaintext: encodePart(current), sha256: "", messages: current });
    current = [];
  };
  for (const message of ordered) {
    if (current.length === MAX_MESSAGES_PER_PART) flush();
    current.push(message);
    if (encodePart(current).byteLength > MAX_PART_PLAINTEXT) {
      // The message that crossed the line may need a part of its own; one too
      // large for any part is a refusal, not a silent oversize upload.
      const last = current.pop()!;
      flush();
      if (encodePart([last]).byteLength > MAX_PART_PLAINTEXT) throw fail("backup: invalid manifest");
      current.push(last);
    }
    if (parts.length >= MAX_PARTS) throw fail("backup: invalid manifest");
  }
  flush();
  if (parts.length > MAX_PARTS) throw fail("backup: invalid manifest");
  return parts;
}

export interface BackupUploadReport {
  uploaded: number;
  reused: number;
  removed: number;
  conversations: number;
  messages: number;
}

export interface BackupUploadInput {
  store: BackupDriveStore;
  key: BackupKey;
  scope: BackupScope;
  snapshot: HistorySnapshot;
  now: number;
  crypto?: Crypto;
  /** Legacy caller hint. Never bypasses validation of an existing backup. */
  repair?: boolean;
}

async function readManifest(store: BackupDriveStore, key: BackupKey, scope: BackupScope,
  crypto: Crypto): Promise<{ manifest: BackupManifest; file: BackupDriveFile } | null> {
  const files = (await store.list()).filter((file) => file.name === manifestName(scope.accountId));
  if (files.length === 0) return null;
  if (files.length > 1) throw fail("backup: invalid manifest");
  const file = files[0]!;
  if (file.size <= 0 || file.size > MAX_MANIFEST_BYTES) throw fail("backup: invalid manifest");
  const bytes = await store.read(file.id);
  const opened = await openBackupObject(key, manifestName(scope.accountId), bytes, crypto);
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(opened)); } catch { throw fail("backup: invalid manifest"); }
  const manifest = parseManifest(value);
  if (manifest.accountId !== scope.accountId) throw fail("backup: account mismatch");
  if (manifest.generation !== key.generation) throw fail("backup: invalid manifest");
  return { manifest, file };
}

/** Missing local history is not deletion authority. Keep prior suppressions and
 * require every prior accepted message to remain present or explicitly retired.
 * This is a sequential preservation check, not atomic arbitration across Drive writers.
 */
function assertCoverage(previous: HistorySnapshot, next: HistorySnapshot): void {
  const messages = new Map(next.messages.map(row => [row.id, row]));
  const clears = new Map(next.clears.map(row => [row.conversationId, row.throughSequence]));
  const tombstones = new Map(next.tombstones.map(row => [row.messageId, row]));
  const deletions = new Map(next.deletedForMe.map(row => [row.messageId, row]));
  const incomplete = () => { throw fail("backup: incomplete snapshot"); };
  for (const row of previous.clears) {
    if ((clears.get(row.conversationId) ?? -1) < row.throughSequence) incomplete();
  }
  for (const row of previous.tombstones) {
    const kept = tombstones.get(row.messageId);
    if (!kept || kept.conversationId !== row.conversationId || kept.unsentBy !== row.unsentBy
      || kept.recipientId !== row.recipientId) incomplete();
  }
  for (const row of previous.deletedForMe) {
    const kept = deletions.get(row.messageId);
    if (!kept || (kept.conversationId !== null && kept.conversationId !== row.conversationId)) incomplete();
  }
  for (const row of previous.messages) {
    const tombstone = tombstones.get(row.id), deletion = deletions.get(row.id);
    const retired = (clears.get(row.conversationId) ?? -1) >= row.serverSequence
      || (tombstone?.conversationId === row.conversationId
        && tombstone.unsentBy === row.authorId && tombstone.recipientId === row.recipientId)
      || (deletion !== undefined && (deletion.conversationId === null || deletion.conversationId === row.conversationId));
    const kept = messages.get(row.id);
    if (retired) continue;
    if (!kept || kept.conversationId !== row.conversationId || kept.serverSequence !== row.serverSequence
      || kept.serverEventId !== row.serverEventId || kept.authorId !== row.authorId || kept.recipientId !== row.recipientId
      || (row.body === null && kept.body !== null) || (row.unsentAt !== null && kept.unsentAt === null)) incomplete();
  }
}

/**
 * One incremental pass: chunks whose plaintext hash is already referenced are
 * reused, changed parts get new content-addressed names, and the manifest is
 * written last. Superseded objects are removed only after that write, so a
 * failure anywhere earlier leaves the previous backup readable.
 */
export async function uploadBackup(input: BackupUploadInput): Promise<BackupUploadReport> {
  const crypto = input.crypto ?? globalThis.crypto;
  const { store, key, scope, snapshot, now } = input;
  if (!Number.isSafeInteger(now) || now <= 0) throw fail("backup: invalid manifest");
  validateSnapshot(snapshot, scope.accountId);
  const files = (await store.list()).filter((file) => isBackupName(file.name, scope.accountId));
  let previous: { manifest: BackupManifest; file: BackupDriveFile } | null = null;
  let manifestFile: BackupDriveFile | undefined;
  const existingManifests = files.filter((file) => file.name === manifestName(scope.accountId));
  if (existingManifests.length > 0) {
    if (existingManifests.length > 1) throw fail("backup: invalid manifest");
    // An unreadable backup cannot establish what a replacement would omit.
    previous = await readManifest(store, key, scope, crypto);
    manifestFile = previous!.file;
  }
  // An empty snapshot is not evidence that history is gone: a failed database
  // open, a wiped local store and a platform read error all look identical here.
  // Unless the snapshot itself records the deletion (clears, tombstones or
  // per-user deletions), publishing it would replace a restorable backup with an
  // empty manifest and then compact every chunk away. Refuse and keep both.
  const empty = snapshot.messages.length === 0
    && snapshot.clears.length === 0 && snapshot.tombstones.length === 0
    && snapshot.deletedForMe.length === 0;
  const storedHistory = (previous?.manifest.conversations.length ?? 0) > 0
    || files.some((file) => file.name !== manifestName(scope.accountId));
  if (empty && storedHistory) throw fail("backup: empty snapshot");
  if (previous) assertCoverage(await readSnapshot(store, key, scope, previous.manifest, crypto), snapshot);
  const byConversation = new Map<string, SnapshotMessage[]>();
  for (const message of snapshot.messages) {
    const list = byConversation.get(message.conversationId) ?? [];
    list.push(message);
    byConversation.set(message.conversationId, list);
  }
  const existing = new Map(files.map((file) => [file.name, file]));
  const previouslyReferenced = new Set<string>();
  for (const entry of previous?.manifest.conversations ?? []) {
    for (const entryPart of entry.parts) previouslyReferenced.add(entryPart.chunk);
  }

  const conversations: BackupConversation[] = [];
  const written = new Set<string>();
  const covered = new Set<string>();
  let uploaded = 0, reused = 0, messages = 0;
  for (const snapshotConversation of snapshot.conversations) {
    const rows = byConversation.get(snapshotConversation.id) ?? [];
    // An empty conversation carries no restorable content; the server's own
    // sync recreates it. The manifest cannot describe a part-less entry.
    if (rows.length === 0) continue;
    covered.add(snapshotConversation.id);
    const headSequence = rows.reduce((max, row) => Math.max(max, row.serverSequence), 0);
    const parts: BackupPart[] = [];
    for (const [index, entry] of partition(rows).entries()) {
      entry.sha256 = await sha256Hex(entry.plaintext, crypto);
      const name = chunkName(scope.accountId, snapshotConversation.id, entry.sha256);
      const file = existing.get(name);
      // Reuse only content the previous manifest actually referenced: an
      // orphan from an interrupted pass is rewritten rather than trusted.
      if (file && previouslyReferenced.has(name)) {
        reused++;
      } else {
        const bytes = await sealBackupObject(key, name, entry.plaintext, crypto);
        if (bytes.byteLength > MAX_PART_BYTES) throw fail("backup: invalid manifest");
        const writtenFile = await store.write({ id: file?.id, name, bytes });
        existing.set(name, writtenFile);
        uploaded++;
      }
      written.add(name);
      const stored = existing.get(name)!;
      parts.push({ part: index + 1, chunk: name, sha256: entry.sha256, bytes: stored.size,
        messages: entry.messages.length,
        firstSequence: entry.messages[0]!.serverSequence,
        lastSequence: entry.messages.at(-1)!.serverSequence });
      messages += entry.messages.length;
    }
    conversations.push({ conversationId: snapshotConversation.id, headSequence, parts });
  }
  // Every message must belong to a conversation this pass actually wrote;
  // silently dropping one would make the backup quietly lossy.
  for (const conversationId of byConversation.keys()) {
    if (!covered.has(conversationId)) throw fail("backup: invalid manifest");
  }

  const manifest: BackupManifest = {
    format: BACKUP_FORMAT, version: BACKUP_VERSION, accountId: scope.accountId,
    deviceId: scope.deviceId, generation: key.generation, exportedAt: now,
    conversations, tombstones: snapshot.tombstones, deletedForMe: snapshot.deletedForMe,
    clears: snapshot.clears,
  };
  const plaintext = new TextEncoder().encode(JSON.stringify(manifest));
  if (plaintext.byteLength > MAX_MANIFEST_BYTES) throw fail("backup: invalid manifest");
  const sealed = await sealBackupObject(key, manifestName(scope.accountId), plaintext, crypto);
  if (sealed.byteLength > MAX_MANIFEST_BYTES) throw fail("backup: invalid manifest");
  await store.write({ id: manifestFile?.id, name: manifestName(scope.accountId), bytes: sealed });

  // Compaction now that the new manifest is durable: superseded chunks and
  // orphans from an interrupted pass. The manifest itself is never removed, and
  // a cleanup failure cannot invalidate a published backup — the caller keeps
  // its committed receipt and a later pass retries the bounded cleanup.
  let removed = 0;
  for (const file of files) {
    if (file.name === manifestName(scope.accountId) || written.has(file.name)) continue;
    if (!isBackupName(file.name, scope.accountId)) continue;
    try {
      await store.remove(file.id);
      removed++;
    } catch { /* retained for the next pass */ }
  }
  return { uploaded, reused, removed, conversations: conversations.length, messages };
}

export interface BackupDownload {
  manifest: BackupManifest;
  /** Normalised, validated snapshot; the caller still reconciles with the server. */
  snapshot: HistorySnapshot;
}

function chunkMessages(opened: Uint8Array, conversationId: string): SnapshotMessage[] {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(opened)); } catch { throw fail("backup: chunk mismatch"); }
  const row = exact(value, ["version", "messages"]);
  if (row.version !== BACKUP_VERSION) throw fail("backup: unsupported version");
  return array(row.messages, MAX_MESSAGES_PER_PART).map((entry) => {
    const message = object(entry);
    if (!isUuid(message.id) || message.conversationId !== conversationId
      || !isUuid(message.authorId) || !isUuid(message.recipientId)
      || !isUuid(message.serverEventId) || !positive(message.serverSequence)) {
      throw fail("backup: chunk mismatch");
    }
    return message as unknown as SnapshotMessage;
  });
}

/** Read, verify and assemble the backup. Nothing is written to history here. */
export async function downloadBackup(input: { store: BackupDriveStore; key: BackupKey;
  scope: BackupScope; crypto?: Crypto }): Promise<BackupDownload> {
  const crypto = input.crypto ?? globalThis.crypto;
  const current = await readManifest(input.store, input.key, input.scope, crypto);
  if (!current) throw fail("backup: chunk missing");
  return { manifest: current.manifest,
    snapshot: await readSnapshot(input.store, input.key, input.scope, current.manifest, crypto) };
}

async function readSnapshot(store: BackupDriveStore, key: BackupKey, scope: BackupScope,
  manifest: BackupManifest, crypto: Crypto): Promise<HistorySnapshot> {
  const byName = new Map((await store.list()).map((file) => [file.name, file]));
  const messages: SnapshotMessage[] = [];
  for (const entry of manifest.conversations) {
    let previousSequence = 0;
    for (const part of entry.parts) {
      const file = byName.get(part.chunk);
      if (!file) throw fail("backup: chunk missing");
      const bytes = await store.read(file.id);
      const opened = await openBackupObject(key, part.chunk, bytes, crypto);
      if (await sha256Hex(opened, crypto) !== part.sha256) throw fail("backup: chunk mismatch");
      const rows = chunkMessages(opened, entry.conversationId);
      if (rows.length !== part.messages) throw fail("backup: chunk mismatch");
      for (const message of rows) {
        // Sequences ascend across every part of one conversation.
        if (message.serverSequence <= previousSequence) throw fail("backup: chunk mismatch");
        previousSequence = message.serverSequence;
        messages.push(message);
      }
      if (rows.at(0)!.serverSequence !== part.firstSequence
        || rows.at(-1)!.serverSequence !== part.lastSequence) throw fail("backup: chunk mismatch");
    }
  }
  const snapshot = normaliseSnapshot({
    conversations: manifest.conversations.map((entry) => ({
      id: entry.conversationId, lastSequence: entry.headSequence,
      createdAt: 0, updatedAt: 0,
    })),
    messages,
    tombstones: manifest.tombstones,
    deletedForMe: manifest.deletedForMe,
    clears: manifest.clears,
  });
  validateSnapshot(snapshot, scope.accountId);
  return snapshot;
}
