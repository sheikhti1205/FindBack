// @vitest-environment node
/** Real metadata engines and byte store. Synthetic identities/container bytes;
 * injected decoder is not browser/Android durability or forensic-erasure proof. */
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { IDBFactory, IDBObjectStore, IDBDatabase } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessagingHistory, HumanMessage, MailboxEnvelope } from "./history";
import { openWebMessagingHistory } from "./indexedDbHistory";
import { openSqliteMessagingHistory, type SqliteDriver } from "./sqliteHistory";
import { openMediaBytes, type MediaBytesStore } from "./mediaBytes";
import { afterNextHistoryOperation, deferred, mediaFixture } from "./mediaTestDoubles";

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const A = id(1), B = id(2), DEVICE = id(3), CONV = id(4);
const scope = { accountId: A, deviceId: DEVICE };
const message = (n: number): HumanMessage => ({ id: id(100 + n), conversationId: CONV,
  authorId: A, recipientId: B, body: `private caption ${n}` });
const envelope = (n: number): MailboxEnvelope => ({ ...scope, mailboxId: id(400 + n), event: {
  kind: "TEXT", eventId: id(300 + n), sequence: n, message: message(n) } });
const projection = { conversationId: CONV, peerId: B, mode: "CONNECTED" as const, request: "NONE" as const,
  requestEpoch: null, ownHidden: false, ownDeclined: false, ownBlocked: false, revision: 1 };

describe.each(["sqlite", "web"] as const)("%s complete history purge", (backend) => {
  let factory: IDBFactory, bytes: MediaBytesStore, directory: string;
  let histories: MessagingHistory[], drivers: SqliteDriver[];
  beforeEach(async () => {
    factory = new IDBFactory(); histories = []; drivers = [];
    directory = mkdtempSync("/tmp/opencode/purge-history-"); // single-command scratch DBs
    bytes = await openMediaBytes({ indexedDB: factory, databaseName: "purge-bytes" });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(histories.map((history) => history.close()));
    await bytes.close(); rmSync(directory, { recursive: true, force: true });
  });

  async function open(withBytes = true) {
    const options = { mediaBytes: withBytes ? bytes : undefined, decodeMedia: async () => undefined };
    let history: MessagingHistory;
    if (backend === "web") history = await openWebMessagingHistory(scope, { ...options, indexedDB: factory });
    else {
      const db = new DatabaseSync(join(directory, "history.db"));
      const driver: SqliteDriver = {
        exec: async (sql) => { await Promise.resolve(); db.exec(sql); },
        run: async (sql, params = []) => { await Promise.resolve(); return Number(db.prepare(sql).run(...params).changes); },
        all: async <T>(sql: string, params: readonly (string | number | null)[] = []) => {
          await Promise.resolve(); return db.prepare(sql).all(...params) as T[];
        },
        close: async () => { db.close(); },
      };
      drivers.push(driver); history = await openSqliteMessagingHistory(driver, scope, options);
    }
    histories.push(history); return history;
  }

  // Inspect every actual application store, independently of the purge's table
  // list: leaving an unlisted receipt/body behind fails this privacy assertion.
  async function storedRows(): Promise<Record<string, unknown[]>> {
    if (backend === "sqlite") {
      const db = new DatabaseSync(join(directory, "history.db"));
      try {
        const tables = db.prepare("select name from sqlite_master where type='table'").all() as { name: string }[];
        return Object.fromEntries(tables.map(({ name }) => [name, db.prepare(`select * from "${name}"`).all()]));
      } finally { db.close(); }
    }
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(`findback-human-history-v1:${A}:${DEVICE}`);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const names = Array.from(db.objectStoreNames), tx = db.transaction(names, "readonly");
        const rows: Record<string, unknown[]> = {};
        for (const name of names) {
          const request = tx.objectStore(name).getAll(); request.onsuccess = () => { rows[name] = request.result; };
        }
        tx.oncomplete = () => resolve(rows); tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  }
  async function expectEmpty() {
    const rows = await storedRows();
    const metadata = backend === "sqlite" ? "messaging_meta" : "mediaLifecycle";
    for (const [name, values] of Object.entries(rows)) if (name !== metadata) expect(values, name).toEqual([]);
    if (backend === "sqlite") expect(rows[metadata]).toEqual(expect.arrayContaining([
      { key: "account_id", value: A }, { key: "device_id", value: DEVICE }, { key: "history_purged", value: "1" },
    ]));
    expect(JSON.stringify(rows)).not.toContain("private caption");
  }
  async function seed(history: MessagingHistory) {
    await history.cacheConversation(projection);
    for (const n of [1, 2, 3]) await history.persistInbound(envelope(n));
    await history.markConversationRead(CONV, 3);
    for (const [sequence, kind] of [[1, "UNSEND"], [2, "DELETE_FOR_ME"]] as const) {
      await history.applyStateChange({ ...scope, change: { kind, sequence, eventId: id(500 + sequence),
        conversationId: CONV, messageId: message(sequence).id, authorId: A, recipientId: B,
        messageSequence: sequence, occurredAt: Date.now() } });
    }
    await history.applyStateChange({ ...scope, change: { kind: "CLEAR_FOR_ME", sequence: 3,
      eventId: id(503), conversationId: CONV, peerId: B, throughSequence: 2, occurredAt: Date.now() } });
    const fixture = await mediaFixture(id(210), message(10).id);
    await history.enqueueOutgoingWithMedia(message(10), fixture.metadata, fixture.bytes);
    await bytes.put(A, id(299), fixture.bytes); // unreferenced, too young for sweep
    await bytes.put(B, id(298), fixture.bytes);
    return fixture;
  }

  it("removes all sensitive rows and every captured-account byte, not another account", async () => {
    const history = await open(), fixture = await seed(history);
    const before = await storedRows();
    for (const [name, rows] of Object.entries(before)) if (name !== "mediaLifecycle") expect(rows.length, name).toBeGreaterThan(0);
    await history.purgeHistory();
    await expectEmpty(); expect(await bytes.keys(A)).toEqual([]); expect(await bytes.totalBytes(A)).toBe(0);
    expect(await bytes.get(B, id(298))).toEqual(fixture.bytes);
  });

  it("fences stale and reopened text/media/backup handles, but permits purge retry", async () => {
    const one = await open(), two = await open(); const fixture = await seed(one);
    const snapshot = backend === "sqlite" ? await one.exportSnapshot() : null;
    await one.purgeHistory();
    for (const history of [one, two, await open(), await open(false)]) {
      for (const operation of [() => history.enqueueOutgoing(message(20)), () => history.getMessage(message(3).id),
        () => history.listMessages(CONV), () => history.listOutbox(), () => history.claimNextOutgoing(),
        () => history.listConversations(), () => history.cacheConversation(projection), () => history.getStateCursor(),
        () => history.markConversationRead(CONV, 3), () => history.persistInbound(envelope(20)),
        () => history.listMedia(CONV), () => history.readMedia(fixture.metadata.id),
        () => history.enqueueOutgoingWithMedia(message(10), fixture.metadata, fixture.bytes),
        () => history.claimNextMediaUpload(), () => history.markMediaReady(fixture.metadata.id),
        () => history.evictMedia(1), () => history.sweepOrphanMedia(1), () => history.clearMedia(),
      ]) await expect(operation()).rejects.toThrow(/purged/);
      if (snapshot) {
        await expect(history.exportSnapshot()).rejects.toThrow(/purged/);
        await expect(history.importSnapshot(snapshot)).rejects.toThrow(/purged/);
      }
    }
    await two.purgeHistory(); await expectEmpty(); expect(await bytes.keys(A)).toEqual([]);
  });

  it("retains the fence on byte failure and retries after close/reopen", async () => {
    const history = await open(), fixture = await seed(history);
    vi.spyOn(bytes, "clearAccount").mockRejectedValueOnce(new Error("cleanup failed"));
    await expect(history.purgeHistory()).rejects.toThrow("cleanup failed"); await expectEmpty();
    await history.close(); const reopened = await open();
    expect(await bytes.keys(A)).toHaveLength(2); // reopen isn't a completed purge
    await expect(reopened.enqueueOutgoing(message(20))).rejects.toThrow(/purged/);
    await reopened.purgeHistory(); expect(await bytes.keys(A)).toEqual([]);
    expect(await bytes.get(B, id(298))).toEqual(fixture.bytes);
  });

  it("rolls back failed metadata deletion without touching durable bytes", async () => {
    const history = await open(); await seed(history); const before = await storedRows();
    if (backend === "sqlite") {
      const driver = drivers[0]!, run = driver.run.bind(driver);
      vi.spyOn(driver, "run").mockImplementation(async (sql, params) => {
        if (sql === "delete from messages") throw new Error("delete failed");
        return run(sql, params);
      });
    } else {
      const clear = IDBObjectStore.prototype.clear;
      vi.spyOn(IDBObjectStore.prototype, "clear").mockImplementation(function (this: IDBObjectStore) {
        if (this.name === "messages") throw new Error("delete failed");
        return clear.call(this);
      });
    }
    await expect(history.purgeHistory()).rejects.toThrow("delete failed");
    expect(await storedRows()).toEqual(before); expect(await bytes.keys(A)).toHaveLength(2);
    vi.restoreAllMocks(); await history.purgeHistory(); await expectEmpty();
  });

  if (backend === "sqlite") it("retains bytes and invalidates on lost purge COMMIT reply, then retries", async () => {
    const history = await open(); await seed(history);
    const driver = drivers[0]!, exec = driver.exec.bind(driver);
    vi.spyOn(driver, "exec").mockImplementation(async (sql) => {
      await exec(sql); if (sql === "commit") throw new Error("lost purge commit reply");
    });
    await expect(history.purgeHistory()).rejects.toThrow("lost purge commit reply");
    await expectEmpty(); expect(await bytes.keys(A)).toHaveLength(2);
    await expect(history.enqueueOutgoing(message(20))).rejects.toThrow(/closed/);
    const reopened = await open(); await reopened.purgeHistory(); expect(await bytes.keys(A)).toEqual([]);
  });

  if (backend === "web") it("refuses weakened purge durability without deleting rows or bytes", async () => {
    const history = await open(); await seed(history); const before = await storedRows();
    const transaction = IDBDatabase.prototype.transaction;
    vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, stores, mode, options) {
      return transaction.call(this, stores, mode, mode === "readwrite" ? { durability: "relaxed" } : options);
    });
    await expect(history.purgeHistory()).rejects.toThrow(/strict/);
    expect(await storedRows()).toEqual(before); expect(await bytes.keys(A)).toHaveLength(2);
  });

  it.each(["text", "media"] as const)("releases the lock during entered %s ACK completion so purge can finish", async (kind) => {
    const one = await open(), two = await open();
    await one.cacheConversation(projection); await one.persistInbound(envelope(1));
    const fixture = await mediaFixture(id(201), message(1).id, { expiresAt: Date.now() + 60_000 });
    const entered = deferred(), release = deferred();
    const ack = async () => { entered.resolve(); await release.promise; };
    const pending = Promise.allSettled([kind === "text" ? one.persistInboundAndAck(envelope(1), ack)
      : one.persistVerifiedMediaAndAck(fixture.metadata, fixture.bytes, ack)]);
    await entered.promise;
    try { await two.purgeHistory(); } finally { release.resolve(); await pending; }
    await expectEmpty(); expect(await bytes.keys(A)).toEqual([]);
    await expect(one.enqueueOutgoing(message(20))).rejects.toThrow(/purged/);
  });

  it("refuses incomplete byte cleanup even when clear reports success", async () => {
    const history = await open(); await seed(history);
    vi.spyOn(bytes, "clearAccount").mockResolvedValueOnce(undefined);
    await expect(history.purgeHistory()).rejects.toThrow(/bytes/i);
    await expectEmpty(); expect(await bytes.keys(A)).toHaveLength(2);
    await history.purgeHistory(); expect(await bytes.keys(A)).toEqual([]);
  });

  it("refuses purge without its byte port instead of claiming orphan bytes removed", async () => {
    const history = await open(false); await history.enqueueOutgoing(message(1));
    await expect(history.purgeHistory()).rejects.toThrow(/byte storage/);
    expect((await history.getMessage(message(1).id))?.body).toBe("private caption 1");
  });

  it.each(["text", "media"] as const)("refuses %s ACK entry if another handle purges after persistence", async (kind) => {
    const one = await open(), two = await open();
    await one.cacheConversation(projection); await one.persistInbound(envelope(1));
    const fixture = await mediaFixture(id(201), message(1).id, { expiresAt: Date.now() + 60_000 });
    const ack = vi.fn(async () => undefined);
    afterNextHistoryOperation(() => two.purgeHistory());
    const pending = kind === "text" ? one.persistInboundAndAck(envelope(1), ack)
      : one.persistVerifiedMediaAndAck(fixture.metadata, fixture.bytes, ack);
    await expect(pending).rejects.toThrow(/purged/); expect(ack).not.toHaveBeenCalled();
    await expectEmpty(); expect(await bytes.keys(A)).toEqual([]);
  });

  it("waits for admitted byte writes then removes them before refusing queued admission", async () => {
    const one = await open(), two = await open(); await one.cacheConversation(projection);
    const fixture = await mediaFixture(id(210), message(10).id), entered = deferred(), release = deferred();
    const put = bytes.put.bind(bytes);
    vi.spyOn(bytes, "put").mockImplementationOnce(async (...args) => { entered.resolve(); await release.promise; await put(...args); });
    const writing = one.enqueueOutgoingWithMedia(message(10), fixture.metadata, fixture.bytes);
    await entered.promise;
    try {
      const purging = two.purgeHistory(); const queued = Promise.allSettled([two.enqueueOutgoing(message(20))]);
      release.resolve(); await writing; await purging;
      expect((await queued)[0]?.status).toBe("rejected");
    } finally { release.resolve(); await writing; }
    await expectEmpty(); expect(await bytes.keys(A)).toEqual([]);
  });

  it("keeps ordinary logout non-destructive", async () => {
    const history = await open(), fixture = await seed(history); await history.close();
    const reopened = await open();
    expect((await reopened.getMessage(message(10).id))?.body).toBe("private caption 10");
    expect(await reopened.readMedia(fixture.metadata.id)).toEqual(fixture.bytes);
  });
});
