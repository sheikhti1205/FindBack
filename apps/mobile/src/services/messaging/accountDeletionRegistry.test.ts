// @vitest-environment node
import { IDBDatabase, IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertMessagingAccountActive, beginConfirmedAccountDeletion, beginMessagingAccountDeletion,
  finishAccountAuthCleanup, finishMessagingAccountDeletion, inspectPendingAccountDeletions,
  listPendingMessagingDeletions,
} from "./scopedMediaBytes";

const A = "00000000-0000-4000-8000-000000000001";
const B = "00000000-0000-4000-8000-000000000002";
let factory: IDBFactory;
beforeEach(() => { factory = new IDBFactory(); });
afterEach(() => { vi.restoreAllMocks(); });

async function putRow(row: object, version?: number) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = version ? factory.open("findback-chat-media-owners-v1", version) : factory.open("findback-chat-media-owners-v1");
    request.onupgradeneeded = () => {
      request.result.createObjectStore("owners", { keyPath: "metadataKey" });
      request.result.createObjectStore("deletions", { keyPath: "accountId" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("deletions", "readwrite");
      tx.objectStore("deletions").put(row);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}

describe("confirmed account deletion durable responsibilities", () => {
  it("admits messaging and auth together, and messaging completion cannot clear auth", async () => {
    const authRevision = await beginConfirmedAccountDeletion(A, factory);
    const mediaRevision = await beginMessagingAccountDeletion(A, factory);
    await finishMessagingAccountDeletion(A, mediaRevision, factory);
    expect(await listPendingMessagingDeletions(factory)).toEqual([]);
    expect(await inspectPendingAccountDeletions(factory)).toEqual({ failures: [], pending: [
      { accountId: A, messagingPending: false, authPending: true, authRevision },
    ] });
    await finishAccountAuthCleanup(A, authRevision, factory);
    expect(await inspectPendingAccountDeletions(factory)).toEqual({ pending: [], failures: [] });
    await expect(assertMessagingAccountActive(A, factory)).rejects.toThrow(/deleted/i);
  });

  it("auth completion cannot clear messaging work, including across another account's admission", async () => {
    const revision = await beginConfirmedAccountDeletion(A, factory);
    await beginConfirmedAccountDeletion(B, factory);
    await finishAccountAuthCleanup(A, revision, factory);
    const inventory = await inspectPendingAccountDeletions(factory);
    expect(inventory.failures).toEqual([]);
    expect(inventory.pending).toEqual([
      { accountId: A, messagingPending: true, authPending: false, authRevision: revision },
      { accountId: B, messagingPending: true, authPending: true, authRevision: 1 },
    ]);
  });

  it("rejects older auth acknowledgments after a newer confirmed deletion", async () => {
    const earlier = await beginConfirmedAccountDeletion(A, factory);
    const newer = await beginConfirmedAccountDeletion(A, factory);
    expect(newer).toBeGreaterThan(earlier);
    await expect(finishAccountAuthCleanup(A, earlier, factory)).rejects.toThrow(/superseded/i);
    expect((await inspectPendingAccountDeletions(factory)).pending[0]!.authPending).toBe(true);
    await finishAccountAuthCleanup(A, newer, factory);
    expect((await inspectPendingAccountDeletions(factory)).pending[0]!.authPending).toBe(false);
  });

  it("upgrades v2 messaging-only rows without inventing auth completion or losing the fence", async () => {
    await putRow({ accountId: A, pending: true, revision: 7 }, 2);
    expect(await inspectPendingAccountDeletions(factory)).toEqual({ failures: [], pending: [
      { accountId: A, messagingPending: true, authPending: false, authRevision: 0 },
    ] });
    await expect(assertMessagingAccountActive(A, factory)).rejects.toThrow(/deleted/i);
    const auth = await beginConfirmedAccountDeletion(A, factory);
    expect(auth).toBe(1);
    await finishAccountAuthCleanup(A, auth, factory);
    expect(await listPendingMessagingDeletions(factory)).toEqual([A]);
  });

  it("keeps valid pending accounts available while explicitly reporting a corrupt row", async () => {
    await beginConfirmedAccountDeletion(B, factory);
    await putRow({ accountId: A, pending: true, revision: 1, authPending: true });
    const inventory = await inspectPendingAccountDeletions(factory);
    expect(inventory.failures).toHaveLength(1);
    expect(inventory.pending.map((row) => row.accountId)).toEqual([B]);
  });

  it("does not admit either responsibility when the joint write aborts", async () => {
    const put = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
      const request = put.apply(this, args);
      if (this.name === "deletions") request.addEventListener("success", () => this.transaction.abort());
      return request;
    });
    await expect(beginConfirmedAccountDeletion(A, factory)).rejects.toThrow(/aborted/i);
    vi.restoreAllMocks();
    expect(await inspectPendingAccountDeletions(factory)).toEqual({ pending: [], failures: [] });
    await assertMessagingAccountActive(A, factory);
  });

  it("refuses non-strict joint admission rather than returning a durable success", async () => {
    const transaction = IDBDatabase.prototype.transaction;
    vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, names, mode) {
      return transaction.call(this, names, mode, { durability: "relaxed" });
    });
    await expect(beginConfirmedAccountDeletion(A, factory)).rejects.toThrow(/strict/i);
    vi.restoreAllMocks();
    expect(await inspectPendingAccountDeletions(factory)).toEqual({ pending: [], failures: [] });
  });
});
