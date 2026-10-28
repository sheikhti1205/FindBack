// @vitest-environment node
/** Real byte-store composition, not native/browser durability acceptance. */
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HumanMessage, MessagingHistory } from "./history";
import { openWebMessagingHistory } from "./indexedDbHistory";
import { openSqliteMessagingHistory } from "./sqliteHistory";
import { openMediaBytes, type MediaBytesStore } from "./mediaBytes";
import { MEDIA_SWEEP_GRACE_MS } from "./media";
import { deferred, mediaFixture } from "./mediaTestDoubles";

// Synthetic identifiers, never credentials or production account records.
const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const A = id(1), B = id(2), DEVICE = id(3), CONVERSATION = id(20);
const scope = { accountId: A, deviceId: DEVICE };
const LOCK = `findback-messaging:${A}`;
const message = (n: number): HumanMessage => ({ id: id(100 + n), conversationId: CONVERSATION,
  authorId: A, recipientId: B, body: "caption" });

describe.each(["sqlite", "web"] as const)("%s media with actual byte storage", (backend) => {
  let factory: IDBFactory, bytes: MediaBytesStore, directory: string, clock: number;
  let histories: MessagingHistory[];

  beforeEach(async () => {
    factory = new IDBFactory(); histories = []; clock = 1_700_000_000_000;
    directory = mkdtempSync("/tmp/opencode/media-adapters-"); // disposable single-run DBs only
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    bytes = await openMediaBytes({ indexedDB: factory, now: () => clock,
      databaseName: `media-${backend}-${DEVICE}`, budgetBytes: 256 });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(histories.map((history) => history.close()));
    await bytes.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function open(): Promise<MessagingHistory> {
    const options = { mediaBytes: bytes, decodeMedia: async () => undefined };
    let history: MessagingHistory;
    if (backend === "web") history = await openWebMessagingHistory(scope, { ...options, indexedDB: factory });
    else {
      const db = new DatabaseSync(join(directory, "history.db"));
      history = await openSqliteMessagingHistory({
        exec: async (sql) => { await Promise.resolve(); db.exec(sql); },
        all: async <T>(sql: string, params: readonly (string | number | null)[] = []) => {
          await Promise.resolve(); return db.prepare(sql).all(...params) as T[];
        },
        run: async (sql, params = []) => {
          await Promise.resolve(); return Number(db.prepare(sql).run(...params).changes);
        },
        close: async () => { await Promise.resolve(); db.close(); },
      }, scope, { ...options, now: () => clock });
    }
    histories.push(history);
    await history.cacheConversation({ conversationId: CONVERSATION, peerId: B, mode: "CONNECTED", request: "NONE",
      requestEpoch: null, ownBlocked: false, ownDeclined: false, ownHidden: false, revision: 1 });
    return history;
  }

  async function receive(history: MessagingHistory, n: number) {
    await history.persistInbound({ ...scope, mailboxId: id(400 + n), event: { kind: "TEXT",
      eventId: id(300 + n), sequence: n, message: { ...message(n), authorId: B, recipientId: A } } });
    const fixture = await mediaFixture(id(200 + n), message(n).id, { direction: "IN", expiresAt: clock + 10_000 });
    await history.persistVerifiedMediaAndAck(fixture.metadata, fixture.bytes, async () => undefined);
    return fixture;
  }

  it("rejects a full protected budget without admitting a message or attachment", async () => {
    await bytes.close();
    bytes = await openMediaBytes({ indexedDB: factory, databaseName: "tiny-budget", budgetBytes: 64 });
    const history = await open();
    const first = await mediaFixture(id(201), message(1).id), second = await mediaFixture(id(202), message(2).id);
    await history.enqueueOutgoingWithMedia(message(1), first.metadata, first.bytes);
    await expect(history.enqueueOutgoingWithMedia(message(2), second.metadata, second.bytes)).rejects.toThrow(/space/);
    expect(await bytes.totalBytes(A)).toBe(64);
    expect(await bytes.keys(A)).toEqual([id(201)]);
    expect(await history.getMessage(message(2).id)).toBeNull();
    expect((await history.listMedia(CONVERSATION)).map((row) => row.id)).toEqual([id(201)]);
  });

  it("repairs actual byte accounting when metadata admission aborts", async () => {
    const history = await open();
    await history.enqueueOutgoing(message(1));
    const fixture = await mediaFixture(id(201), message(1).id);
    await expect(history.enqueueOutgoingWithMedia({ ...message(1), body: "conflicting caption" }, fixture.metadata, fixture.bytes))
      .rejects.toThrow(/identity conflict/i);
    expect(await bytes.totalBytes(A)).toBe(0);
    expect(await bytes.keys(A)).toEqual([]);
    expect(await history.listMedia(CONVERSATION)).toEqual([]);
    expect((await history.getMessage(message(1).id))?.body).toBe("caption");
  });

  it("drains failed admission cleanup before another handle commits the same bytes", async () => {
    const one = await open(), two = await open();
    await one.enqueueOutgoing(message(1));
    const fixture = await mediaFixture(id(201), message(1).id);
    const entered = deferred(), release = deferred();
    const remove = bytes.delete.bind(bytes);
    vi.spyOn(bytes, "delete").mockImplementationOnce(async (...args) => {
      entered.resolve(); await release.promise; await remove(...args);
    });
    const loser = Promise.allSettled([one.enqueueOutgoingWithMedia(
      { ...message(1), body: "conflicting caption" }, fixture.metadata, fixture.bytes)]);
    await entered.promise;
    const winner = two.enqueueOutgoingWithMedia(message(1), fixture.metadata, fixture.bytes);
    try {
      await Promise.resolve();
      expect((await navigator.locks.query()).pending?.some((lock) => lock.name === LOCK)).toBe(true);
    } finally { release.resolve(); await loser; await winner; }
    expect((await loser)[0]).toMatchObject({ status: "rejected" });
    expect(await two.readMedia(id(201))).toEqual(fixture.bytes);
    expect((await two.listMedia(CONVERSATION)).map((row) => row.state)).toEqual(["QUEUED"]);
    expect(await bytes.totalBytes(A)).toBe(64);
  });

  it("orders ACK entry under the lock but allows async completion to reenter and purge", async () => {
    const one = await open(), two = await open();
    await one.persistInbound({ ...scope, mailboxId: id(401), event: { kind: "TEXT", eventId: id(301),
      sequence: 1, message: { ...message(1), authorId: B, recipientId: A } } });
    const fixture = await mediaFixture(id(201), message(1).id, { direction: "IN", expiresAt: clock + 10_000 });
    const request = navigator.locks.request.bind(navigator.locks);
    let holding = false;
    vi.spyOn(navigator.locks, "request").mockImplementation(async (name, options, callback) => {
      return request(name, options, async (lock) => {
        holding = true;
        try { return await callback(lock); }
        finally { holding = false; }
      });
    });
    const ack = vi.fn(async () => {
      expect(holding).toBe(true); // synchronous entry, not an eventual snapshot
      expect(await one.readMedia(id(201))).toEqual(fixture.bytes);
      await two.clearMedia(); // completion cannot hold the lock or queue
    });
    await one.persistVerifiedMediaAndAck(fixture.metadata, fixture.bytes, ack);
    expect(ack).toHaveBeenCalledOnce();
    expect(await one.listMedia(CONVERSATION)).toEqual([]);
    expect(await bytes.totalBytes(A)).toBe(0); // no READY resurrection
  });

  it("retries failed purge cleanup after reopen without touching another account", async () => {
    const history = await open();
    const fixture = await receive(history, 1);
    await bytes.put(B, id(299), fixture.bytes);
    vi.spyOn(bytes, "clearAccount").mockRejectedValueOnce(new Error("byte cleanup failed"));
    await expect(history.clearMedia()).rejects.toThrow(/byte cleanup failed/);
    expect(await bytes.has(A, id(201))).toBe(true);
    await history.close();
    histories = [];
    const reopened = await open();
    const ack = vi.fn(async () => undefined);
    await expect(reopened.persistVerifiedMediaAndAck(fixture.metadata, fixture.bytes, ack)).rejects.toThrow(/purged/);
    expect(ack).not.toHaveBeenCalled();
    await reopened.clearMedia();
    expect(await bytes.totalBytes(A)).toBe(0);
    expect(await bytes.get(B, id(299))).toEqual(fixture.bytes);
    expect(await bytes.totalBytes(B)).toBe(64);
    expect(await reopened.listMedia(CONVERSATION)).toEqual([]);
  });

  it("promotes reads in LRU order instead of evicting the oldest insertion", async () => {
    const history = await open();
    const first = await receive(history, 1); clock += 10;
    await receive(history, 2); clock += 10;
    const third = await receive(history, 3); clock += 10;
    expect(await history.readMedia(id(201))).toEqual(first.bytes);
    expect(await history.evictMedia(1)).toBe(1);
    expect((await history.listMedia(CONVERSATION)).map((row) => [row.id, row.state])).toEqual([
      [id(201), "READY"], [id(202), "EVICTED"], [id(203), "READY"],
    ]);
    expect(await history.readMedia(id(202))).toBeNull();
    expect(await history.readMedia(id(203))).toEqual(third.bytes);
    expect(await bytes.totalBytes(A)).toBe(128);
  });

  it("finishes delayed eviction cleanup before a second handle re-admits bytes", async () => {
    const one = await open(), two = await open();
    const fixture = await receive(one, 1);
    const entered = deferred(), release = deferred();
    const remove = bytes.delete.bind(bytes);
    vi.spyOn(bytes, "delete").mockImplementationOnce(async (...args) => {
      entered.resolve(); await release.promise; await remove(...args);
    });
    const eviction = one.evictMedia(1);
    await entered.promise;
    const ack = vi.fn(async () => undefined);
    const admission = two.persistVerifiedMediaAndAck(fixture.metadata, fixture.bytes, ack);
    try {
      await Promise.resolve();
      const locks = await navigator.locks.query();
      expect(locks.pending?.some((lock) => lock.name === LOCK)).toBe(true);
      expect(ack).not.toHaveBeenCalled();
    } finally { release.resolve(); await eviction; await admission; }
    expect(await two.readMedia(id(201))).toEqual(fixture.bytes);
    expect((await two.listMedia(CONVERSATION))[0]?.state).toBe("READY");
    expect(await bytes.totalBytes(A)).toBe(64);
  });

  it.each(["UNSEND", "CLEAR_FOR_ME"] as const)("suppresses %s media despite failed byte cleanup and blocks replay", async (kind) => {
    const history = await open();
    const fixture = await receive(history, 1);
    await receive(history, 2);
    vi.spyOn(bytes, "delete").mockRejectedValueOnce(new Error("byte delete failed"));
    const common = { eventId: id(500), sequence: 1, conversationId: CONVERSATION, occurredAt: clock };
    await history.applyStateChange({ ...scope, change: kind === "UNSEND"
      ? { ...common, kind, messageId: message(1).id, authorId: B, recipientId: A, messageSequence: 1 }
      : { ...common, kind, peerId: B, throughSequence: 1 } });
    expect(await history.readMedia(id(201))).toBeNull();
    expect((await history.listMedia(CONVERSATION)).map((row) => row.id)).toEqual([id(202)]);
    expect(await bytes.has(A, id(201))).toBe(true); // unavailable garbage, not a live row
    const ack = vi.fn(async () => undefined);
    await expect(history.persistVerifiedMediaAndAck(fixture.metadata, fixture.bytes, ack)).rejects.toThrow(/parent/);
    expect(ack).not.toHaveBeenCalled();
    clock += MEDIA_SWEEP_GRACE_MS + 1;
    expect(await history.sweepOrphanMedia(10)).toBe(1);
    expect(await bytes.keys(A)).toEqual([id(202)]);
  });

  it.skipIf(backend === "web")("removes media when imported backup suppression wins", async () => {
    const history = await open();
    await receive(history, 1);
    const snapshot = await history.exportSnapshot();
    snapshot.deletedForMe.push({ messageId: message(1).id, conversationId: CONVERSATION, deletedAt: clock });
    await history.importSnapshot(snapshot);
    expect(await history.readMedia(id(201))).toBeNull();
    expect(await bytes.totalBytes(A)).toBe(0);
    expect(await history.listMedia(CONVERSATION)).toEqual([]);
  });

  it("claims once through two asynchronous history handles", async () => {
    const one = await open(), two = await open();
    const fixture = await mediaFixture(id(201), message(1).id);
    await one.enqueueOutgoingWithMedia(message(1), fixture.metadata, fixture.bytes);
    await one.persistInbound({ ...scope, mailboxId: id(401), event: { kind: "TEXT", eventId: id(301), sequence: 1, message: message(1) } });
    const claims = await Promise.all([one.claimNextMediaUpload(), two.claimNextMediaUpload()]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await bytes.get(A, id(201))).toEqual(fixture.bytes);
  });

  it("cancels a pending account lock on close with zero late byte admission", async () => {
    const history = await open();
    const entered = deferred(), release = deferred();
    const blocker = navigator.locks.request(LOCK, async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    const fixture = await mediaFixture(id(201), message(1).id);
    const pending = Promise.allSettled([history.enqueueOutgoingWithMedia(message(1), fixture.metadata, fixture.bytes)]);
    try {
      await Promise.resolve();
      expect((await navigator.locks.query()).pending?.some((lock) => lock.name === LOCK)).toBe(true);
      // Node 24's query snapshot can retain a cancelled waiter until release.
      // Prove the adapter actually rejects and closes WHILE the lock is held,
      // not that the runtime eagerly removes its diagnostic queue entry.
      await history.close();
      expect((await pending)[0]).toMatchObject({ status: "rejected" });
      expect(await bytes.keys(A)).toEqual([]);
    } finally { release.resolve(); await blocker; await pending; }
    expect((await pending)[0]).toMatchObject({ status: "rejected" });
    expect(await bytes.keys(A)).toEqual([]);
    const reopened = await open();
    expect(await reopened.getMessage(message(1).id)).toBeNull();
  });
});
