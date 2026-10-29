// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBDatabase, IDBObjectStore } from "fake-indexeddb";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWebMessagingHistory } from "./indexedDbHistory";
import { createBackup, decodeBackup, encodeBackup, restoreBackup } from "./backup";
import type { HistorySnapshot, MessagingHistory } from "./history";
import { openSqliteMessagingHistory } from "./sqliteHistory";

const id = (n: number) => `00000000-0000-4000-9902-${String(n).padStart(12, "0")}`;
const A = id(1), B = id(2), C = id(3), CHAT = id(10);
const scope = { accountId: A, deviceId: id(11) };
const empty = (): HistorySnapshot => ({ conversations: [], messages: [], tombstones: [], deletedForMe: [], clears: [] });
const saved = (n = 1) => ({ id: id(100 + n), conversationId: CHAT, authorId: B, recipientId: A,
  body: `text ${n}` as string | null, messageType: "TEXT" as "TEXT" | "MEDIA" | null,
  serverEventId: id(200 + n), serverSequence: n, unsentAt: null as number | null, createdAt: 0 });
function snapshot(n = 1): HistorySnapshot {
  return { ...empty(), conversations: [{ id: CHAT, lastSequence: n, createdAt: 0, updatedAt: 25 }], messages: [saved(n)] };
}
let factory: IDBFactory, handles: MessagingHistory[];
let scratch: string[];
async function open(deviceId = scope.deviceId) {
  const history = await openWebMessagingHistory({ ...scope, deviceId }, { indexedDB: factory });
  handles.push(history); return history;
}
async function receive(history: MessagingHistory, n = 1) {
  const row = saved(n);
  await history.persistInbound({ ...scope, mailboxId: id(300 + n), event: { kind: "TEXT",
    eventId: row.serverEventId, sequence: n, message: { id: row.id, conversationId: CHAT,
      authorId: B, recipientId: A, body: row.body!, messageType: "TEXT" } } });
}
beforeEach(() => { factory = new IDBFactory(); handles = []; scratch = []; });
afterEach(async () => {
  vi.restoreAllMocks(); await Promise.all(handles.map((history) => history.close()));
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

describe("portable IndexedDB history, not live delivery authority", () => {
  it("exports accepted history only and restores onto another installation without sends or cursors", async () => {
    const source = await open(); await receive(source);
    await source.enqueueOutgoing({ id: id(150), conversationId: CHAT, authorId: A, recipientId: B, body: "offline", messageType: "TEXT" });
    await source.markConversationRead(CHAT, 1);
    const backup = await createBackup(source, scope, 100);
    expect(backup.snapshot.messages).toEqual([saved()]);
    const target = await open(id(12));
    await restoreBackup(target, { ...scope, deviceId: id(12) }, encodeBackup(backup));
    expect(await target.listOutbox()).toEqual([]);
    expect(await target.getStateCursor()).toBeNull();
    expect(await target.getMessage(id(150))).toBeNull();
    expect(await target.getMessage(saved().id)).toMatchObject({ body: "text 1", server: { eventId: id(201), sequence: 1 } });
    expect((await target.listConversations())[0]).toMatchObject({ peerId: B, unreadCount: 1, cachedProjection: null });
    await target.close();
    const reopened = await open(id(12));
    expect((await reopened.exportSnapshot()).messages).toEqual([saved()]);
  });

  it("retains snapshot-only conversation metadata without inventing a participant or projection", async () => {
    const history = await open(); const input = empty();
    input.conversations.push({ id: CHAT, lastSequence: 5, createdAt: 7, updatedAt: 15 });
    await history.importSnapshot(input);
    expect(await history.listConversations()).toEqual([]);
    expect(await history.exportSnapshot()).toEqual(input);
    await receive(history);
    expect((await history.listConversations())[0]).toMatchObject({ peerId: B, cachedProjection: null });
    expect((await history.exportSnapshot()).conversations[0]).toMatchObject({ createdAt: 7, lastSequence: 5 });
  });

  it("refuses older web storage code after portable suppression is installed", async () => {
    const history = await open(); const input = snapshot(); input.messages[0]!.body = null;
    await history.importSnapshot(input); await history.close();
    // v5 did not understand snapshotSuppressed: reopening it would admit erased
    // image-only parents. An IDB version fence must reject that old executable.
    const oldOpen = new Promise<void>((resolve, reject) => {
      const request = factory.open(`findback-human-history-v1:${A}:${scope.deviceId}`, 5);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => { request.result.close(); resolve(); };
    });
    await expect(oldOpen).rejects.toMatchObject({ name: "VersionError" });
  });

  it("tombstone-before-original dominates restore and future mailbox replay without claiming a state cursor", async () => {
    const history = await open(); const tombstone = { messageId: id(101), conversationId: CHAT,
      recipientId: null, unsentBy: B, unsentAt: 20 };
    await history.importSnapshot({ ...empty(), tombstones: [tombstone] });
    await history.importSnapshot(snapshot()); await receive(history);
    expect(await history.getMessage(id(101))).toMatchObject({ body: "", unsentAt: 20 });
    const exported = await history.exportSnapshot();
    expect(exported.tombstones).toEqual([{ ...tombstone, recipientId: A }]);
    expect(exported.messages[0]).toMatchObject({ body: null, unsentAt: 20 });
    expect(await history.getStateCursor()).toBeNull();
  });

  it("personal deletion with an unknown conversation and clear-before-original survive replay", async () => {
    const history = await open(); const input = empty();
    input.deletedForMe.push({ messageId: id(101), conversationId: null, deletedAt: 20 });
    input.clears.push({ conversationId: CHAT, throughSequence: 2, clearedAt: 25 });
    await history.importSnapshot(input); await history.importSnapshot(snapshot()); await receive(history); await receive(history, 2);
    expect(await history.listMessages(CHAT)).toEqual([]);
    expect(await history.getMessage(id(101))).toBeNull();
    const exported = await history.exportSnapshot();
    expect(exported.messages.map((row) => row.body)).toEqual([null, null]);
    expect(exported.deletedForMe).toEqual(input.deletedForMe);
    expect(exported.clears).toEqual(input.clears);
  });

  it("distinguishes a suppressed null body from a legitimate image-only caption and preserves classification", async () => {
    const history = await open(); const input = snapshot();
    input.messages = [{ ...saved(), body: "", messageType: "MEDIA" }, { ...saved(2), body: null, messageType: "MEDIA" },
      { ...saved(3), messageType: null }];
    await history.importSnapshot(input);
    expect((await history.exportSnapshot()).messages.map((row) => [row.body, row.messageType])).toEqual([
      ["", "MEDIA"], [null, "MEDIA"], ["text 3", null],
    ]);
    await history.persistInbound({ ...scope, mailboxId: id(302), event: { kind: "TEXT", eventId: id(202), sequence: 2,
      message: { id: id(102), conversationId: CHAT, authorId: B, recipientId: A, body: "old caption", messageType: "MEDIA" } } });
    expect((await history.exportSnapshot()).messages[1]).toMatchObject({ body: null, messageType: "MEDIA" });
  });

  it("settles an identical pending accepted message without exporting or creating an outbox", async () => {
    const history = await open(); const incoming = snapshot();
    incoming.messages[0] = { ...saved(), authorId: A, recipientId: B };
    await history.enqueueOutgoing({ id: id(101), conversationId: CHAT, authorId: A, recipientId: B, body: "text 1", messageType: "TEXT" }, "a".repeat(64));
    await history.importSnapshot(incoming);
    expect(await history.listOutbox()).toEqual([]);
    expect(await history.claimNextOutgoing()).toBeNull();
    expect(await history.getMessage(id(101))).toMatchObject({ server: { eventId: id(201), sequence: 1 } });
  });

  it.each(["body", "author", "sequence", "event", "classification", "peer"])("rejects a %s identity contradiction atomically", async (conflict) => {
    const history = await open(); await history.importSnapshot(snapshot());
    const input = snapshot();
    // A valid unrelated row must also roll back, even if processed first.
    input.messages.unshift(saved(2));
    const row = input.messages[1]!;
    if (conflict === "body") row.body = "forged text";
    if (conflict === "author") { row.authorId = A; row.recipientId = B; }
    if (conflict === "sequence") row.serverSequence = 10;
    if (conflict === "event") row.serverEventId = id(800);
    if (conflict === "classification") row.messageType = "MEDIA";
    if (conflict === "peer") row.authorId = C;
    const before = await history.exportSnapshot();
    await expect(history.importSnapshot(input)).rejects.toThrow("backup: identity conflict");
    expect(await history.exportSnapshot()).toEqual(before);
    expect(await history.getStateCursor()).toBeNull();
  });

  it.each(["event", "sequence"])("rejects another message reusing an accepted %s identity", async (collision) => {
    const history = await open(); await history.importSnapshot(snapshot());
    const input = snapshot(2);
    if (collision === "event") input.messages[0]!.serverEventId = id(201);
    else input.messages[0]!.serverSequence = 1;
    await expect(history.importSnapshot(input)).rejects.toThrow("backup: identity conflict");
    expect((await history.exportSnapshot()).messages).toEqual([saved()]);
  });

  it("rejects a contradictory tombstone without erasing existing history", async () => {
    const history = await open(); await history.importSnapshot(snapshot());
    await expect(history.importSnapshot({ ...empty(), tombstones: [{ messageId: id(101), conversationId: CHAT,
      recipientId: B, unsentBy: A, unsentAt: 20 }] })).rejects.toThrow("backup: identity conflict");
    expect((await history.getMessage(id(101)))?.body).toBe("text 1");
  });

  it("merges accepted history and suppression independently of import order", async () => {
    const one = await open(), two = await open(id(12)); const visible = snapshot(); const removed = snapshot();
    removed.messages[0]!.body = null;
    removed.deletedForMe.push({ messageId: id(101), conversationId: CHAT, deletedAt: 20 });
    removed.conversations[0] = { id: CHAT, lastSequence: 3, createdAt: 7, updatedAt: 40 };
    await one.importSnapshot(visible); await one.importSnapshot(removed);
    await two.importSnapshot(removed); await two.importSnapshot(visible);
    expect(await one.exportSnapshot()).toEqual(await two.exportSnapshot());
    expect(await one.listMessages(CHAT)).toEqual([]);
  });

  it("rejects hostile accessors before queue cloning and captures caller data before a later mutation", async () => {
    const history = await open(); let reads = 0; const input = snapshot();
    Object.defineProperty(input.messages[0]!, "body", { enumerable: true, get() { reads++; return "text 1"; } });
    await expect(history.importSnapshot(input)).rejects.toThrow("backup: invalid snapshot");
    expect(reads).toBe(0);
    const safe = snapshot(); const importing = history.importSnapshot(safe); safe.messages[0]!.body = "late mutation";
    await importing;
    expect((await history.getMessage(id(101)))?.body).toBe("text 1");
  });

  it("rejects foreign-account data and digest corruption without any partial history", async () => {
    const source = await open(); await source.importSnapshot(snapshot());
    const backup = await createBackup(source, scope, 100);
    await expect(restoreBackup(source, { ...scope, accountId: C }, encodeBackup(backup))).rejects.toThrow("backup: account mismatch");
    const encoded = encodeBackup(backup).replace("text 1", "text X");
    await expect(decodeBackup(encoded)).rejects.toThrow("backup: digest mismatch");
    const target = await open(id(12)); const foreign = snapshot(); foreign.messages[0]!.recipientId = C;
    await expect(target.importSnapshot(foreign)).rejects.toThrow("backup: invalid snapshot");
    expect(await target.exportSnapshot()).toEqual(empty());
  });

  it.each(["abort", "close"])("rolls back a restore after successful writes on %s, including outbox settlement", async (failure) => {
    const history = await open(); const row = { ...saved(), authorId: A, recipientId: B };
    await history.enqueueOutgoing({ ...row, body: row.body!, messageType: "TEXT" });
    const original = IDBObjectStore.prototype.put;
    let writes = 0;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value, key) {
      const request = original.call(this, value, key);
      if (this.name === "messages") request.addEventListener("success", () => {
        writes++; if (failure === "close") void history.close(); else this.transaction.abort();
      });
      return request;
    });
    const input = snapshot(); input.messages[0] = row;
    await expect(history.importSnapshot(input)).rejects.toThrow(/aborted|closed/);
    expect(writes).toBe(1);
    vi.restoreAllMocks(); await history.close();
    const reopened = await open();
    expect(await reopened.listOutbox()).toHaveLength(1);
    expect((await reopened.getMessage(row.id))?.server).toBeUndefined();
    expect((await reopened.exportSnapshot()).messages).toEqual([]);
  });

  it("resolves a restore only after strict transaction completion, without creating mailbox/state rows", async () => {
    const history = await open(); let completed = false;
    const original = IDBDatabase.prototype.transaction;
    vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, names, mode, options) {
      const tx = original.call(this, names, mode, options);
      if (mode === "readwrite") {
        expect(tx.durability).toBe("strict");
        tx.addEventListener("complete", () => { completed = true; });
      }
      return tx;
    });
    expect(await history.importSnapshot(snapshot())).toEqual({ conversations: 1, messages: 1, tombstones: 0, deletedForMe: 0, clears: 0 });
    expect(completed).toBe(true);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(`findback-human-history-v1:${A}:${scope.deviceId}`);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      const counts = await Promise.all(["outbox", "mailbox", "stateEvents"].map((name) => new Promise<number>((resolve, reject) => {
        const request = db.transaction(name).objectStore(name).count();
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      })));
      expect(counts).toEqual([0, 0, 0]);
    } finally { db.close(); }
  });

  it("binds portable unbound suppression to matching real state metadata, never to a contradictory unsend time", async () => {
    const history = await open();
    await history.importSnapshot({ ...empty(), tombstones: [{ messageId: id(101), conversationId: CHAT,
      recipientId: null, unsentBy: B, unsentAt: 20 }] });
    const change = { kind: "UNSEND" as const, eventId: id(600), sequence: 1, occurredAt: 20,
      conversationId: CHAT, messageId: id(101), authorId: B, recipientId: A, messageSequence: 1 };
    await history.applyStateChange({ ...scope, change }); await receive(history);
    expect(await history.getStateCursor()).toEqual({ eventId: id(600), sequence: 1 });
    expect((await history.exportSnapshot()).messages[0]).toMatchObject({ body: null, unsentAt: 20 });
    const other = await open(id(12)); const input = snapshot();
    input.messages[0] = { ...saved(), body: null, unsentAt: 20 };
    await other.importSnapshot(input);
    await expect(other.applyStateChange({ ...scope, deviceId: id(12), change: { ...change, occurredAt: 21 } })).rejects.toThrow(/identity conflict/);
    expect(await other.getStateCursor()).toBeNull();
  });

  it.each([[20, 10], [10, 20]])("round-trips history and earliest deletion metadata through SQLite (%i then %i)", async (first, second) => {
    const source = await open(); const input = snapshot();
    input.messages.push({ ...saved(2), body: "", messageType: "MEDIA" }, { ...saved(3), body: null, messageType: "MEDIA" });
    input.deletedForMe.push({ messageId: id(101), conversationId: CHAT, deletedAt: first });
    await source.importSnapshot(input);
    // Disposable, single-test database, not a worktree or retained evidence.
    const dir = mkdtempSync(join(tmpdir(), "findback-web-backup-")); scratch.push(dir);
    const db = new DatabaseSync(join(dir, "roundtrip.db"));
    const native = await openSqliteMessagingHistory({ exec: (sql) => { db.exec(sql); },
      all: (sql, params = []) => db.prepare(sql).all(...params) as never,
      run: (sql, params = []) => Number(db.prepare(sql).run(...params).changes), close: () => db.close(),
    }, { ...scope, deviceId: id(13) }, { now: () => 30 });
    handles.push(native);
    await restoreBackup(native, { ...scope, deviceId: id(13) }, encodeBackup(await createBackup(source, scope, 100)));
    const later = { ...empty(), deletedForMe: [{ messageId: id(101), conversationId: CHAT, deletedAt: second }] };
    await source.importSnapshot(later); await native.importSnapshot(later);
    const target = await open(id(12));
    await restoreBackup(target, { ...scope, deviceId: id(12) }, encodeBackup(await createBackup(native, { ...scope, deviceId: id(13) }, 101)));
    expect((await target.exportSnapshot()).messages).toEqual((await source.exportSnapshot()).messages);
    const expectedDeletion = [{ messageId: id(101), conversationId: CHAT, deletedAt: 10 }];
    expect((await target.exportSnapshot()).deletedForMe).toEqual(expectedDeletion);
    expect((await source.exportSnapshot()).deletedForMe).toEqual(expectedDeletion);
    expect(await target.listMessages(CHAT)).toHaveLength(2);
    expect(await native.listOutbox()).toEqual([]); expect(await target.listOutbox()).toEqual([]);
    expect(await native.getStateCursor()).toBeNull(); expect(await target.getStateCursor()).toBeNull();
  });
});
