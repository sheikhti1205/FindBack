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
  manifestName,
  parseManifest,
  uploadBackup,
  type BackupDriveStore,
  type BackupManifest,
} from "./backupDrive";
import { importBackupKey, sealBackupObject } from "./backupCrypto";

const uuid = (n: number) => `00000000-0000-4000-9d02-${n.toString(16).padStart(12, "0")}`;
const A = uuid(1);
const PEER = uuid(2);
const CHAT = uuid(10);
const CHAT2 = uuid(11);
const DEVICE = uuid(20);
const OTHER_DEVICE = uuid(21);
const GEN = uuid(30);
const KEY_HEX = "ab".repeat(32);
const MANIFEST = manifestName(A);

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

const chunkNames = (store: MemoryStore) => store.names().filter((name) => name !== MANIFEST);

describe("an encrypted Drive backup", () => {
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
      expect(name.startsWith(`norfold.${A}.chunk.${CHAT}.`)).toBe(true);
      expect(name.endsWith(".v1.bin")).toBe(true);
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
    const report = await upload(store, snapshotOf([{ chat: CHAT, count: 500, base: 0x1000 }]));
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

  it("drops a conversation whose messages are all gone, and describes none without parts", async () => {
    const store = memoryStore();
    await upload(store, snapshotOf([{ chat: CHAT, count: 2, base: 0x1000 },
      { chat: CHAT2, count: 2, base: 0x2000 }]));
    const report = await upload(store, snapshotOf([{ chat: CHAT, count: 2, base: 0x1000 }]));
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

  it("fails closed on a corrupt manifest and rebuilds only when repair is asked for", async () => {
    const store = memoryStore();
    const snapshot = snapshotOf([{ chat: CHAT, count: 2, base: 0x1000 }]);
    await upload(store, snapshot);
    const manifestFile = (await store.list()).find((file) => file.name === MANIFEST)!;
    await store.write({ id: manifestFile.id, name: MANIFEST,
      bytes: new TextEncoder().encode("not a sealed manifest").buffer as ArrayBuffer });

    await expect(download(store)).rejects.toBeInstanceOf(Error);
    await expect(upload(store, snapshot)).rejects.toBeInstanceOf(Error);

    const report = await upload(store, snapshot, { repair: true });
    expect(report).toMatchObject({ uploaded: 1, conversations: 1 });
    expect((await download(store)).snapshot.messages).toEqual(snapshot.messages);
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
    await expect(upload(store, snapshot, { repair: true })).rejects.toThrow("manifest write refused");
    store.failManifestWrite = false;
    // The unreadable-but-present manifest is preserved, not swapped for nothing.
    expect(store.names()).toEqual(expect.arrayContaining(files));
    expect(new Uint8Array(store.raw(MANIFEST))).toEqual(new Uint8Array(corrupt));
    expect((await store.list()).find((file) => file.name === MANIFEST)!.id).toBe(manifestFile.id);

    // A later repair reuses that same object instead of creating a second manifest.
    await upload(store, snapshot, { repair: true });
    expect(store.names().filter((name) => name === MANIFEST)).toHaveLength(1);
    expect((await download(store)).snapshot.messages).toEqual(snapshot.messages);
  });

  it("keeps a committed backup when cleanup after publication fails", async () => {
    const store = memoryStore();
    await upload(store, snapshotOf([{ chat: CHAT, count: 501, base: 0x1000 }]));
    store.remove = async () => { throw new Error("cleanup refused"); };

    const report = await upload(store, snapshotOf([{ chat: CHAT, count: 500, base: 0x1000 }]));
    expect(report).toMatchObject({ uploaded: 0, reused: 1, removed: 0 });
    // The manifest is already durable, so the last readable backup is the new one.
    expect((await download(store)).snapshot.messages).toHaveLength(500);
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
        new TextEncoder().encode(JSON.stringify({ version: BACKUP_VERSION, messages: [] }))) });
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
    await store.write({ name: manifestName(foreignScope.accountId),
      bytes: await sealBackupObject(await key(), manifestName(foreignScope.accountId),
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
      part: 1, chunk: chunkName(A, CHAT, "11".repeat(32)), sha256: "11".repeat(32),
      bytes: 128, messages: 2, firstSequence: 1, lastSequence: 2,
    }] }],
    tombstones: [], deletedForMe: [], clears: [],
  });
  /** Re-derive names the way an honest writer would, unless the case says not to. */
  const rehash = (manifest: BackupManifest): BackupManifest => {
    for (const entry of manifest.conversations ?? []) {
      for (const part of entry.parts ?? []) {
        part.chunk = `norfold.${manifest.accountId}.chunk.${entry.conversationId}.${part.sha256}.v1.bin`;
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

  it("accepts its own shape and names chunks by account, conversation and hash", () => {
    expect(parseManifest(rehash(base()))).toEqual(base());
    expect(chunkName(A, CHAT, "11".repeat(32)))
      .toBe(`norfold.${A}.chunk.${CHAT}.${"11".repeat(32)}.v1.bin`);
    expect(manifestName(A)).toBe(MANIFEST);
    expect(() => chunkName("not-a-uuid", CHAT, "11".repeat(32))).toThrow(BackupDriveError);
    expect(() => chunkName(A, CHAT, "11")).toThrow(BackupDriveError);
    // Another account's objects are never treated as this account's.
    expect(isBackupName(MANIFEST, uuid(3))).toBe(false);
    expect(isBackupName("norfold.loose.txt", A)).toBe(false);
  });

  it.each([
    ["unknown format", (m: BackupManifest) => ({ ...m, format: "other" })],
    ["unsupported version", (m: BackupManifest) => ({ ...m, version: 2 })],
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
      m.conversations[0]!.parts[0]!.chunk = chunkName(A, CHAT, "22".repeat(32));
      return m;
    }, false);
  });

  it("rejects a chunk belonging to another conversation or account", () => {
    reject((m) => {
      m.conversations[0]!.parts[0]!.chunk = chunkName(A, CHAT2, m.conversations[0]!.parts[0]!.sha256);
      return m;
    }, false);
    reject((m) => {
      m.conversations[0]!.parts[0]!.chunk = chunkName(uuid(3), CHAT, m.conversations[0]!.parts[0]!.sha256);
      return m;
    }, false);
  });
});
