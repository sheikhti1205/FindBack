// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBDatabase, IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { MEDIA_SWEEP_GRACE_MS } from "./media";
import { openMediaBytes } from "./mediaBytes";
import * as mediaByteModule from "./mediaBytes";
import { deferred } from "./mediaTestDoubles";
import {
  assertMediaBytesOwner, openScopedMediaBytes,
  beginMessagingAccountDeletion, listPendingMessagingDeletions, listMessagingStorageScopes,
  openMessagingCleanupBytes,
  type MediaStorageOwner, type ScopedMediaBytes,
} from "./scopedMediaBytes";

const A = "00000000-0000-4000-8000-000000000001";
const B = "00000000-0000-4000-8000-000000000002";
const DEVICE = "00000000-0000-4000-8000-000000000003";
const DEVICE_B = "00000000-0000-4000-8000-000000000004";
const ATTACHMENT = "00000000-0000-4000-8000-000000000005";
const owner: MediaStorageOwner = { platform: "web", accountId: A, deviceId: DEVICE, backendUrl: "https://backend-a.example.test" };
const payload = new Uint8Array([1, 2, 3, 4]).buffer;
let indexedDB: IDBFactory;
let clock: number;
let opened: ScopedMediaBytes[];

async function open(value: MediaStorageOwner = owner) {
  const bytes = await openScopedMediaBytes(value, { indexedDB, now: () => clock });
  opened.push(bytes);
  return bytes;
}

beforeEach(() => { indexedDB = new IDBFactory(); clock = 1_000_000; opened = []; });
afterEach(async () => { await Promise.all(opened.map((bytes) => bytes.close())); vi.restoreAllMocks(); });

describe("scoped production media byte ownership", () => {
  it("fencing waits for an admitted raw byte write and rejects subsequent writes", async () => {
    const create = mediaByteModule.openMediaBytes, entered = deferred(), release = deferred();
    const order: string[] = [];
    vi.spyOn(mediaByteModule, "openMediaBytes").mockImplementationOnce(async (options) => {
      const raw = await create(options);
      return { ...raw, async put(...args) {
        entered.resolve(); await release.promise;
        await raw.put(...args); order.push("byte committed");
      } };
    });
    const bytes = await open();
    const writing = bytes.put(A, ATTACHMENT, payload);
    let deletion: Promise<unknown> | undefined;
    try {
      await entered.promise;
      deletion = beginMessagingAccountDeletion(A, indexedDB).then(() => { order.push("fence committed"); });
      await beginMessagingAccountDeletion(B, indexedDB);
      expect(await listPendingMessagingDeletions(indexedDB)).toEqual([B]);
    } finally { release.resolve(); }
    await writing; await deletion;
    expect(order).toEqual(["byte committed", "fence committed"]);
    await expect(bytes.put(A, ATTACHMENT, payload)).rejects.toThrow(/delet/i);
    const cleanup = await openMessagingCleanupBytes(owner, indexedDB); opened.push(cleanup);
    expect(await cleanup.keys(A)).toEqual([ATTACHMENT]);
    await cleanup.clearAccount(A);
    expect(await cleanup.keys(A)).toEqual([]);
  });

  it("durably fences every live and future scope while preserving another account", async () => {
    const first = await open();
    const second = await open({ ...owner, deviceId: DEVICE_B, backendUrl: "https://backend-b.example.test" });
    const other = await open({ ...owner, accountId: B });
    await first.put(A, ATTACHMENT, payload);
    await other.put(B, ATTACHMENT, payload);
    await beginMessagingAccountDeletion(A, indexedDB);
    expect(await listPendingMessagingDeletions(indexedDB)).toEqual([A]);
    expect(await listMessagingStorageScopes(A, indexedDB)).toEqual(expect.arrayContaining([
      owner, { ...owner, deviceId: DEVICE_B, backendUrl: "https://backend-b.example.test" },
    ]));
    for (const port of [first, second]) {
      await expect(port.put(A, ATTACHMENT, payload)).rejects.toThrow(/delet/i);
      await expect(port.get(A, ATTACHMENT)).rejects.toThrow(/delet/i);
      await expect(port.clearAccount(A)).rejects.toThrow(/delet/i);
    }
    await first.close(); await second.close();
    await expect(open()).rejects.toThrow(/delet/i);
    await expect(open({ ...owner, deviceId: "00000000-0000-4000-8000-000000000099" })).rejects.toThrow(/delet/i);
    expect(await other.get(B, ATTACHMENT)).toEqual(payload);
    await beginMessagingAccountDeletion(B, indexedDB);
    expect(await listPendingMessagingDeletions(indexedDB)).toEqual([A, B]);
  });

  it("does not accept a weakened durable deletion transaction or lose earlier pending accounts", async () => {
    await open();
    await beginMessagingAccountDeletion(A, indexedDB);
    const transaction = IDBDatabase.prototype.transaction;
    vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, names, mode) {
      return transaction.call(this, names, mode, { durability: "relaxed" });
    });
    await expect(beginMessagingAccountDeletion(B, indexedDB)).rejects.toThrow(/strict/i);
    vi.restoreAllMocks();
    expect(await listPendingMessagingDeletions(indexedDB)).toEqual([A]);
    await expect(open()).rejects.toThrow(/delet/i);
  });

  it("keeps a v1 registered owner's bytes and binding through the deletion-registry upgrade", async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open("findback-chat-media-owners-v1", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("owners", { keyPath: "metadataKey" });
      request.onsuccess = () => resolve(request.result);
    });
    const key = JSON.stringify(["web", A, DEVICE]);
    await new Promise<void>((resolve) => {
      const tx = db.transaction("owners", "readwrite");
      tx.objectStore("owners").add({ metadataKey: key,
        identity: JSON.stringify(["web", A, DEVICE, "https://backend-a.example.test"]), owner });
      tx.oncomplete = () => resolve();
    });
    db.close();
    const raw = await openMediaBytes({ indexedDB,
      databaseName: `findback-chat-media-bytes-v1:${JSON.stringify(["web", A, DEVICE, "https://backend-a.example.test"])}` });
    try { await raw.put(A, ATTACHMENT, payload); } finally { await raw.close(); }
    const upgraded = await open();
    expect(await upgraded.get(A, ATTACHMENT)).toEqual(payload);
    await expect(open({ ...owner, backendUrl: "https://backend-b.example.test" })).rejects.toThrow(/ownership/i);
    await beginMessagingAccountDeletion(A, indexedDB);
    expect(await listPendingMessagingDeletions(indexedDB)).toEqual([A]);
  });

  it("does not acknowledge a deletion request whose registry transaction aborts after the write request", async () => {
    const bytes = await open(); await bytes.put(A, ATTACHMENT, payload);
    const put = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
      const request = put.apply(this, args);
      if (this.name === "deletions") request.addEventListener("success", () => this.transaction.abort());
      return request;
    });
    await expect(beginMessagingAccountDeletion(A, indexedDB)).rejects.toThrow(/aborted/i);
    vi.restoreAllMocks();
    expect(await listPendingMessagingDeletions(indexedDB)).toEqual([]);
    expect(await bytes.get(A, ATTACHMENT)).toEqual(payload);
  });

  it("cleanup byte capabilities cannot read payloads, write, or retarget another account", async () => {
    const bytes = await open(); await bytes.put(A, ATTACHMENT, payload);
    await expect(openMessagingCleanupBytes(owner, indexedDB)).rejects.toThrow(/not admitted/i);
    await beginMessagingAccountDeletion(A, indexedDB);
    const cleanup = await openMessagingCleanupBytes(owner, indexedDB);
    opened.push(cleanup);
    expect(await cleanup.keys(A)).toEqual([ATTACHMENT]);
    await expect(cleanup.get(A, ATTACHMENT)).rejects.toThrow(/cleanup only/i);
    await expect(cleanup.put(A, ATTACHMENT, payload)).rejects.toThrow(/cleanup only/i);
    await expect(cleanup.clearAccount(B)).rejects.toThrow(/scope/i);
    await cleanup.clearAccount(A);
    expect(await cleanup.keys(A)).toEqual([]);
  });

  it("refuses corrupt ownership inventory rather than silently completing an empty account", async () => {
    await open(); await beginMessagingAccountDeletion(A, indexedDB);
    const db = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open("findback-chat-media-owners-v1");
      request.onsuccess = () => resolve(request.result);
    });
    await new Promise<void>((resolve) => {
      const tx = db.transaction("owners", "readwrite");
      tx.objectStore("owners").put({ metadataKey: JSON.stringify(["web", A, DEVICE]), identity: "corrupt", owner });
      tx.oncomplete = () => resolve();
    });
    db.close();
    await expect(listMessagingStorageScopes(A, indexedDB)).rejects.toThrow(/corrupt/i);
    expect(await listPendingMessagingDeletions(indexedDB)).toEqual([A]);
  });

  it("reopens exact scope and canonical backend spelling without losing bytes", async () => {
    const first = await open();
    await first.put(A, ATTACHMENT, payload);
    await first.close();
    const again = await open({ ...owner, backendUrl: "https://BACKEND-A.example.test:443/" });
    expect(await again.get(A, ATTACHMENT)).toEqual(payload);
    expect(await again.totalBytes(A)).toBe(4);
    expect(() => assertMediaBytesOwner(again, owner)).not.toThrow();
  });

  it.each([
    { label: "installation", next: { ...owner, deviceId: DEVICE_B } },
    { label: "account", next: { ...owner, accountId: B } },
    { label: "platform", next: { ...owner, platform: "android" as const } },
  ])("isolates $label bytes from another scope's sweep and whole-store purge", async ({ next }) => {
    const first = await open();
    await first.put(A, ATTACHMENT, payload);
    clock += MEDIA_SWEEP_GRACE_MS + 1;
    const second = await open(next);
    expect(await second.sweep(next.accountId, new Set(), 100)).toBe(0);
    await second.put(next.accountId, ATTACHMENT, new Uint8Array([9]).buffer);
    await second.clearAll();
    expect(await first.get(A, ATTACHMENT)).toEqual(payload);
    expect(await first.totalBytes(A)).toBe(4);
  });

  it.each(["web", "android"] as const)("rejects backend conflicts for the same %s metadata owner across reopen", async (platform) => {
    const identity = { ...owner, platform };
    const first = await open(identity);
    await first.put(A, ATTACHMENT, payload);
    await first.close();
    await expect(open({ ...identity, backendUrl: "https://backend-b.example.test" })).rejects.toThrow(/ownership/i);
    const again = await open(identity);
    expect(await again.get(A, ATTACHMENT)).toEqual(payload);
  });

  it("rejects a changed native installation because the native metadata file is account-bound", async () => {
    await open({ ...owner, platform: "android" });
    await expect(open({ ...owner, platform: "android", deviceId: DEVICE_B })).rejects.toThrow(/ownership/i);
  });

  it("atomically binds only one backend when independent openers race", async () => {
    const alternate = { ...owner, backendUrl: "https://backend-b.example.test" };
    const results = await Promise.allSettled([open(owner), open(alternate)]);
    expect(results.filter((value) => value.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((value) => value.status === "rejected")).toHaveLength(1);
    const winner = results[0].status === "fulfilled" ? owner : alternate;
    const loser = results[0].status === "fulfilled" ? alternate : owner;
    await expect(open(loser)).rejects.toThrow(/ownership/i);
    expect(() => assertMediaBytesOwner(results.find((value) => value.status === "fulfilled")!.value, winner)).not.toThrow();
  });

  it("rejects foreign-account calls on every scoped byte operation", async () => {
    const bytes = await open();
    await bytes.put(A, ATTACHMENT, payload);
    const attempts: Array<() => Promise<unknown>> = [
      () => bytes.put(B, ATTACHMENT, payload), () => bytes.get(B, ATTACHMENT),
      () => bytes.has(B, ATTACHMENT), () => bytes.delete(B, [ATTACHMENT]),
      () => bytes.keys(B), () => bytes.totalBytes(B),
      () => bytes.sweep(B, new Set(), 100), () => bytes.clearAccount(B),
    ];
    for (const attempt of attempts) await expect(Promise.resolve().then(attempt)).rejects.toThrow(/scope/i);
    expect(await bytes.get(A, ATTACHMENT)).toEqual(payload);
  });

  it("rejects forged, unscoped and mismatched ports at runtime", async () => {
    const scoped = await open();
    const raw = await openMediaBytes({ indexedDB });
    try {
      expect(() => assertMediaBytesOwner({ ...scoped }, owner)).toThrow(/ownership/i);
      expect(() => assertMediaBytesOwner(raw, owner)).toThrow(/ownership/i);
      expect(() => assertMediaBytesOwner(scoped, { ...owner, deviceId: DEVICE_B })).toThrow(/ownership/i);
      expect(Object.isFrozen(scoped)).toBe(true);
    } finally { await raw.close(); }
  });

  it.each(["", "not-a-url", "file:///path", "https://backend-a.example.test/?x=1", "https://backend-a.example.test/#fragment", "https://user:synthetic@example.test"])(
    "rejects an invalid or credential-bearing backend without opening storage (%s)", async (backendUrl) => {
      const spy = vi.spyOn(indexedDB, "open");
      await expect(open({ ...owner, backendUrl })).rejects.toThrow(/backend/i);
      expect(spy).not.toHaveBeenCalled();
    },
  );

  it("keeps backend base paths distinct instead of collapsing to one origin", async () => {
    await open({ ...owner, backendUrl: "https://backend-a.example.test/project-a/" });
    await expect(open({ ...owner, backendUrl: "https://backend-a.example.test/project-b/" })).rejects.toThrow(/ownership/i);
  });

  it("memoizes close and immediately invalidates both reads and runtime admission", async () => {
    const bytes = await open();
    const closing = bytes.close();
    expect(bytes.close()).toBe(closing);
    expect(() => assertMediaBytesOwner(bytes, owner)).toThrow(/closed/i);
    await expect(bytes.get(A, ATTACHMENT)).rejects.toThrow(/closed/i);
    await closing;
  });

  it("copies the owner before an await so caller mutation cannot retarget storage", async () => {
    const mutable = { ...owner };
    const opening = open(mutable);
    mutable.accountId = B;
    mutable.backendUrl = "https://backend-b.example.test";
    const bytes = await opening;
    await bytes.put(A, ATTACHMENT, payload);
    await expect(bytes.put(B, ATTACHMENT, payload)).rejects.toThrow(/scope/i);
    expect(() => assertMediaBytesOwner(bytes, owner)).not.toThrow();
  });

  it("refuses non-strict ownership binding before a byte database opens", async () => {
    const transaction = IDBDatabase.prototype.transaction;
    vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, names, mode) {
      return transaction.call(this, names, mode, { durability: "relaxed" });
    });
    const openedNames: string[] = [];
    const connect = indexedDB.open.bind(indexedDB);
    vi.spyOn(indexedDB, "open").mockImplementation((name, version) => {
      openedNames.push(name); return connect(name, version);
    });
    await expect(open()).rejects.toThrow(/strict/i);
    expect(openedNames.filter((name) => name.startsWith("findback-chat-media-bytes"))).toEqual([]);
    vi.restoreAllMocks();
    // Failed registration did not bind A; another backend may now register.
    const alternate = await open({ ...owner, backendUrl: "https://backend-b.example.test" });
    await alternate.put(A, ATTACHMENT, payload);
    expect(await alternate.get(A, ATTACHMENT)).toEqual(payload);
  });

  it("waits for registry commit, not merely the owner insertion request", async () => {
    const add = IDBObjectStore.prototype.add;
    vi.spyOn(IDBObjectStore.prototype, "add").mockImplementation(function (this: IDBObjectStore, ...args) {
      const request = add.apply(this, args);
      if (this.name === "owners") request.addEventListener("success", () => this.transaction.abort());
      return request;
    });
    await expect(open()).rejects.toThrow(/aborted/i);
    vi.restoreAllMocks();
    const alternate = await open({ ...owner, backendUrl: "https://backend-b.example.test" });
    await alternate.put(A, ATTACHMENT, payload);
    expect(await alternate.get(A, ATTACHMENT)).toEqual(payload);
  });

  it.each(["registry", "bytes"])("closes a late %s connection after blocked open already rejected", async (stage) => {
    const connect = indexedDB.open.bind(indexedDB);
    let captured!: IDBOpenDBRequest;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const close = vi.fn();
    vi.spyOn(indexedDB, "open").mockImplementation((name, version) => {
      if ((stage === "registry" && name.includes("owners")) || (stage === "bytes" && name.includes("bytes"))) {
        captured = { result: { close } } as unknown as IDBOpenDBRequest;
        entered();
        return captured;
      }
      return connect(name, version);
    });
    const opening = open();
    const rejected = expect(opening).rejects.toThrow(/blocked/i);
    await ready;
    captured.onblocked!.call(captured, {} as IDBVersionChangeEvent);
    await rejected;
    captured.onsuccess!.call(captured, {} as Event);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
