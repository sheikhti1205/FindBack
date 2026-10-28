// @vitest-environment node
import { IDBFactory, IDBDatabase } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MEDIA_SWEEP_GRACE_MS } from "./media";
import { MediaStorageFullError, openMediaBytes, type MediaBytesStore } from "./mediaBytes";

const A = "00000000-0000-4000-9000-000000000001";
const B = "00000000-0000-4000-9000-000000000002";
const ATT = "00000000-0000-4000-9000-000000000011";
const ATT2 = "00000000-0000-4000-9000-000000000012";
const ATT3 = "00000000-0000-4000-9000-000000000013";

const stores: MediaBytesStore[] = [];
let counter = 0;

async function open(budgetBytes = 1024, now?: () => number): Promise<MediaBytesStore> {
  counter += 1;
  const store = await openMediaBytes({
    indexedDB: new IDBFactory(),
    databaseName: `media-bytes-test-${counter}`,
    budgetBytes,
    now,
  });
  stores.push(store);
  return store;
}

/** A clock the test moves by hand, starting well past the epoch. */
function clockAt(start: number) {
  let current = start;
  return {
    now: () => current,
    advance(ms: number) { current += ms; },
  };
}

function bytes(length: number, fill = 7): ArrayBuffer {
  return new Uint8Array(length).fill(fill).buffer;
}

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

describe("media byte store", () => {
  it("stores exact bytes and accounts for them", async () => {
    const store = await open();
    await store.put(A, ATT, bytes(64));
    const read = await store.get(A, ATT);
    expect(read).not.toBeNull();
    expect(read!.byteLength).toBe(64);
    expect(new Uint8Array(read!)[63]).toBe(7);
    expect(await store.totalBytes(A)).toBe(64);
    expect(await store.has(A, ATT)).toBe(true);
  });

  it("is account-scoped: one account cannot read another's bytes", async () => {
    const store = await open();
    await store.put(A, ATT, bytes(32));
    expect(await store.get(B, ATT)).toBeNull();
    expect(await store.keys(B)).toEqual([]);
    expect(await store.totalBytes(B)).toBe(0);
  });

  it("rejects a write that would exceed the budget without evicting anything", async () => {
    const store = await open(100);
    await store.put(A, ATT, bytes(60));
    await expect(store.put(A, ATT2, bytes(60))).rejects.toBeInstanceOf(MediaStorageFullError);
    // Nothing partial: the rejected entry is absent and the total is unchanged.
    expect(await store.get(A, ATT2)).toBeNull();
    expect(await store.totalBytes(A)).toBe(60);
  });

  it("reports how much space the rejected write needed", async () => {
    const store = await open(100);
    await store.put(A, ATT, bytes(90));
    const failure = await store.put(A, ATT2, bytes(40)).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MediaStorageFullError);
    expect((failure as MediaStorageFullError).needed).toBe(40);
    expect((failure as MediaStorageFullError).available).toBe(10);
  });

  it("does not double-count an overwrite and enforces the delta", async () => {
    const store = await open(100);
    await store.put(A, ATT, bytes(50));
    await store.put(A, ATT, bytes(50, 9));
    expect(await store.totalBytes(A)).toBe(50);
    // Growing the same attachment is a 40-byte delta, which still fits.
    await store.put(A, ATT, bytes(90));
    expect(await store.totalBytes(A)).toBe(90);
    expect((await store.get(A, ATT))!.byteLength).toBe(90);
    // Growing again is a 30-byte delta against 10 free bytes.
    await expect(store.put(A, ATT, bytes(120))).rejects.toBeInstanceOf(MediaStorageFullError);
    expect(await store.totalBytes(A)).toBe(90);
  });

  it("serialises concurrent writes so two callers cannot both pass the budget check", async () => {
    const store = await open(100);
    const results = await Promise.allSettled([
      store.put(A, ATT, bytes(60)),
      store.put(A, ATT2, bytes(60)),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await store.totalBytes(A)).toBe(60);
  });

  it("holds the second write's transaction until the first one has completed", async () => {
    // The budget check above is atomic inside a transaction, which IndexedDB
    // already guarantees. What the queue must actually provide is that the
    // second operation does not even open its transaction until the first has
    // finished — that is what makes a multi-step sequence safe. Without
    // `serial()`, both transactions are created in the same tick and this
    // ordering inverts, so this test fails if the queue is removed.
    const store = await open(100);
    const events: string[] = [];
    let created = 0;
    const original = IDBDatabase.prototype.transaction;
    const spy = vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(
      function (this: IDBDatabase, names, mode, options) {
        created += 1;
        const label = `tx${created}`;
        events.push(`create:${label}`);
        const tx = original.call(this, names, mode, options);
        tx.addEventListener("complete", () => events.push(`complete:${label}`));
        return tx;
      },
    );
    try {
      // Two writes that both fit, so both transactions complete normally.
      await Promise.all([store.put(A, ATT, bytes(40)), store.put(A, ATT2, bytes(40))]);
    } finally {
      spy.mockRestore();
    }
    expect(created).toBe(2);
    expect(events).toEqual(["create:tx1", "complete:tx1", "create:tx2", "complete:tx2"]);
  });

  it("deletes in one transaction and releases exactly the stored size", async () => {
    const store = await open(1000);
    await store.put(A, ATT, bytes(40));
    await store.put(A, ATT2, bytes(60));
    await store.delete(A, [ATT, ATT2, ATT3]);
    expect(await store.get(A, ATT)).toBeNull();
    expect(await store.totalBytes(A)).toBe(0);
    // Deleting again is a no-op, not an underflow.
    await store.delete(A, [ATT]);
    expect(await store.totalBytes(A)).toBe(0);
  });

  it("sweeps only entries whose attachment is no longer known, bounded by the limit", async () => {
    const clock = clockAt(1_000_000_000_000);
    const store = await open(10_000, clock.now);
    for (const id of [ATT, ATT2, ATT3]) await store.put(A, id, bytes(30));
    await store.put(B, ATT, bytes(10));
    clock.advance(MEDIA_SWEEP_GRACE_MS + 1);
    expect(await store.sweep(A, new Set([ATT]), 1)).toBe(1);
    expect((await store.keys(A)).sort()).toEqual([ATT, ATT3].sort());
    expect(await store.sweep(A, new Set([ATT]), 5)).toBe(1);
    expect(await store.keys(A)).toEqual([ATT]);
    expect(await store.totalBytes(A)).toBe(30);
    // The sweep never crosses into another account.
    expect(await store.keys(B)).toEqual([ATT]);
  });

  it("keeps an empty keep-set meaning 'everything is an orphan'", async () => {
    const clock = clockAt(1_000_000_000_000);
    const store = await open(10_000, clock.now);
    await store.put(A, ATT, bytes(30));
    clock.advance(MEDIA_SWEEP_GRACE_MS + 1);
    expect(await store.sweep(A, new Set(), 10)).toBe(1);
    expect(await store.keys(A)).toEqual([]);
    expect(await store.totalBytes(A)).toBe(0);
  });

  it("clears one account without touching another", async () => {
    const store = await open(10_000);
    await store.put(A, ATT, bytes(30));
    await store.put(B, ATT, bytes(40));
    await store.clearAccount(A);
    expect(await store.keys(A)).toEqual([]);
    expect(await store.totalBytes(A)).toBe(0);
    expect(await store.keys(B)).toEqual([ATT]);
    expect(await store.totalBytes(B)).toBe(40);
  });

  it("clears the whole database for account deletion", async () => {
    const store = await open(10_000);
    await store.put(A, ATT, bytes(30));
    await store.put(B, ATT, bytes(40));
    await store.clearAll();
    expect(await store.keys(A)).toEqual([]);
    expect(await store.keys(B)).toEqual([]);
    expect(await store.totalBytes(A)).toBe(0);
  });

  it("never sweeps bytes that a send has just stored but not yet recorded", async () => {
    // The invariant the module promises: bytes first, row second. A sweep that
    // ran in that window would delete the only copy and the row would then
    // claim bytes that do not exist.
    const clock = clockAt(1_000_000_000_000);
    const store = await open(10_000, clock.now);
    await store.put(A, ATT, bytes(30));
    // Immediately after the write, with no attachment row, this must be kept.
    expect(await store.sweep(A, new Set(), 10)).toBe(0);
    expect(await store.get(A, ATT)).not.toBeNull();
    // It becomes sweepable only once the grace window has elapsed.
    clock.advance(MEDIA_SWEEP_GRACE_MS + 1);
    expect(await store.sweep(A, new Set(), 10)).toBe(1);
    expect(await store.get(A, ATT)).toBeNull();
  });

  it("refuses a blob larger than the transport ceiling", async () => {
    const store = await open(200 * 1024 * 1024);
    await expect(store.put(A, ATT, bytes(20 * 1024 * 1024 + 1)))
      .rejects.toThrow("Media byte size exceeds the transport limit");
    expect(await store.totalBytes(A)).toBe(0);
  });

  it("completes an admitted account purge even if close() arrives first", async () => {
    // Account deletion must not be cancellable by a sign-out racing it: a purge
    // that aborts on `closed` leaves exactly the media this method exists to
    // remove.
    const indexedDB = new IDBFactory();
    const name = `media-bytes-purge-${(counter += 1)}`;
    const store = await openMediaBytes({ indexedDB, databaseName: name, budgetBytes: 1024 });
    await store.put(A, ATT, bytes(40));
    await store.put(B, ATT2, bytes(40));
    const purge = store.clearAll();
    const closing = store.close();
    await expect(purge).resolves.toBeUndefined();
    await closing;
    // Reopen: the purge must be durable, not merely resolved.
    const again = await openMediaBytes({ indexedDB, databaseName: name, budgetBytes: 1024 });
    stores.push(again);
    expect(await again.keys(A)).toEqual([]);
    expect(await again.keys(B)).toEqual([]);
    expect(await again.totalBytes(A)).toBe(0);
  });

  it("resolves a write that completed even if close() raced it", async () => {
    // `now()` is called inside the write, after the budget decision and before
    // the transaction completes, so closing here lands exactly in the window
    // where the bytes are already committed but `oncomplete` has not fired.
    let closing: Promise<void> | undefined;
    const store = await openMediaBytes({
      indexedDB: new IDBFactory(),
      databaseName: `media-bytes-close-race-${(counter += 1)}`,
      budgetBytes: 1024,
      // `now()` runs inside the write, long after `store` is bound.
      now: () => { closing ??= store.close(); return Date.now(); },
    });
    stores.push(store);
    // The write is durable, so reporting it as a failure would invite a retry
    // of work that already happened.
    await expect(store.put(A, ATT, bytes(48))).resolves.toBeUndefined();
    await closing;
    // Only work that had not started is refused.
    await expect(store.put(A, ATT2, bytes(4))).rejects.toThrow("Media byte storage closed");
  });

  it("refuses malformed input rather than storing a zero-length blob", async () => {
    const store = await open();
    await expect(store.put(A, ATT, new ArrayBuffer(0))).rejects.toThrow("Invalid media bytes");
    await expect(store.put("", ATT, bytes(4))).rejects.toThrow("Invalid media account");
    await expect(store.put(A, "", bytes(4))).rejects.toThrow("Invalid media attachment");
    await expect(store.get(A, "")).rejects.toThrow("Invalid media attachment");
    await expect(store.sweep(A, new Set(), 0)).rejects.toThrow("Invalid media sweep limit");
  });

  it("survives a reopen: bytes and the account total are durable, not in memory", async () => {
    const indexedDB = new IDBFactory();
    const name = "media-bytes-reopen";
    const first = await openMediaBytes({ indexedDB, databaseName: name, budgetBytes: 1024 });
    await first.put(A, ATT, bytes(48));
    await first.close();
    const second = await openMediaBytes({ indexedDB, databaseName: name, budgetBytes: 1024 });
    stores.push(second);
    expect((await second.get(A, ATT))!.byteLength).toBe(48);
    expect(await second.totalBytes(A)).toBe(48);
  });

  it("invalidates the handle on close instead of silently writing afterwards", async () => {
    const store = await open();
    await store.close();
    await expect(store.put(A, ATT, bytes(4))).rejects.toThrow("Media byte storage closed");
    await expect(store.get(A, ATT)).rejects.toThrow("Media byte storage closed");
  });
});
