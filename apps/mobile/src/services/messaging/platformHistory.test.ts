// @vitest-environment node
/**
 * Platform storage selection for human messaging (`platformHistory.ts`).
 *
 * The native plugin is a seam fake here, but it is backed by a REAL SQLite file
 * through `node:sqlite` so the whole JS path (driver → adapter → SQL) executes
 * end to end. This proves platform selection, scope/installation identity and
 * close ordering; it does NOT prove the Android plugin, a device build, or
 * power-loss durability.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBDatabase, IDBFactory } from "fake-indexeddb";
import type { HumanMessage } from "./history";
import { mediaFixture, deferred } from "./mediaTestDoubles";
import { MEDIA_SWEEP_GRACE_MS } from "./media";

const { fakePlugin, registerPluginMock, platform } = vi.hoisted(() => ({
  fakePlugin: {
    open: vi.fn<(options: { accountId: string }) => Promise<unknown>>(),
    exec: vi.fn<(options: { handle: string; sql: string }) => Promise<unknown>>(),
    all: vi.fn<(options: { handle: string; sql: string; params: unknown[] }) => Promise<unknown>>(),
    run: vi.fn<(options: { handle: string; sql: string; params: unknown[] }) => Promise<unknown>>(),
    close: vi.fn<(options: { handle: string }) => Promise<unknown>>(),
    installationId: vi.fn<() => Promise<unknown>>(),
  },
  registerPluginMock: vi.fn(),
  platform: { native: true, name: "android" },
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => platform.native,
    getPlatform: () => platform.name,
  },
  registerPlugin: (name: string) => registerPluginMock(name),
}));

// The platform decoder is unavailable on Node; leave hash/container/dimension
// verification, both real metadata adapters and actual IDB bytes in the path.
vi.mock("../media/webTranscode", () => ({ transcodeImageForWeb: async () => undefined }));

import { MessagingSqliteError, openAndroidMessagingSqliteDriver } from "./androidSqliteDriver";
import { openPlatformMessagingHistory, purgePlatformMessagingAccount } from "./platformHistory";
import { beginMessagingAccountDeletion, listPendingMessagingDeletions, listMessagingStorageScopes } from "./scopedMediaBytes";
import { openMediaBytes } from "./mediaBytes";
import { openSqliteMessagingHistory } from "./sqliteHistory";
import { openWebMessagingHistory } from "./indexedDbHistory";
import * as webTranscode from "../media/webTranscode";

const A = "00000000-0000-4000-8000-000000000001";
const B = "00000000-0000-4000-8000-000000000002";
const INSTALLATION = "00000000-0000-4000-8000-0000000000aa";
const OTHER_INSTALLATION = "00000000-0000-4000-8000-0000000000bb";
const CONVERSATION = "00000000-0000-4000-8000-000000000003";
const MESSAGE = "00000000-0000-4000-8000-000000000004";

const outgoing: HumanMessage = {
  id: MESSAGE, conversationId: CONVERSATION, authorId: A, recipientId: B, body: "Is the blue bag yours?",
};

let dir: string;
let callLog: string[];
let openDatabases: DatabaseSync[];
let mediaHandles: Awaited<ReturnType<typeof openPlatformMessagingHistory>>[];

/**
 * Seam fake for the native plugin: real SQLite, real pragmas, opaque handles,
 * and a single serialized command lane — the same contract the Java plugin
 * must satisfy. Not a device proof.
 */
function installFakeNativePlugin(): void {
  const handles = new Map<string, DatabaseSync>();
  let next = 0;
  const lane: Promise<unknown>[] = [];

  function enqueue<T>(work: () => T): Promise<T> {
    const run = Promise.all(lane).then(work);
    lane.push(run.catch(() => undefined));
    return run;
  }

  fakePlugin.open.mockImplementation(({ accountId }) =>
    enqueue(() => {
      callLog.push(`open:${accountId}`);
      // Opaque 32-byte Base64URL handle shape returned by the native plugin.
      const handle = (++next).toString(16).padStart(43, "0");
      const db = new DatabaseSync(join(dir, `${accountId}.sqlite3`));
      db.exec("pragma journal_mode = wal");
      db.exec("pragma synchronous = full");
      db.exec("pragma foreign_keys = on");
      openDatabases.push(db);
      handles.set(handle, db);
      return { handle };
    }),
  );
  fakePlugin.installationId.mockImplementation(() =>
    enqueue(() => {
      callLog.push("installationId");
      return { id: INSTALLATION };
    }),
  );
  fakePlugin.exec.mockImplementation(({ handle, sql }) =>
    enqueue(() => {
      callLog.push(`exec:${sql.split(" ")[0]}`);
      const db = handles.get(handle);
      if (!db) throw new Error("unknown handle");
      db.exec(sql);
    }),
  );
  fakePlugin.all.mockImplementation(({ handle, sql, params }) =>
    enqueue(() => {
      callLog.push(`all:${sql.split(" ")[0]}`);
      const db = handles.get(handle);
      if (!db) throw new Error("unknown handle");
      return { rows: db.prepare(sql).all(...(params as (string | number | null)[])) };
    }),
  );
  fakePlugin.run.mockImplementation(({ handle, sql, params }) =>
    enqueue(() => {
      callLog.push(`run:${sql.split(" ")[0]}`);
      const db = handles.get(handle);
      if (!db) throw new Error("unknown handle");
      return { changes: Number(db.prepare(sql).run(...(params as (string | number | null)[])).changes) };
    }),
  );
  fakePlugin.close.mockImplementation(({ handle }) =>
    enqueue(() => {
      callLog.push("close");
      const db = handles.get(handle);
      if (!db) throw new Error("unknown handle");
      handles.delete(handle);
      db.close();
    }),
  );
}

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  dir = mkdtempSync(join(tmpdir(), "chat033-native-"));
  callLog = [];
  openDatabases = [];
  mediaHandles = [];
  for (const fn of Object.values(fakePlugin)) fn.mockReset();
  registerPluginMock.mockReset().mockImplementation(() => fakePlugin);
  platform.native = true;
  platform.name = "android";
  installFakeNativePlugin();
});

afterEach(async () => {
  await Promise.all(mediaHandles.map((handle) => handle.close().catch(() => undefined)));
  for (const db of openDatabases) {
    try { db.close(); } catch { /* the adapter may have closed it first */ }
  }
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Android selection", () => {
  it("rejects a concurrent same-account opener before another bridge open and allows reopen after close", async () => {
    const results = await Promise.allSettled([
      openPlatformMessagingHistory({ accountId: A }),
      openPlatformMessagingHistory({ accountId: A }),
    ]);
    try {
      expect(results[0].status).toBe("fulfilled");
      expect(results[1]).toMatchObject({ status: "rejected", reason: { kind: "already-open" } });
      expect(fakePlugin.open).toHaveBeenCalledTimes(1);
      if (results[0].status !== "fulfilled") throw new Error("First opener failed");
      const first = results[0].value;
      await first.history.enqueueOutgoing(outgoing);
      expect(await first.history.listMessages(CONVERSATION)).toEqual([outgoing]);
    } finally {
      await Promise.all(results.map((result) => result.status === "fulfilled" ? result.value.close() : undefined));
    }
    const reopened = await openPlatformMessagingHistory({ accountId: A });
    expect(await reopened.history.listMessages(CONVERSATION)).toEqual([outgoing]);
    await reopened.close();
  });

  it("opens durable SQLite, reports the persisted installation scope and stores a queued send", async () => {
    const handle = await openPlatformMessagingHistory({ accountId: A });
    expect(handle.platform).toBe("android");
    expect(handle.scope).toEqual({ accountId: A, deviceId: INSTALLATION });
    await handle.history.enqueueOutgoing(outgoing);
    expect(await handle.history.listOutbox()).toEqual([
      { messageId: MESSAGE, status: "QUEUED", attempts: 0 },
    ]);
    await handle.close();
  });

  it("holds ownership until native close settles", async () => {
    const handle = await openPlatformMessagingHistory({ accountId: A });
    const closeNative = fakePlugin.close.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    fakePlugin.close.mockImplementation(async (options) => { await gate; return closeNative(options); });
    const closing = handle.close();
    try {
      await expect(openPlatformMessagingHistory({ accountId: A })).rejects.toMatchObject({ kind: "already-open" });
    } finally {
      release();
      await closing;
    }
    const next = await openPlatformMessagingHistory({ accountId: A });
    await next.close();
  });

  it("retains ownership on failed teardown rather than opening another writer", async () => {
    const accountId = "00000000-0000-4000-8000-0000000000f1";
    const handle = await openPlatformMessagingHistory({ accountId });
    fakePlugin.close.mockRejectedValue(new Error("close failed"));
    await expect(handle.close()).rejects.toMatchObject({ kind: "command-failed" });
    await expect(openPlatformMessagingHistory({ accountId })).rejects.toMatchObject({ kind: "already-open" });
    expect(fakePlugin.open).toHaveBeenCalledTimes(1);
  });

  it("releases ownership after a failed open or a failed initialization with successful cleanup", async () => {
    fakePlugin.open.mockRejectedValueOnce(new Error("open failed"));
    await expect(openPlatformMessagingHistory({ accountId: A })).rejects.toBeInstanceOf(MessagingSqliteError);
    fakePlugin.all.mockRejectedValueOnce(new Error("initialization failed"));
    await expect(openPlatformMessagingHistory({ accountId: A })).rejects.toBeInstanceOf(MessagingSqliteError);
    const handle = await openPlatformMessagingHistory({ accountId: A });
    await handle.close();
  });

  it("retains ownership when failed initialization also fails native cleanup", async () => {
    const accountId = "00000000-0000-4000-8000-0000000000f2";
    fakePlugin.all.mockRejectedValueOnce(new Error("initialization failed"));
    fakePlugin.close.mockRejectedValue(new Error("cleanup failed"));
    await expect(openPlatformMessagingHistory({ accountId })).rejects.toMatchObject({ kind: "command-failed" });
    await expect(openPlatformMessagingHistory({ accountId })).rejects.toMatchObject({ kind: "already-open" });
    expect(fakePlugin.open).toHaveBeenCalledTimes(1);
  });

  it("really opened a WAL file on disk, not an in-memory database", async () => {
    const handle = await openPlatformMessagingHistory({ accountId: A });
    await handle.history.enqueueOutgoing(outgoing);
    const reader = new DatabaseSync(join(dir, `${A}.sqlite3`));
    try {
      expect(reader.prepare("pragma journal_mode").get()).toEqual({ journal_mode: "wal" });
      expect(reader.prepare("pragma synchronous").get()).toEqual({ synchronous: 2 });
      expect(reader.prepare("pragma foreign_keys").get()).toEqual({ foreign_keys: 1 });
    } finally {
      reader.close();
    }
    await handle.close();
  });

  it("reuses the persisted installation id and the same history after restart", async () => {
    const first = await openPlatformMessagingHistory({ accountId: A });
    await first.history.enqueueOutgoing(outgoing);
    await first.close();

    const second = await openPlatformMessagingHistory({ accountId: A });
    expect(second.scope.deviceId).toBe(first.scope.deviceId);
    expect(await second.history.listMessages(CONVERSATION)).toEqual([outgoing]);
    await second.close();
  });

  it("keeps account handles and files isolated", async () => {
    const first = await openPlatformMessagingHistory({ accountId: A });
    const otherAccount = "00000000-0000-4000-8000-000000000009";
    const second = await openPlatformMessagingHistory({ accountId: otherAccount });
    await first.history.enqueueOutgoing(outgoing);

    expect(await first.history.listMessages(CONVERSATION)).toEqual([outgoing]);
    expect(await second.history.listMessages(CONVERSATION)).toEqual([]);
    expect(fakePlugin.open).toHaveBeenNthCalledWith(1, { accountId: A });
    expect(fakePlugin.open).toHaveBeenNthCalledWith(2, { accountId: otherAccount });
    await first.close();
    await second.close();
  });

  it("rejects a caller installation id that disagrees with the persisted one", async () => {
    await expect(
      openPlatformMessagingHistory({ accountId: A, deviceId: OTHER_INSTALLATION }),
    ).rejects.toMatchObject({ kind: "invalid-scope" });
    expect(fakePlugin.open).not.toHaveBeenCalled();
  });

  it("accepts a caller installation id that matches the persisted one", async () => {
    const handle = await openPlatformMessagingHistory({ accountId: A, deviceId: INSTALLATION });
    expect(handle.scope.deviceId).toBe(INSTALLATION);
    await handle.close();
  });

  it("fails closed when native open fails and never falls back to IndexedDB history", async () => {
    fakePlugin.open.mockRejectedValue(new Error("native open exploded"));
    const factory = new IDBFactory();
    const opening = vi.spyOn(factory, "open");
    await expect(
      openPlatformMessagingHistory({ accountId: A, indexedDB: factory }),
    ).rejects.toBeInstanceOf(MessagingSqliteError);
    // Both platforms now require the durable ownership/deletion registry;
    // touching it is not a fallback to web message storage.
    expect(opening.mock.calls.map(([name]) => name)).toEqual(["findback-chat-media-owners-v1"]);
  });

  it("fails closed when the installation id is unavailable", async () => {
    fakePlugin.installationId.mockResolvedValue({ id: "not-a-uuid" });
    await expect(openPlatformMessagingHistory({ accountId: A })).rejects.toMatchObject({
      kind: "invalid-result",
    });
    expect(fakePlugin.open).not.toHaveBeenCalled();
  });

  it("invalidates immediately, rejects a write still in flight, and closes natively after it", async () => {
    const handle = await openPlatformMessagingHistory({ accountId: A });
    // Hold the first message insert open so close() lands mid-transaction.
    let releaseRun!: () => void;
    let enteredRun!: () => void;
    const entered = new Promise<void>((resolve) => { enteredRun = resolve; });
    const gate = new Promise<void>((resolve) => { releaseRun = resolve; });
    const passthrough = fakePlugin.run.getMockImplementation();
    if (!passthrough) throw new Error("fake plugin run is not installed");
    fakePlugin.run.mockImplementation(async (options) => {
      if (options.sql.startsWith("insert into messages")) {
        enteredRun();
        await gate;
      }
      return passthrough(options);
    });

    const queued = handle.history.enqueueOutgoing(outgoing);
    await entered;
    // Invalidate while the write is dispatched but not committed.
    const closing = handle.close();
    const rejected = expect(queued).rejects.toThrow(/closed/i);
    releaseRun();
    await rejected;
    await closing;

    expect(callLog[callLog.length - 1]).toBe("close");
    expect(callLog.filter((entry) => entry === "close")).toHaveLength(1);
    expect(callLog.indexOf("close")).toBeGreaterThan(callLog.lastIndexOf("run:insert"));
    // A write interrupted by close rolls back: no half-applied history survives.
    await expect(handle.history.listOutbox()).rejects.toThrow(/closed/i);
    const reader = new DatabaseSync(join(dir, `${A}.sqlite3`));
    try {
      expect(reader.prepare("select count(*) as n from messages").get()).toEqual({ n: 0 });
    } finally {
      reader.close();
    }
  });

  it("does not ACK an inbound envelope that was queued before close", async () => {
    const handle = await openPlatformMessagingHistory({ accountId: A });
    let acked = false;
    const pending = handle.history.persistInboundAndAck(
      {
        accountId: A,
        deviceId: INSTALLATION,
        mailboxId: "00000000-0000-4000-8000-000000000005",
        event: {
          kind: "TEXT",
          eventId: "00000000-0000-4000-8000-000000000005",
          sequence: 1,
          message: { ...outgoing, id: "00000000-0000-4000-8000-000000000006", authorId: B, recipientId: A },
        },
      },
      async () => { acked = true; },
    );
    const rejected = expect(pending).rejects.toThrow(/closed/i);
    await handle.close();
    await rejected;
    expect(acked).toBe(false);
  });
});

describe("unsupported and web platforms", () => {
  it("reports iOS as explicitly unsupported and never registers the bridge", async () => {
    platform.name = "ios";
    await expect(openPlatformMessagingHistory({ accountId: A })).rejects.toMatchObject({
      kind: "unsupported",
    });
    expect(registerPluginMock).not.toHaveBeenCalled();
  });

  it("opens the web IndexedDB adapter with the caller's installation id", async () => {
    platform.native = false;
    platform.name = "web";
    const factory = new IDBFactory();
    const handle = await openPlatformMessagingHistory({
      accountId: A,
      deviceId: INSTALLATION,
      indexedDB: factory,
    });
    expect(handle.platform).toBe("web");
    expect(handle.scope).toEqual({ accountId: A, deviceId: INSTALLATION });
    await handle.history.enqueueOutgoing(outgoing);
    expect(await handle.history.listOutbox()).toHaveLength(1);
    expect(fakePlugin.open).not.toHaveBeenCalled();
    handle.close();
  });

  it("refuses to invent a web installation id", async () => {
    platform.native = false;
    platform.name = "web";
    await expect(
      openPlatformMessagingHistory({ accountId: A, indexedDB: new IDBFactory() }),
    ).rejects.toMatchObject({ kind: "invalid-scope" });
  });
});

describe.each(["android", "web"] as const)("%s production media ownership", (target) => {
  const ATTACHMENT = "00000000-0000-4000-8000-000000000005";
  const BACKEND = "https://backend-a.example.test";
  let factory: IDBFactory;
  let clock: number;
  beforeEach(() => {
    platform.name = target; platform.native = target === "android";
    factory = new IDBFactory(); clock = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
  });

  async function open(overrides: { accountId?: string; deviceId?: string; backendUrl?: string } = {}) {
    const options = { accountId: overrides.accountId ?? A, deviceId: overrides.deviceId ?? INSTALLATION,
      indexedDB: factory, media: { backendUrl: overrides.backendUrl ?? BACKEND } };
    const handle = await openPlatformMessagingHistory(options);
    mediaHandles.push(handle);
    return handle;
  }
  async function enqueue(handle: Awaited<ReturnType<typeof open>>, body = "") {
    await handle.history.cacheConversation({ conversationId: CONVERSATION, peerId: B, mode: "CONNECTED",
      request: "NONE", requestEpoch: null, ownBlocked: false, ownDeclined: false, ownHidden: false, revision: 1 });
    const fixture = await mediaFixture(ATTACHMENT, MESSAGE);
    await handle.history.enqueueOutgoingWithMedia({ ...outgoing, body }, fixture.metadata, fixture.bytes);
    return fixture;
  }

  async function expectKnownAStoresEmpty() {
    // Bypass production fencing to inspect actual logical content, not just the
    // inability of a deleted-account reader to observe remaining sensitive data.
    if (target === "android") {
      const db = new DatabaseSync(join(dir, `${A}.sqlite3`));
      try { expect(db.prepare("select count(*) n from messages").get()).toMatchObject({ n: 0 }); }
      finally { db.close(); }
    } else {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = factory.open(`findback-human-history-v1:${A}:${INSTALLATION}`);
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      try {
        expect(await new Promise<number>((resolve, reject) => {
          const request = db.transaction("messages").objectStore("messages").count();
          request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
        })).toBe(0);
      } finally { db.close(); }
    }
    const bytes = await openMediaBytes({ indexedDB: factory,
      databaseName: `findback-chat-media-bytes-v1:${JSON.stringify([target, A, INSTALLATION, BACKEND])}` });
    try { expect(await bytes.keys(A)).toEqual([]); } finally { await bytes.close(); }
  }

  it.each([A, B])("purges valid known scopes despite corrupt inventory for %s", async (corruptAccount) => {
    const a = await open(); await enqueue(a); await a.close();
    const b = await open({ accountId: B });
    await b.history.enqueueOutgoing({ ...outgoing, authorId: B, recipientId: A });
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open("findback-chat-media-owners-v1");
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("owners", "readwrite");
        tx.objectStore("owners").put({ metadataKey: JSON.stringify(["web", corruptAccount, OTHER_INSTALLATION]),
          identity: "synthetic corrupt provenance", owner: { platform: "web", accountId: corruptAccount, deviceId: OTHER_INSTALLATION } });
        tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
    await expect(purgePlatformMessagingAccount(A, { indexedDB: factory })).rejects.toThrow();
    expect(await listPendingMessagingDeletions(factory)).toEqual([A]);
    await expectKnownAStoresEmpty();
    expect(await b.history.listMessages(CONVERSATION)).toEqual([{ ...outgoing, authorId: B, recipientId: A }]);
    // Corruption stays unresolved: no guessed backend and no false completion.
    await expect(listMessagingStorageScopes(A, factory)).rejects.toThrow(/corrupt/i);
  });

  it("purges known scopes but retains retry when the legacy inventory API is absent", async () => {
    const a = await open(); await enqueue(a); await a.close();
    const databases = factory.databases;
    Object.defineProperty(factory, "databases", { configurable: true, value: undefined });
    try {
      await expect(purgePlatformMessagingAccount(A, { indexedDB: factory })).rejects.toThrow(/incomplete/i);
      expect(await listPendingMessagingDeletions(factory)).toEqual([A]);
      await expectKnownAStoresEmpty();
      await expect(open()).rejects.toThrow(/delet/i);
    } finally { Object.defineProperty(factory, "databases", { configurable: true, value: databases }); }
    // A capable browser/WebView can verify legacy scope inventory and finish;
    // missing capability itself is never bypassed as an empty inventory.
    await purgePlatformMessagingAccount(A, { indexedDB: factory });
    expect(await listPendingMessagingDeletions(factory)).toEqual([]);
  });

  it("an older cleanup cannot erase a newer failed cleanup's pending admission", async () => {
    const a = await open(); await enqueue(a); await a.close();
    const entered = deferred(), release = deferred(), databases = factory.databases.bind(factory);
    vi.spyOn(factory, "databases")
      .mockImplementationOnce(async () => { entered.resolve(); await release.promise; return databases(); })
      .mockRejectedValueOnce(new Error("synthetic newer inventory failure"));
    const older = purgePlatformMessagingAccount(A, { indexedDB: factory });
    // Attach immediately: rejection must never become an unhandled promise.
    const olderResult = older.then(() => "completed", () => "incomplete");
    try {
      await entered.promise;
      await expect(purgePlatformMessagingAccount(A, { indexedDB: factory })).rejects.toThrow(/incomplete/i);
      expect(await listPendingMessagingDeletions(factory)).toEqual([A]);
    } finally { release.resolve(); }
    expect(await olderResult).toBe("incomplete");
    expect(await listPendingMessagingDeletions(factory)).toEqual([A]);
    await expectKnownAStoresEmpty();
    await purgePlatformMessagingAccount(A, { indexedDB: factory });
    expect(await listPendingMessagingDeletions(factory)).toEqual([]);
  });

  it("deletion waits for a history operation already admitted before fencing", async () => {
    const a = await open();
    const entered = deferred(), release = deferred(), decode = webTranscode.transcodeImageForWeb;
    vi.spyOn(webTranscode, "transcodeImageForWeb").mockImplementationOnce(async (...args) => {
      entered.resolve(); await release.promise; return decode(...args);
    });
    const writing = enqueue(a);
    let deleting: Promise<unknown> | undefined;
    try {
      await entered.promise;
      deleting = beginMessagingAccountDeletion(A, factory);
      // An independent account's committed fence is an event-driven checkpoint;
      // A's admitted history operation remains paused inside its account lock.
      await beginMessagingAccountDeletion(B, factory);
      expect(await listPendingMessagingDeletions(factory)).toEqual([B]);
    } finally { release.resolve(); }
    await writing; await deleting;
    expect(await listPendingMessagingDeletions(factory)).toEqual([A, B]);
    await expect(a.history.enqueueOutgoing(outgoing)).rejects.toThrow(/delet/i);
    await a.close();
    await purgePlatformMessagingAccount(A, { indexedDB: factory });
    await expectKnownAStoresEmpty();
  });

  it("fences live history and purges known scopes without altering account B", async () => {
    const first = await open();
    await enqueue(first);
    const other = await open({ accountId: B });
    await other.history.enqueueOutgoing({ ...outgoing, authorId: B, recipientId: A });
    let second: Awaited<ReturnType<typeof open>> | undefined;
    if (target === "web") {
      second = await open({ deviceId: OTHER_INSTALLATION, backendUrl: "https://backend-b.example.test" });
      await enqueue(second);
    }
    await beginMessagingAccountDeletion(A, factory);
    await expect(first.history.getMessage(MESSAGE)).rejects.toThrow(/delet/i);
    await expect(first.history.enqueueOutgoing(outgoing)).rejects.toThrow(/delet/i);
    await first.close(); await second?.close();
    await purgePlatformMessagingAccount(A, { indexedDB: factory });
    expect(await listPendingMessagingDeletions(factory)).toEqual([]);
    await expect(open()).rejects.toThrow(/delet/i);
    if (target === "android") fakePlugin.installationId.mockResolvedValueOnce({ id: OTHER_INSTALLATION });
    await expect(open({ deviceId: OTHER_INSTALLATION })).rejects.toThrow(/delet/i);
    expect(await other.history.listMessages(CONVERSATION)).toEqual([{ ...outgoing, authorId: B, recipientId: A }]);
    // Inspect actual physical logical stores, not a mocked cleanup call or a
    // fenced reader that cannot reveal whether sensitive content was deleted.
    if (target === "android") {
      const db = new DatabaseSync(join(dir, `${A}.sqlite3`));
      try { expect(db.prepare("select count(*) n from messages").get()).toMatchObject({ n: 0 }); }
      finally { db.close(); }
    } else {
      for (const device of [INSTALLATION, OTHER_INSTALLATION]) {
        const db = await new Promise<IDBDatabase>((resolve) => {
          const request = factory.open(`findback-human-history-v1:${A}:${device}`);
          request.onsuccess = () => resolve(request.result);
        });
        try {
          const rows = await new Promise<unknown[]>((resolve) => {
            const request = db.transaction("messages").objectStore("messages").getAll();
            request.onsuccess = () => resolve(request.result);
          });
          expect(rows).toEqual([]);
        } finally { db.close(); }
      }
    }
    for (const [deviceId, backend] of target === "web"
      ? [[INSTALLATION, BACKEND], [OTHER_INSTALLATION, "https://backend-b.example.test"]]
      : [[INSTALLATION, BACKEND]]) {
      const bytes = await openMediaBytes({ indexedDB: factory,
        databaseName: `findback-chat-media-bytes-v1:${JSON.stringify([target, A, deviceId, backend])}` });
      try { expect(await bytes.keys(A)).toEqual([]); } finally { await bytes.close(); }
    }
  });

  it("retains deletion retry after byte failure then verifies every byte on retry", async () => {
    const first = await open(); await enqueue(first); await first.close();
    const transaction = IDBDatabase.prototype.transaction;
    vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, ...args) {
      if (this.name.startsWith("findback-chat-media-bytes") && args[1] === "readwrite") throw new Error("synthetic byte failure");
      return transaction.apply(this, args);
    });
    await expect(purgePlatformMessagingAccount(A, { indexedDB: factory })).rejects.toThrow();
    vi.restoreAllMocks();
    expect(await listPendingMessagingDeletions(factory)).toEqual([A]);
    await expect(open()).rejects.toThrow(/delet/i);
    await purgePlatformMessagingAccount(A, { indexedDB: factory });
    expect(await listPendingMessagingDeletions(factory)).toEqual([]);
    // Idempotent cleanup does not remove the permanent fence.
    await purgePlatformMessagingAccount(A, { indexedDB: factory });
    await expect(open()).rejects.toThrow(/delet/i);
  });

  it("includes registered text-only history in account deletion", async () => {
    const first = await openPlatformMessagingHistory({ accountId: A, deviceId: INSTALLATION, indexedDB: factory });
    await first.history.enqueueOutgoing(outgoing); await first.close();
    await purgePlatformMessagingAccount(A, { indexedDB: factory });
    expect(await listPendingMessagingDeletions(factory)).toEqual([]);
    await expect(openPlatformMessagingHistory({ accountId: A, deviceId: INSTALLATION, indexedDB: factory })).rejects.toThrow(/delet/i);
  });

  it("discovers pre-registry history without guessing its backend or current installation", async () => {
    // This is how a text-only pre-registry release opened its database. The
    // old web installation/native stored device differs from today's identity.
    const scope = { accountId: A, deviceId: OTHER_INSTALLATION };
    const old = target === "android"
      ? await openSqliteMessagingHistory(await openAndroidMessagingSqliteDriver({ accountId: A }), scope)
      : await openWebMessagingHistory(scope, { indexedDB: factory });
    await old.enqueueOutgoing(outgoing); await old.close();
    await purgePlatformMessagingAccount(A, { indexedDB: factory });
    expect(await listMessagingStorageScopes(A, factory)).toEqual([{ platform: target, ...scope }]);
    expect(await listPendingMessagingDeletions(factory)).toEqual([]);
    // Trusted low-level reopen is permitted for inspecting the permanent C1
    // fence; even it may not resurrect ordinary history after the purge.
    const inspected = target === "android"
      ? await openSqliteMessagingHistory(await openAndroidMessagingSqliteDriver({ accountId: A }), scope)
      : await openWebMessagingHistory(scope, { indexedDB: factory });
    try { await expect(inspected.getMessage(MESSAGE)).rejects.toThrow(/purged/i); }
    finally { await inspected.close(); }
  });

  it("continues legacy discovery after a malformed name and purges later valid history", async () => {
    const a = await open(); await enqueue(a); await a.close();
    const legacyScope = { accountId: A, deviceId: OTHER_INSTALLATION };
    const legacy = await openWebMessagingHistory(legacyScope, { indexedDB: factory });
    await legacy.enqueueOutgoing(outgoing); await legacy.close();
    const malformed = `findback-human-history-v1:${A}:invalid-device`;
    const bad = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(malformed);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    bad.close();
    const names = await factory.databases();
    vi.spyOn(factory, "databases").mockResolvedValueOnce([
      ...names.filter((row) => row.name === malformed), ...names.filter((row) => row.name !== malformed),
    ]);
    await expect(purgePlatformMessagingAccount(A, { indexedDB: factory })).rejects.toThrow(/incomplete/i);
    expect(await listPendingMessagingDeletions(factory)).toEqual([A]);
    await expectKnownAStoresEmpty();
    expect(await listMessagingStorageScopes(A, factory)).toContainEqual({ platform: "web", ...legacyScope });
    const inspected = await openWebMessagingHistory(legacyScope, { indexedDB: factory });
    try { await expect(inspected.getMessage(MESSAGE)).rejects.toThrow(/purged/i); }
    finally { await inspected.close(); }
  });

  it("retains pending deletion when legacy database inventory cannot be verified", async () => {
    const first = await open(); await enqueue(first); await first.close();
    vi.spyOn(factory, "databases").mockRejectedValueOnce(new Error("synthetic inventory failure"));
    await expect(purgePlatformMessagingAccount(A, { indexedDB: factory })).rejects.toThrow(/incomplete/i);
    expect(await listPendingMessagingDeletions(factory)).toEqual([A]);
    await expectKnownAStoresEmpty();
    await purgePlatformMessagingAccount(A, { indexedDB: factory });
    expect(await listPendingMessagingDeletions(factory)).toEqual([]);
  });

  it("reopens a queued image-only parent with its durable bytes and metadata", async () => {
    const first = await open();
    const fixture = await enqueue(first);
    await first.close();
    clock += MEDIA_SWEEP_GRACE_MS + 1;
    const again = await open();
    expect(await again.history.readMedia(ATTACHMENT)).toEqual(fixture.bytes);
    expect(await again.history.listOutbox()).toEqual([{ messageId: MESSAGE, status: "QUEUED", attempts: 0 }]);
    expect((await again.history.listMedia(CONVERSATION)).map((row) => row.state)).toEqual(["QUEUED"]);
    expect((await again.history.getMessage(MESSAGE))?.body).toBe("");
    expect(again.close()).toBe(again.close());
  });

  it("refuses backend conflict before metadata open or cleanup and preserves the first history", async () => {
    const first = await open();
    const fixture = await enqueue(first);
    await first.close();
    clock += MEDIA_SWEEP_GRACE_MS + 1;
    const nativeOpens = fakePlugin.open.mock.calls.length;
    const connect = factory.open.bind(factory);
    const openedNames: string[] = [];
    vi.spyOn(factory, "open").mockImplementation((name, version) => { openedNames.push(name); return connect(name, version); });
    await expect(open({ backendUrl: "https://backend-b.example.test" })).rejects.toThrow(/ownership/i);
    expect(fakePlugin.open.mock.calls.length).toBe(nativeOpens);
    expect(openedNames.some((name) => name.startsWith("findback-human-history"))).toBe(false);
    const again = await open();
    expect(await again.history.readMedia(ATTACHMENT)).toEqual(fixture.bytes);
    expect((await again.history.listMedia(CONVERSATION)).map((row) => row.id)).toEqual([ATTACHMENT]);
  });

  it.each(["account", "platform", "installation"])("does not let another %s sweep or purge aged bytes", async (different) => {
    const first = await open();
    const fixture = await enqueue(first);
    clock += MEDIA_SWEEP_GRACE_MS + 1;
    if (different === "platform") {
      platform.name = target === "android" ? "web" : "android";
      platform.native = platform.name === "android";
    }
    if (target === "android" && different === "installation") {
      await first.close();
      fakePlugin.installationId.mockResolvedValue({ id: OTHER_INSTALLATION });
      await expect(open({ deviceId: OTHER_INSTALLATION })).rejects.toThrow(/ownership/i);
      fakePlugin.installationId.mockResolvedValue({ id: INSTALLATION });
      const again = await open();
      expect(await again.history.readMedia(ATTACHMENT)).toEqual(fixture.bytes);
      return;
    }
    const second = await open(different === "account" ? { accountId: B }
      : different === "installation" ? { deviceId: OTHER_INSTALLATION } : {});
    await second.history.clearMedia();
    expect(await first.history.readMedia(ATTACHMENT)).toEqual(fixture.bytes);
    expect((await first.history.listMedia(CONVERSATION)).map((row) => row.state)).toEqual(["QUEUED"]);
  });

  it("closes bytes only after admitted history byte cleanup commits", async () => {
    const handle = await open();
    await enqueue(handle);
    const order: string[] = [];
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const transact = IDBDatabase.prototype.transaction;
    vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, ...args) {
      const tx = transact.apply(this, args);
      if (this.name.startsWith("findback-chat-media-bytes") && args[1] === "readwrite") {
        tx.addEventListener("complete", () => order.push("byte-commit"));
        entered();
      }
      return tx;
    });
    const close = IDBDatabase.prototype.close;
    vi.spyOn(IDBDatabase.prototype, "close").mockImplementation(function (this: IDBDatabase) {
      if (this.name.startsWith("findback-chat-media-bytes")) order.push("byte-close");
      return close.call(this);
    });
    const purging = handle.history.clearMedia();
    // SQLite's existing serial wrapper rejects post-close results even when
    // cleanup committed (sqliteHistory.ts serial). Assert that exact contract,
    // then independently prove the durable cleanup and byte-close ordering.
    const settled = target === "android" ? expect(purging).rejects.toThrow(/closed/i)
      : expect(purging).resolves.toBeUndefined();
    await ready;
    const closing = handle.close();
    await settled;
    await closing;
    expect(order).toEqual(["byte-commit", "byte-close"]);
    const again = await open();
    expect(await again.history.listMedia(CONVERSATION)).toEqual([]);
    expect(await again.history.readMedia(ATTACHMENT)).toBeNull();
  });

  it("refuses missing Web Locks and closes its owned byte connection", async () => {
    vi.stubGlobal("navigator", {});
    const closed: string[] = [];
    const close = IDBDatabase.prototype.close;
    vi.spyOn(IDBDatabase.prototype, "close").mockImplementation(function (this: IDBDatabase) {
      closed.push(this.name); return close.call(this);
    });
    await expect(open()).rejects.toThrow(/Web Locks/);
    expect(closed.some((name) => name.startsWith("findback-chat-media-bytes"))).toBe(true);
    vi.unstubAllGlobals();
    const again = await open();
    await enqueue(again);
  });

  it("keeps the captured scope when the caller mutates options during open", async () => {
    const options = { accountId: A, deviceId: INSTALLATION, indexedDB: factory,
      media: { backendUrl: BACKEND } };
    const pending = openPlatformMessagingHistory(options);
    options.accountId = B;
    options.deviceId = OTHER_INSTALLATION;
    options.media.backendUrl = "https://backend-b.example.test";
    const first = await pending;
    mediaHandles.push(first);
    expect(first.scope).toEqual({ accountId: A, deviceId: INSTALLATION });
    const fixture = await enqueue(first);
    await first.close();
    const again = await open();
    expect(await again.history.readMedia(ATTACHMENT)).toEqual(fixture.bytes);
  });

  if (target === "android") {
    it("closes owned bytes after native setup fails and allows a clean retry", async () => {
      const closed: string[] = [];
      const close = IDBDatabase.prototype.close;
      vi.spyOn(IDBDatabase.prototype, "close").mockImplementation(function (this: IDBDatabase) {
        closed.push(this.name); return close.call(this);
      });
      fakePlugin.all.mockRejectedValueOnce(new Error("initialization failed"));
      await expect(open()).rejects.toMatchObject({ kind: "command-failed" });
      expect(closed.filter((name) => name.startsWith("findback-chat-media-bytes"))).toHaveLength(1);
      const again = await open();
      await enqueue(again);
    });

    it("still closes bytes but retains the native lease when native teardown fails", async () => {
      const accountId = "00000000-0000-4000-8000-0000000000f3";
      const first = await open({ accountId });
      const closed: string[] = [];
      const close = IDBDatabase.prototype.close;
      vi.spyOn(IDBDatabase.prototype, "close").mockImplementation(function (this: IDBDatabase) {
        closed.push(this.name); return close.call(this);
      });
      fakePlugin.close.mockRejectedValue(new Error("close failed"));
      const pending = first.close();
      expect(first.close()).toBe(pending);
      await expect(pending).rejects.toMatchObject({ kind: "command-failed" });
      expect(closed.filter((name) => name.startsWith("findback-chat-media-bytes"))).toHaveLength(1);
      await expect(open({ accountId })).rejects.toMatchObject({ kind: "already-open" });
    });
  }
});
