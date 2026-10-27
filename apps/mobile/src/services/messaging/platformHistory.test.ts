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
import { IDBFactory } from "fake-indexeddb";
import type { HumanMessage } from "./history";

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

import { MessagingSqliteError } from "./androidSqliteDriver";
import { openPlatformMessagingHistory } from "./platformHistory";

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
  dir = mkdtempSync(join(tmpdir(), "chat033-native-"));
  callLog = [];
  openDatabases = [];
  for (const fn of Object.values(fakePlugin)) fn.mockReset();
  registerPluginMock.mockReset().mockImplementation(() => fakePlugin);
  platform.native = true;
  platform.name = "android";
  installFakeNativePlugin();
});

afterEach(() => {
  for (const db of openDatabases) {
    try { db.close(); } catch { /* the adapter may have closed it first */ }
  }
  rmSync(dir, { recursive: true, force: true });
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

  it("fails closed when native open fails and never touches IndexedDB", async () => {
    fakePlugin.open.mockRejectedValue(new Error("native open exploded"));
    const factory = { open: vi.fn() } as unknown as IDBFactory;
    await expect(
      openPlatformMessagingHistory({ accountId: A, indexedDB: factory }),
    ).rejects.toBeInstanceOf(MessagingSqliteError);
    expect(factory.open).not.toHaveBeenCalled();
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
