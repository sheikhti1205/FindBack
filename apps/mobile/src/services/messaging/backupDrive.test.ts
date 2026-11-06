// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { HistorySnapshot, SnapshotConversation, SnapshotMessage } from "./history";
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  BackupDriveError,
  chunkName,
  downloadBackup,
  isBackupName,
  legacyChunkName,
  legacyManifestName,
  manifestName,
  parseManifest,
  uploadBackup,
  type BackupDriveStore,
  type BackupManifest,
} from "./backupDrive";
import { importBackupKey, sealBackupObject, sha256Hex } from "./backupCrypto";

const uuid = (n: number) => `00000000-0000-4000-9d02-${n.toString(16).padStart(12, "0")}`;
const A = uuid(1);
const PEER = uuid(2);
const CHAT = uuid(10);
const CHAT2 = uuid(11);
const DEVICE = uuid(20);
const OTHER_DEVICE = uuid(21);
const GEN = uuid(30);
const KEY_HEX = "ab".repeat(32);
const MANIFEST = manifestName(A, DEVICE);

interface Row { chat: string; count: number; base: number; start?: number; body?: (seq: number) => string }

/**
 * A validated snapshot: `count` accepted messages per conversation, sequences
 * starting at `start`, ids derived from `base` so every fixture is unique.
 */
function snapshotOf(rows: Row[], extra: Partial<HistorySnapshot> = {}): HistorySnapshot {
  const messages: SnapshotMessage[] = [];
  const conversations: SnapshotConversation[] = [];
  for (const row of rows) {
    const start = row.start ?? 1;
    for (let seq = start; seq < start + row.count; seq++) {
      messages.push({
        id: uuid(row.base + seq), conversationId: row.chat,
        authorId: PEER, recipientId: A, body: row.body?.(seq) ?? `text ${seq}`,
        messageType: "TEXT", contextReportId: null, location: null,
        serverEventId: uuid(row.base + seq + 0x4000), serverSequence: seq,
        unsentAt: null, createdAt: 0,
      });
    }
    conversations.push({ id: row.chat, lastSequence: start + row.count - 1,
      createdAt: 0, updatedAt: 0 });
  }
  return { conversations, messages, tombstones: [], deletedForMe: [], clears: [], ...extra };
}

interface MemoryStore extends BackupDriveStore {
  names(): string[];
  raw(name: string): ArrayBuffer;
  writes: string[];
  failManifestWrite: boolean;
}

/** A Drive store with per-name inspection and an injectable manifest failure. */
function memoryStore(): MemoryStore {
  const files = new Map<string, { id: string; name: string; bytes: ArrayBuffer }>();
  let sequence = 0;
  const store: MemoryStore = {
    writes: [],
    failManifestWrite: false,
    names: () => [...files.values()].map((file) => file.name).sort(),
    raw: (name) => {
      const file = [...files.values()].find((entry) => entry.name === name);
      if (!file) throw new Error(`no file ${name}`);
      return file.bytes;
    },
    async list() {
      return [...files.values()].map((file) => ({ id: file.id, name: file.name, size: file.bytes.byteLength }));
    },
    async read(id) {
      const file = files.get(id);
      if (!file) throw new Error(`no file ${id}`);
      return file.bytes.slice(0);
    },
    async write({ id, name, bytes }) {
      if (store.failManifestWrite && name === MANIFEST) throw new Error("manifest write refused");
      store.writes.push(name);
      const current = (id ? files.get(id) : undefined)
        ?? [...files.values()].find((file) => file.name === name);
      if (current) {
        current.name = name;
        current.bytes = bytes;
        return { id: current.id, name, size: bytes.byteLength };
      }
      const file = { id: `file-${++sequence}`, name, bytes };
      files.set(file.id, file);
      return { id: file.id, name, size: bytes.byteLength };
    },
    async remove(id) {
      files.delete(id);
    },
  };
  return store;
}

const scope = { accountId: A, deviceId: DEVICE };
const key = () => importBackupKey(GEN, KEY_HEX);
type UploadOverrides = Partial<Parameters<typeof uploadBackup>[0]>;
type DownloadOverrides = Partial<Parameters<typeof downloadBackup>[0]>;
const upload = async (store: MemoryStore, snapshot: HistorySnapshot, overrides: UploadOverrides = {}) =>
  uploadBackup({ store, key: await key(), scope, snapshot, now: 1_760_000_000_000, ...overrides });
const download = async (store: MemoryStore, overrides: DownloadOverrides = {}) =>
  downloadBackup({ store, key: await key(), scope, ...overrides });

const chunkNames = (store: MemoryStore) => store.names().filter((name) => !name.includes(".manifest."));

describe("an encrypted Drive backup", () => {
  it("unions historical read facts even when the newest device has a stale unread copy", async () => {
    const store = memoryStore(), earlier = snapshotOf([{ chat: CHAT, count: 2, base: 0x1000 }]);
    earlier.messages[0]!.readLocally = true; earlier.messages[0]!.receiptObserved = true;
    earlier.messages[1]!.authorId = A; earlier.messages[1]!.recipientId = PEER; earlier.messages[1]!.readByPeer = true;
    const later = structuredClone(earlier);
    for (const message of later.messages) {
      delete message.readLocally; delete message.receiptObserved; delete message.readByPeer;
    }
    await upload(store, earlier, { now: 1_760_000_000_000 });
    await upload(store, later, { scope: { ...scope, deviceId: OTHER_DEVICE }, now: 1_760_000_000_001 });
    const restored = await download(store);
    expect(restored.snapshot.messages[0]).toMatchObject({ readLocally: true, receiptObserved: true });
    expect(restored.snapshot.messages[1]).toMatchObject({ readByPeer: true });
  });
  it("writes a sealed manifest and content-addressed chunks, then restores the history", async () => {
    const store = memoryStore();
    const snapshot = snapshotOf([{ chat: CHAT, count: 3, base: 0x1000 }], {
      tombstones: [{ messageId: uuid(0x9000), conversationId: CHAT, recipientId: PEER,
        unsentAt: 1_759_000_000_000, unsentBy: A }],
      deletedForMe: [{ messageId: uuid(0x9001), conversationId: null, deletedAt: 1_759_000_000_001 }],
      clears: [{ conversationId: CHAT, throughSequence: 2, clearedAt: 1_759_000_000_002 }],
    });
    const report = await upload(store, snapshot);
    expect(report).toEqual({ uploaded: 1, reused: 0, removed: 0, conversations: 1, messages: 3 });
    expect(store.names()).toHaveLength(2);
    expect(store.names()).toContain(MANIFEST);
    for (const name of chunkNames(store)) {
      expect(name.startsWith(`norfold.${A}.chunk.${DEVICE}.${CHAT}.`)).toBe(true);
      expect(name.endsWith(".v2.bin")).toBe(true);
      expect(isBackupName(name, A)).toBe(true);
    }

    // Nothing readable reaches Drive: neither manifest nor chunk carries a body.
    const raw = new TextDecoder().decode(new Uint8Array(store.raw(MANIFEST)));
    expect(raw.includes("text 1")).toBe(false);
    expect(raw.includes(CHAT)).toBe(false);
    for (const name of chunkNames(store)) {
      expect(new TextDecoder().decode(new Uint8Array(store.raw(name))).includes("text 2")).toBe(false);
    }

    const restored = await download(store, { scope: { ...scope, deviceId: OTHER_DEVICE } });
    expect(restored.manifest.accountId).toBe(A);
    expect(restored.manifest.deviceId).toBe(DEVICE);
    expect(restored.manifest.exportedAt).toBe(1_760_000_000_000);
    expect(restored.snapshot.messages).toEqual(snapshot.messages);
    expect(restored.snapshot.conversations).toEqual([
      { id: CHAT, lastSequence: 3, createdAt: 0, updatedAt: 0 },
    ]);
    expect(restored.snapshot.tombstones).toEqual(snapshot.tombstones);
    expect(restored.snapshot.deletedForMe).toEqual(snapshot.deletedForMe);
    expect(restored.snapshot.clears).toEqual(snapshot.clears);
  });

  it("re-uploads nothing when the snapshot has not changed", async () => {
    const store = memoryStore();
    const snapshot = snapshotOf([{ chat: CHAT, count: 3, base: 0x1000 }]);
    await upload(store, snapshot);
    const files = store.names();
    store.writes = [];
    const report = await upload(store, snapshot);
    expect(report).toMatchObject({ uploaded: 0, reused: 1, removed: 0 });
    expect(store.names()).toEqual(files);
    // Only the manifest is rewritten, so a crash before it cannot lose chunks.
    expect(store.writes).toEqual([MANIFEST]);
  });

  it("reuses a full part and uploads only the appended one across the 500-message bound", async () => {
    const store = memoryStore();
    await upload(store, snapshotOf([{ chat: CHAT, count: 500, base: 0x1000 }]));
    expect(chunkNames(store)).toHaveLength(1);
    const report = await upload(store, snapshotOf([{ chat: CHAT, count: 501, base: 0x1000 }]));
    expect(report).toMatchObject({ uploaded: 1, reused: 1, removed: 0, messages: 501 });
    expect(chunkNames(store)).toHaveLength(2);
    expect((await download(store)).snapshot.messages).toHaveLength(501);
  });

  it("compacts chunks the new manifest no longer references", async () => {
    const store = memoryStore();
    await upload(store, snapshotOf([{ chat: CHAT, count: 501, base: 0x1000 }]));
    const report = await upload(store, snapshotOf([{ chat: CHAT, count: 500, base: 0x1000 }], {
      deletedForMe: [{ messageId: uuid(0x1000 + 501), conversationId: CHAT, deletedAt: 10 }],
    }));
    expect(report).toMatchObject({ uploaded: 0, reused: 1, removed: 1, messages: 500 });
    expect(chunkNames(store)).toHaveLength(1);
    expect((await download(store)).snapshot.messages).toHaveLength(500);
  });

  it("re-uploads only the edited conversation and leaves the other chunk alone", async () => {
    const store = memoryStore();
    const base = snapshotOf([{ chat: CHAT, count: 3, base: 0x1000 },
      { chat: CHAT2, count: 3, base: 0x2000 }]);
    await upload(store, base);
    const other = chunkNames(store).find((name) => name.includes(CHAT2))!;

    const edited = structuredClone(base);
    edited.messages.find((message) => message.conversationId === CHAT && message.serverSequence === 2)!.body = "edited";
    const report = await upload(store, edited);
    expect(report).toMatchObject({ uploaded: 1, reused: 1, removed: 1 });
    expect(chunkNames(store)).toContain(other);
    expect(chunkNames(store)).toHaveLength(2);

    const restored = await download(store);
    expect(restored.snapshot.messages.find((message) => message.conversationId === CHAT
      && message.serverSequence === 2)!.body).toBe("edited");
    expect(restored.snapshot.messages).toHaveLength(6);
  });

  it("drops a conversation only when its messages have a matching clear", async () => {
    const store = memoryStore();
    await upload(store, snapshotOf([{ chat: CHAT, count: 2, base: 0x1000 },
      { chat: CHAT2, count: 2, base: 0x2000 }]));
    const report = await upload(store, snapshotOf([{ chat: CHAT, count: 2, base: 0x1000 }], {
      clears: [{ conversationId: CHAT2, throughSequence: 2, clearedAt: 10 }],
    }));
    expect(report).toMatchObject({ conversations: 1, removed: 1 });
    expect((await download(store)).snapshot.conversations.map((row) => row.id)).toEqual([CHAT]);

    const manifest = (await download(store)).manifest;
    expect(manifest.conversations.every((entry) => entry.parts.length > 0)).toBe(true);
  });

  it("refuses a message whose conversation is missing from the snapshot", async () => {
    const store = memoryStore();
    const snapshot = snapshotOf([{ chat: CHAT, count: 1, base: 0x1000 }]);
    snapshot.conversations = [];
    await expect(upload(store, snapshot)).rejects.toMatchObject({ code: "backup: invalid manifest" });
    expect(store.names()).toEqual([]);
  });

  it("keeps the previous backup readable when the new manifest cannot be written", async () => {
    const store = memoryStore();
    const first = snapshotOf([{ chat: CHAT, count: 3, base: 0x1000 }]);
    await upload(store, first);
    const files = store.names();

    const second = structuredClone(first);
    second.messages[0]!.body = "newer";
    store.failManifestWrite = true;
    await expect(upload(store, second)).rejects.toThrow("manifest write refused");
    store.failManifestWrite = false;
    // The new chunk is an orphan beside the old manifest, never a replacement.
    expect(store.names().length).toBe(files.length + 1);
    const restored = await download(store);
    expect(restored.snapshot.messages).toEqual(first.messages);
  });

  it("refuses a corrupt manifest even with repair requested: prior coverage is unknowable", async () => {
    const store = memoryStore();
    const snapshot = snapshotOf([{ chat: CHAT, count: 2, base: 0x1000 }]);
    await upload(store, snapshot);
    const manifestFile = (await store.list()).find((file) => file.name === MANIFEST)!;
    await store.write({ id: manifestFile.id, name: MANIFEST,
      bytes: new TextEncoder().encode("not a sealed manifest").buffer as ArrayBuffer });

    await expect(download(store)).rejects.toBeInstanceOf(Error);
    await expect(upload(store, snapshot)).rejects.toBeInstanceOf(Error);

    const names = store.names(), bytes = store.raw(MANIFEST);
    store.writes = [];
    await expect(upload(store, snapshot, { repair: true })).rejects.toBeInstanceOf(Error);
    expect(store.names()).toEqual(names);
    expect(store.writes).toEqual([]);
    expect(new Uint8Array(store.raw(MANIFEST))).toEqual(new Uint8Array(bytes));
  });

  it("never deletes the only manifest before a repair is durable", async () => {
    const store = memoryStore();
    const snapshot = snapshotOf([{ chat: CHAT, count: 2, base: 0x1000 }]);
    await upload(store, snapshot);
    const manifestFile = (await store.list()).find((file) => file.name === MANIFEST)!;
    const corrupt = new TextEncoder().encode("not a sealed manifest").buffer as ArrayBuffer;
    await store.write({ id: manifestFile.id, name: MANIFEST, bytes: corrupt });
    const files = store.names();

    store.failManifestWrite = true;
    await expect(upload(store, snapshot, { repair: true })).rejects.toBeInstanceOf(Error);
    store.failManifestWrite = false;
    // The unreadable-but-present manifest is preserved, not swapped for nothing.
    expect(store.names()).toEqual(expect.arrayContaining(files));
    expect(new Uint8Array(store.raw(MANIFEST))).toEqual(new Uint8Array(corrupt));
    expect((await store.list()).find((file) => file.name === MANIFEST)!.id).toBe(manifestFile.id);

    // Retrying cannot establish completeness of unreadable previous content.
    await expect(upload(store, snapshot, { repair: true })).rejects.toBeInstanceOf(Error);
    expect(store.names().filter((name) => name === MANIFEST)).toHaveLength(1);
    expect(new Uint8Array(store.raw(MANIFEST))).toEqual(new Uint8Array(corrupt));
  });

  it("keeps a committed backup when cleanup after publication fails", async () => {
    const store = memoryStore();
    await upload(store, snapshotOf([{ chat: CHAT, count: 501, base: 0x1000 }]));
    store.remove = async () => { throw new Error("cleanup refused"); };

    const report = await upload(store, snapshotOf([{ chat: CHAT, count: 500, base: 0x1000 }], {
      deletedForMe: [{ messageId: uuid(0x1000 + 501), conversationId: CHAT, deletedAt: 10 }],
    }));
    expect(report).toMatchObject({ uploaded: 0, reused: 1, removed: 0 });
    // The manifest is already durable, so the last readable backup is the new one.
    expect((await download(store)).snapshot.messages).toHaveLength(500);
  });

  it("refuses to publish an empty snapshot over a backup that still has history", async () => {
    const store = memoryStore();
    const snapshot = snapshotOf([{ chat: CHAT, count: 3, base: 0x1000 }]);
    await upload(store, snapshot);
    const names = store.names(), manifest = store.raw(MANIFEST);

    // A failed local read, a wiped store and an empty account look identical
    // here, so the pass refuses instead of compacting the history away.
    await expect(upload(store, snapshotOf([]))).rejects.toThrow("backup: empty snapshot");
    expect(store.names()).toEqual(names);
    expect(new Uint8Array(store.raw(MANIFEST))).toEqual(new Uint8Array(manifest));
    expect((await download(store)).snapshot.messages).toEqual(snapshot.messages);
  });

  it("refuses an empty rebuild once chunks exist under the account", async () => {
    const store = memoryStore();
    await upload(store, snapshotOf([{ chat: CHAT, count: 2, base: 0x1000 }]));
    const manifestFile = (await store.list()).find((file) => file.name === MANIFEST)!;
    await store.write({ id: manifestFile.id, name: MANIFEST,
      bytes: new TextEncoder().encode("broken").buffer as ArrayBuffer });
    const names = store.names();

    await expect(upload(store, snapshotOf([]), { repair: true })).rejects.toBeInstanceOf(Error);
    expect(store.names()).toEqual(names);
  });

  it.each([false, true])("never lets an incomplete second installation replace the first, unrelated clear=%s", async (unrelated) => {
    const store = memoryStore();
    const first = snapshotOf([{ chat: CHAT, count: 2, base: 0x1000 },
      { chat: CHAT2, count: 2, base: 0x2000 }]);
    await upload(store, first);
    const names = store.names(), manifest = store.raw(MANIFEST);
    const incomplete = snapshotOf(unrelated ? [] : [{ chat: CHAT2, count: 2, base: 0x2000 }], {
      clears: unrelated ? [{ conversationId: uuid(99), throughSequence: 100, clearedAt: 10 }] : [],
    });
    // A second installation owns a different manifest and chunk namespace, so an
    // incomplete local view can neither overwrite the first installation's
    // manifest nor compact the chunks it references.
    await upload(store, incomplete, { scope: { ...scope, deviceId: OTHER_DEVICE } });
    expect(new Uint8Array(store.raw(MANIFEST))).toEqual(new Uint8Array(manifest));
    expect(store.names()).toEqual(expect.arrayContaining(names));
    expect((await download(store)).snapshot.messages).toHaveLength(4);
  });

  it("refuses a missing tail without per-message retirement evidence", async () => {
    const store = memoryStore();
    await upload(store, snapshotOf([{ chat: CHAT, count: 501, base: 0x1000 }]));
    await expect(upload(store, snapshotOf([{ chat: CHAT, count: 500, base: 0x1000 }])))
      .rejects.toThrow("backup: incomplete snapshot");
    expect((await download(store)).snapshot.messages).toHaveLength(501);
  });

  it.each(["clears", "tombstones", "deletedForMe"] as const)("retains prior %s even when a newer installation has messages", async (kind) => {
    const store = memoryStore();
    const first = snapshotOf([{ chat: CHAT, count: 2, base: 0x1000 }], {
      clears: [{ conversationId: CHAT2, throughSequence: 9, clearedAt: 10 }],
      tombstones: [{ messageId: uuid(900), conversationId: CHAT2, recipientId: PEER, unsentBy: A, unsentAt: 10 }],
      deletedForMe: [{ messageId: uuid(901), conversationId: CHAT2, deletedAt: 10 }],
    });
    await upload(store, first);
    const incomplete = structuredClone(first); incomplete[kind] = [];
    await expect(upload(store, incomplete)).rejects.toThrow("backup: incomplete snapshot");
    expect((await download(store)).snapshot[kind]).toEqual(first[kind]);
  });

  it("refuses a regressed clear watermark or resurrection of a suppressed body", async () => {
    const store = memoryStore();
    const first = snapshotOf([{ chat: CHAT, count: 2, base: 0x1000 }], {
      clears: [{ conversationId: CHAT2, throughSequence: 9, clearedAt: 10 }],
    });
    first.messages[0]!.body = null; first.messages[0]!.unsentAt = 10;
    await upload(store, first);
    const regressed = structuredClone(first); regressed.clears[0]!.throughSequence = 8;
    await expect(upload(store, regressed)).rejects.toThrow("backup: incomplete snapshot");
    const resurrected = structuredClone(first); resurrected.messages[0]!.body = "stale"; resurrected.messages[0]!.unsentAt = null;
    await expect(upload(store, resurrected)).rejects.toThrow("backup: incomplete snapshot");
  });

  it("still records a deletion the snapshot itself proves", async () => {
    const store = memoryStore();
    await upload(store, snapshotOf([{ chat: CHAT, count: 2, base: 0x1000 }]));
    const cleared = snapshotOf([{ chat: CHAT, count: 0, base: 0x1000 }], {
      clears: [{ conversationId: CHAT, throughSequence: 2, clearedAt: 1_759_000_000_000 }],
    });

    const report = await upload(store, cleared);
    expect(report).toMatchObject({ uploaded: 0, reused: 0, removed: 1, conversations: 0, messages: 0 });
  });

  it("reports a missing chunk and a replaced chunk instead of returning partial history", async () => {
    const store = memoryStore();
    const snapshot = snapshotOf([{ chat: CHAT, count: 2, base: 0x1000 }]);
    await upload(store, snapshot);
    const manifest = (await download(store)).manifest;
    const part = manifest.conversations[0]!.parts[0]!;
    const file = (await store.list()).find((entry) => entry.name === part.chunk)!;

    await store.remove(file.id);
    await expect(download(store)).rejects.toMatchObject({ code: "backup: chunk missing" });

    const keyValue = await key();
    await store.write({ name: part.chunk,
      bytes: await sealBackupObject(keyValue, part.chunk,
        new TextEncoder().encode(JSON.stringify({ version: 1, messages: [] }))) });
    await expect(download(store)).rejects.toMatchObject({ code: "backup: chunk mismatch" });
  });

  it("isolates two Norfold accounts sharing one Drive app folder", async () => {
    const store = memoryStore();
    const otherScope = { accountId: uuid(3), deviceId: OTHER_DEVICE };
    await upload(store, snapshotOf([{ chat: CHAT, count: 2, base: 0x1000 }]));
    const files = store.names();

    // Another account sees no backup and cannot download this one.
    await expect(download(store, { scope: otherScope }))
      .rejects.toMatchObject({ code: "backup: chunk missing" });

    // Its own pass neither adopts nor compacts the first account's objects.
    const other = snapshotOf([{ chat: CHAT2, count: 2, base: 0x2000 }]);
    other.messages.forEach((message) => { message.recipientId = otherScope.accountId; });
    await upload(store, other, { scope: otherScope });
    expect(store.names()).toEqual(expect.arrayContaining(files));
    expect((await download(store)).snapshot.messages).toHaveLength(2);
  });

  it("refuses a manifest that claims another account, even when it opens", async () => {
    const store = memoryStore();
    await upload(store, snapshotOf([{ chat: CHAT, count: 1, base: 0x1000 }]));
    const claimed = structuredClone((await download(store)).manifest);
    const foreignScope = { accountId: uuid(3), deviceId: OTHER_DEVICE };
    claimed.accountId = A;
    const foreignName = manifestName(foreignScope.accountId, foreignScope.deviceId);
    await store.write({ name: foreignName,
      bytes: await sealBackupObject(await key(), foreignName,
        new TextEncoder().encode(JSON.stringify(claimed))) });
    await expect(download(store, { scope: foreignScope }))
      .rejects.toMatchObject({ code: "backup: account mismatch" });
  });

  it("fails closed for a rotated key generation", async () => {
    const store = memoryStore();
    await upload(store, snapshotOf([{ chat: CHAT, count: 1, base: 0x1000 }]));
    const rotated = await importBackupKey(uuid(31), "cd".repeat(32));
    await expect(download(store, { key: rotated }))
      .rejects.toMatchObject({ code: "backup: decryption failed" });
  });

  it("refuses an unusable timestamp and a foreign-account snapshot", async () => {
    const store = memoryStore();
    for (const now of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 2]) {
      await expect(upload(store, snapshotOf([{ chat: CHAT, count: 1, base: 0x1000 }]), { now }))
        .rejects.toBeInstanceOf(Error);
    }
    const foreign = snapshotOf([{ chat: CHAT, count: 1, base: 0x1000 }]);
    foreign.messages[0]!.authorId = uuid(4);
    foreign.messages[0]!.recipientId = uuid(5);
    await expect(upload(store, foreign)).rejects.toBeInstanceOf(Error);
    expect(store.names()).toEqual([]);
  });
});

describe("the manifest contract", () => {
  const base = (): BackupManifest => ({
    format: BACKUP_FORMAT, version: BACKUP_VERSION, accountId: A, deviceId: DEVICE,
    generation: GEN, exportedAt: 1_760_000_000_000,
    conversations: [{ conversationId: CHAT, headSequence: 2, parts: [{
      part: 1, chunk: chunkName(A, DEVICE, CHAT, "11".repeat(32)), sha256: "11".repeat(32),
      bytes: 128, messages: 2, firstSequence: 1, lastSequence: 2,
    }] }],
    tombstones: [], deletedForMe: [], clears: [],
  });
  /** Re-derive names the way an honest writer would, unless the case says not to. */
  const rehash = (manifest: BackupManifest): BackupManifest => {
    for (const entry of manifest.conversations ?? []) {
      for (const part of entry.parts ?? []) {
        part.chunk = chunkName(manifest.accountId, manifest.deviceId, entry.conversationId, part.sha256);
      }
    }
    return manifest;
  };
  const reject = (mutate: (manifest: BackupManifest) => unknown, deriveNames = true) => {
    expect(() => {
      const manifest = mutate(base()) as BackupManifest;
      return parseManifest(deriveNames ? rehash(manifest) : manifest);
    }).toThrow(BackupDriveError);
  };

  it("accepts its own shape and names chunks by account, device, conversation and hash", () => {
    expect(parseManifest(rehash(base()))).toEqual(base());
    expect(chunkName(A, DEVICE, CHAT, "11".repeat(32)))
      .toBe(`norfold.${A}.chunk.${DEVICE}.${CHAT}.${"11".repeat(32)}.v2.bin`);
    expect(manifestName(A, DEVICE)).toBe(MANIFEST);
    expect(() => chunkName("not-a-uuid", DEVICE, CHAT, "11".repeat(32))).toThrow(BackupDriveError);
    expect(() => chunkName(A, "not-a-uuid", CHAT, "11".repeat(32))).toThrow(BackupDriveError);
    expect(() => chunkName(A, DEVICE, CHAT, "11")).toThrow(BackupDriveError);
    // A legacy v1 backup is still recognised as this account's, never another's.
    expect(isBackupName(MANIFEST, uuid(3))).toBe(false);
    expect(isBackupName(legacyManifestName(A), A)).toBe(true);
    expect(isBackupName(legacyChunkName(A, CHAT, "11".repeat(32)), A)).toBe(true);
    expect(isBackupName(legacyManifestName(A), uuid(3))).toBe(false);
    expect(isBackupName("norfold.loose.txt", A)).toBe(false);
  });

  it.each([
    ["unknown format", (m: BackupManifest) => ({ ...m, format: "other" })],
    ["unsupported version", (m: BackupManifest) => ({ ...m, version: 3 })],
    ["extra key", (m: BackupManifest) => ({ ...m, extra: 1 })],
    ["bad account", (m: BackupManifest) => ({ ...m, accountId: "nope" })],
    ["no exportedAt", (m: BackupManifest) => ({ ...m, exportedAt: 0 })],
    ["duplicate conversation", (m: BackupManifest) => ({ ...m,
      conversations: [m.conversations[0], m.conversations[0]] })],
    ["part-less conversation", (m: BackupManifest) => ({ ...m,
      conversations: [{ ...m.conversations[0]!, parts: [] }] })],
    ["part number out of order", (m: BackupManifest) => ({ ...m,
      conversations: [{ ...m.conversations[0]!, parts: [{ ...m.conversations[0]!.parts[0]!, part: 2 }] }] })],
    ["chunk bytes over the bound", (m: BackupManifest) => ({ ...m,
      conversations: [{ ...m.conversations[0]!,
        parts: [{ ...m.conversations[0]!.parts[0]!, bytes: 3 * 1024 * 1024 }] }] })],
    ["zero messages in a part", (m: BackupManifest) => ({ ...m,
      conversations: [{ ...m.conversations[0]!,
        parts: [{ ...m.conversations[0]!.parts[0]!, messages: 0 }] }] })],
    ["head below the last sequence", (m: BackupManifest) => ({ ...m,
      conversations: [{ ...m.conversations[0]!, headSequence: 1 }] })],
    ["sequence range inverted", (m: BackupManifest) => ({ ...m,
      conversations: [{ ...m.conversations[0]!,
        parts: [{ ...m.conversations[0]!.parts[0]!, firstSequence: 3, lastSequence: 2 }] }] })],
    ["overlapping parts", (m: BackupManifest) => ({ ...m,
      conversations: [{ ...m.conversations[0]!, headSequence: 4, parts: [
        m.conversations[0]!.parts[0]!,
        { ...m.conversations[0]!.parts[0]!, part: 2, sha256: "33".repeat(32),
          firstSequence: 2, lastSequence: 4, messages: 1 },
      ] }] })],
    ["duplicate chunk", (m: BackupManifest) => ({ ...m,
      conversations: [{ ...m.conversations[0]!, headSequence: 4, parts: [
        m.conversations[0]!.parts[0]!,
        { ...m.conversations[0]!.parts[0]!, part: 2, firstSequence: 3, lastSequence: 4 },
      ] }] })],
    ["too many conversations", (m: BackupManifest) => ({ ...m,
      conversations: Array.from({ length: 513 }, () => m.conversations[0]!) })],
    ["malformed tombstone", (m: BackupManifest) => ({ ...m,
      tombstones: [{ messageId: "x", conversationId: CHAT, recipientId: null,
        unsentAt: 1, unsentBy: A }] })],
    ["malformed deletion", (m: BackupManifest) => ({ ...m,
      deletedForMe: [{ messageId: uuid(0x9000), conversationId: "x", deletedAt: 1 }] })],
    ["malformed clear", (m: BackupManifest) => ({ ...m,
      clears: [{ conversationId: CHAT, throughSequence: 0, clearedAt: 1 }] })],
  ])("rejects %s", (_label, mutate) => reject(mutate));

  it("rejects a chunk whose name does not carry its own hash", () => {
    reject((m) => {
      m.conversations[0]!.parts[0]!.chunk = chunkName(A, DEVICE, CHAT, "22".repeat(32));
      return m;
    }, false);
  });

  it("rejects a chunk belonging to another conversation, device or account", () => {
    reject((m) => {
      m.conversations[0]!.parts[0]!.chunk = chunkName(A, DEVICE, CHAT2, m.conversations[0]!.parts[0]!.sha256);
      return m;
    }, false);
    reject((m) => {
      m.conversations[0]!.parts[0]!.chunk = chunkName(A, OTHER_DEVICE, CHAT, m.conversations[0]!.parts[0]!.sha256);
      return m;
    }, false);
    reject((m) => {
      m.conversations[0]!.parts[0]!.chunk = chunkName(uuid(3), DEVICE, CHAT, m.conversations[0]!.parts[0]!.sha256);
      return m;
    }, false);
  });
});

/**
 * Write a version-1 backup exactly as the previous single-manifest writer did:
 * `norfold.<account>.manifest.v1.bin` plus `norfold.<account>.chunk.<chat>.<sha>.v1.bin`.
 */
async function writeLegacyBackup(store: MemoryStore, snapshot: HistorySnapshot): Promise<string[]> {
  const keyValue = await key();
  const messages = snapshot.messages.map((message) => ({
    id: message.id, conversationId: message.conversationId, authorId: message.authorId,
    recipientId: message.recipientId, body: message.body, messageType: message.messageType ?? null,
    contextReportId: message.contextReportId ?? null, location: message.location ?? null,
    serverEventId: message.serverEventId, serverSequence: message.serverSequence,
    unsentAt: message.unsentAt, createdAt: message.createdAt,
  }));
  const plaintext = new TextEncoder().encode(JSON.stringify({ version: 1, messages }));
  const sha256 = await sha256Hex(plaintext);
  const conversation = snapshot.conversations[0]!;
  const chunk = legacyChunkName(A, conversation.id, sha256);
  const sealed = await sealBackupObject(keyValue, chunk, plaintext);
  await store.write({ name: chunk, bytes: sealed });
  const manifest: BackupManifest = {
    format: BACKUP_FORMAT, version: 1, accountId: A, deviceId: DEVICE, generation: GEN,
    exportedAt: 1_750_000_000_000,
    conversations: [{ conversationId: conversation.id, headSequence: conversation.lastSequence,
      parts: [{ part: 1, chunk, sha256, bytes: sealed.byteLength, messages: messages.length,
        firstSequence: 1, lastSequence: conversation.lastSequence }] }],
    tombstones: snapshot.tombstones, deletedForMe: snapshot.deletedForMe, clears: snapshot.clears,
  };
  const name = legacyManifestName(A);
  await store.write({ name, bytes: await sealBackupObject(keyValue, name,
    new TextEncoder().encode(JSON.stringify(manifest))) });
  return [chunk, name];
}

/**
 * Two installations of the same account share one Drive app folder. Each one
 * owns a manifest and a chunk namespace of its own, so neither publication nor
 * compaction can overwrite or dangle the other's objects; reading unions them.
 */
describe("two installations writing one account", () => {
  const second = { accountId: A, deviceId: OTHER_DEVICE };
  const A_MANIFEST = manifestName(A, DEVICE);
  const B_MANIFEST = manifestName(A, OTHER_DEVICE);
  const NOW = 1_760_000_000_000;

  it("publishes one manifest per installation instead of one shared file", async () => {
    const store = memoryStore();
    await upload(store, snapshotOf([{ chat: CHAT, count: 2, base: 0x1000 }]));
    await upload(store, snapshotOf([{ chat: CHAT2, count: 3, base: 0x2000 }]),
      { scope: second, now: NOW + 1 });
    expect(store.names()).toEqual(expect.arrayContaining([A_MANIFEST, B_MANIFEST]));
    expect(chunkNames(store)).toHaveLength(2);
    expect(chunkNames(store).some((name) => name.includes(`.chunk.${OTHER_DEVICE}.${CHAT2}.`))).toBe(true);
  });

  it("restores the union rather than discarding the other installation's history", async () => {
    const store = memoryStore();
    await upload(store, snapshotOf([{ chat: CHAT, count: 2, base: 0x1000 }]));
    await upload(store, snapshotOf([{ chat: CHAT2, count: 3, base: 0x2000 }]),
      { scope: second, now: NOW + 1 });

    const restored = await download(store);
    expect(restored.snapshot.messages).toHaveLength(5);
    expect(restored.snapshot.conversations.map((row) => row.id).sort()).toEqual([CHAT, CHAT2].sort());
    // The newest contributing snapshot identifies the restore, not the reader's device.
    expect(restored.manifest.deviceId).toBe(OTHER_DEVICE);
  });

  it("compacts only its own installation's superseded chunks", async () => {
    const store = memoryStore();
    await upload(store, snapshotOf([{ chat: CHAT, count: 3, base: 0x1000 }]));
    await upload(store, snapshotOf([{ chat: CHAT2, count: 2, base: 0x2000 }]), { scope: second });
    const foreign = chunkNames(store).filter((name) => name.includes(`.chunk.${OTHER_DEVICE}.`));
    expect(foreign).toHaveLength(1);

    // This installation retires a message: its own chunk goes, the other's stays.
    await upload(store, snapshotOf([{ chat: CHAT, count: 2, base: 0x1000 }], {
      deletedForMe: [{ messageId: uuid(0x1000 + 3), conversationId: CHAT, deletedAt: 10 }],
    }));
    expect(chunkNames(store)).toEqual(expect.arrayContaining(foreign));
    expect((await download(store)).snapshot.messages).toHaveLength(4);
  });

  it("never leaves a published manifest pointing at a deleted chunk", async () => {
    const store = memoryStore();
    await upload(store, snapshotOf([{ chat: CHAT, count: 2, base: 0x1000 }]));
    await upload(store, snapshotOf([{ chat: CHAT2, count: 2, base: 0x2000 }]), { scope: second });
    // Each installation then replaces its own snapshot twice, in both orders.
    for (const body of ["one", "two"]) {
      const edit = snapshotOf([{ chat: CHAT, count: 2, base: 0x1000,
        body: (seq: number) => `${body}-${seq}` }]);
      await upload(store, edit);
      const other = snapshotOf([{ chat: CHAT2, count: 2, base: 0x2000,
        body: (seq: number) => `${body}-${seq}` }]);
      await upload(store, other, { scope: second });
    }
    const restored = await download(store);
    expect(restored.snapshot.messages).toHaveLength(4);
    expect(restored.snapshot.messages.filter((row) => row.conversationId === CHAT)
      .map((row) => row.body)).toEqual(["two-1", "two-2"]);
  });

  it("does not resurrect a body another installation recorded as suppressed", async () => {
    const store = memoryStore();
    const live = snapshotOf([{ chat: CHAT, count: 2, base: 0x1000 }]);
    const suppressed = structuredClone(live);
    const target = suppressed.messages[1]!;
    target.body = null; target.unsentAt = 500;
    suppressed.tombstones = [{ messageId: target.id, conversationId: CHAT,
      recipientId: PEER, unsentAt: 500, unsentBy: A }];

    await upload(store, suppressed);
    await upload(store, live, { scope: second, now: NOW + 1 });
    const restored = await download(store);
    const restoredTarget = restored.snapshot.messages.find((row) => row.id === target.id)!;
    expect(restoredTarget.body).toBeNull();
    expect(restoredTarget.unsentAt).toBe(500);
  });

  it("refuses to guess which installation to drop when the manifest bound is exceeded", async () => {
    const store = memoryStore();
    // Every reinstall can leave its own manifest behind; past the bound a restore
    // fails closed instead of silently ignoring one installation's history.
    for (let index = 0; index < 17; index++) {
      const deviceId = uuid(0x200 + index);
      const snapshot = snapshotOf([{ chat: CHAT, count: 1, base: 0x3000 + index * 0x10 }]);
      await upload(store, snapshot, { scope: { accountId: A, deviceId }, now: NOW + index });
    }
    await expect(download(store)).rejects.toMatchObject({ code: "backup: invalid manifest" });
  });

  it("keeps a legacy single-manifest backup readable and untouched", async () => {
    const store = memoryStore();
    const legacy = await writeLegacyBackup(store, snapshotOf([{ chat: CHAT, count: 2, base: 0x7000 }]));

    const restored = await download(store);
    expect(restored.snapshot.messages).toHaveLength(2);
    expect(restored.manifest.version).toBe(1);

    // The first version-2 pass covers the legacy history and never rewrites it.
    await upload(store, structuredClone(restored.snapshot));
    expect(store.names()).toEqual(expect.arrayContaining(legacy));
    expect(store.names()).toEqual(expect.arrayContaining([A_MANIFEST]));
    expect((await download(store)).snapshot.messages).toHaveLength(2);
  });
});
