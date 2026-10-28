/**
 * Durable chat-media byte store: one IndexedDB database, used on Android and web.
 *
 * Why IndexedDB on both: the messaging SQLite bridge carries only scalar
 * values (no `bindBlob`, `readRows` rejects BLOB), and the Android side has no
 * Robolectric or instrumented suite on this host, so a native byte path could
 * never be executed here. The app already stores report-draft photo bytes in
 * IndexedDB from the Android WebView, so this is the path that already ships.
 *
 * What this store owns: bytes, their length, and a per-account total. What it
 * does not own: whether a record is allowed to be evicted. That is a history
 * question (a pending upload may be the only copy), so eviction is driven by
 * the adapter, which asks this store to delete by attachment id.
 *
 * Ordering, not a shared transaction, is what makes the two stores safe: bytes
 * are committed here first, the metadata row second, and only then may an
 * upload be claimed or a delivery be acknowledged. A crash therefore leaves
 * orphan bytes (sweepable) or a pending row (retryable), never a row that
 * claims bytes which do not exist.
 *
 * That invariant only holds if the sweep respects the transient window between
 * `put` and the attachment row. `sweep` therefore refuses to touch bytes newer
 * than `MEDIA_SWEEP_GRACE_MS`, which is the one thing presence alone cannot
 * distinguish from a true orphan.
 *
 * Platform requirement: `{ durability: "strict" }` on a transaction is read
 * back and enforced, so the host must be a browser or WebView that supports it
 * (Chromium 83+). An engine without it is refused rather than silently treated
 * as durable, because every ACK downstream depends on this write being real.
 */
import { MEDIA_BUDGET_BYTES, MEDIA_MAX_BYTES, MEDIA_SWEEP_GRACE_MS } from "./media";

const DEFAULT_DATABASE = "findback-chat-media-bytes";
const BYTES = "bytes";
const BUDGET = "budget";

interface ByteRow {
  accountId: string;
  attachmentId: string;
  bytes: ArrayBuffer;
  byteSize: number;
  storedAt: number;
}

interface BudgetRow {
  accountId: string;
  totalBytes: number;
}

/** Typed so callers can keep the user's draft instead of evicting protected bytes. */
export class MediaStorageFullError extends Error {
  constructor(readonly needed: number, readonly available: number) {
    super("Not enough local media space");
    this.name = "MediaStorageFullError";
  }
}

export interface MediaBytesStore {
  /** Rejects with `MediaStorageFullError` rather than evicting anything itself. */
  put(accountId: string, attachmentId: string, bytes: ArrayBuffer): Promise<void>;
  get(accountId: string, attachmentId: string): Promise<ArrayBuffer | null>;
  has(accountId: string, attachmentId: string): Promise<boolean>;
  /** One transaction: either every listed entry is gone or none is. */
  delete(accountId: string, attachmentIds: readonly string[]): Promise<void>;
  /** Attachment ids this account currently holds bytes for. */
  keys(accountId: string): Promise<string[]>;
  totalBytes(accountId: string): Promise<number>;
  /**
   * Bounded orphan sweep: drop byte entries whose attachment id is not in
   * `keep`, at most `limit` per call, and repair the account total. Returns how
   * many entries were removed so a caller can loop with a bound.
   *
   * Entries stored less than `MEDIA_SWEEP_GRACE_MS` ago are never candidates:
   * a send writes bytes before its attachment row, so a fresh entry with no row
   * is in progress, not orphaned.
   */
  sweep(accountId: string, keep: ReadonlySet<string>, limit: number): Promise<number>;
  clearAccount(accountId: string): Promise<void>;
  /** Account deletion: the whole database, not just one account. */
  clearAll(): Promise<void>;
  close(): Promise<void>;
}

export interface MediaBytesOptions {
  indexedDB?: IDBFactory;
  databaseName?: string;
  now?: () => number;
  /** Test override for the account budget. */
  budgetBytes?: number;
}

function connect(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(BYTES)) {
        const bytes = db.createObjectStore(BYTES, { keyPath: ["accountId", "attachmentId"] });
        bytes.createIndex("account", "accountId");
      }
      if (!db.objectStoreNames.contains(BUDGET)) {
        db.createObjectStore(BUDGET, { keyPath: "accountId" });
      }
    };
    request.onblocked = () => reject(new Error("Media storage upgrade blocked"));
    request.onerror = () => reject(new Error("Media storage could not open"));
    request.onsuccess = () => resolve(request.result);
  });
}

export async function openMediaBytes(options: MediaBytesOptions = {}): Promise<MediaBytesStore> {
  const factory = options.indexedDB ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!factory) throw new Error("Media byte storage unavailable");
  const now = options.now ?? Date.now;
  const budget = options.budgetBytes ?? MEDIA_BUDGET_BYTES;
  if (!Number.isSafeInteger(budget) || budget <= 0) throw new Error("Invalid media budget");
  const db = await connect(factory, options.databaseName ?? DEFAULT_DATABASE);

  let closed = false;
  /** Per-account serialisation: the budget check is read-then-write. */
  const queues = new Map<string, Promise<unknown>>();
  /** Sign-out must not race an in-flight write for any account. */
  let globalBarrier: Promise<unknown> = Promise.resolve();

  function assertOpen() {
    if (closed) throw new Error("Media byte storage closed");
  }

  function serial<T>(accountId: string, work: () => Promise<T>): Promise<T> {
    const barrier = globalBarrier;
    const prior = queues.get(accountId) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(async () => {
      await barrier;
      // Refuse work that has not started. Once `work()` has begun its own
      // transaction the outcome belongs to that transaction, so there is no
      // second check here: a write that committed must not be reported as a
      // failure just because `close()` raced it.
      assertOpen();
      return work();
    });
    queues.set(accountId, next);
    void next.catch(() => undefined).then(() => {
      if (queues.get(accountId) === next) queues.delete(accountId);
    });
    return next;
  }

  /**
   * Resolve on transaction completion only. A request's success event is not a
   * durable write, and this store is what makes an ACK honest.
   */
  function transact<T>(
    stores: string[],
    mode: IDBTransactionMode,
    action: (tx: IDBTransaction, resolve: (value: T) => void, guard: (callback: () => void) => () => void) => void,
    /** `false` only for work already admitted before `close()` was called. */
    requireOpen = true,
  ): Promise<T> {
    if (requireOpen) assertOpen();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(stores, mode, mode === "readwrite" ? { durability: "strict" } : undefined);
      let value: T;
      let failure: Error | undefined;
      // No `assertOpen()` here: a transaction that has already started owns its
      // outcome, so `close()` must not abort work that is mid-commit. Admission
      // is decided when an operation is enqueued, not per request callback.
      const guard = (callback: () => void) => () => {
        try {
          callback();
        } catch (error) {
          failure = error instanceof Error ? error : new Error(String(error));
          try { tx.abort(); } catch { /* already finished */ }
        }
      };
      // A completed transaction is a durable write. Reporting it as a failure
      // because `close()` raced it would invite a retry of work that already
      // happened. Only work that has not started is refused (see `assertOpen`).
      tx.oncomplete = () => resolve(value);
      tx.onabort = () => reject(failure ?? new Error("Media storage transaction aborted"));
      // Request errors abort the transaction and are reported through `onabort`
      // with the original failure; `onerror` itself carries nothing extra.
      tx.onerror = () => { /* reported by onabort */ };
      guard(() => {
        if (mode === "readwrite" && tx.durability !== "strict") {
          throw new Error("Media storage requires strict transaction durability");
        }
        action(tx, (result) => { value = result; }, guard);
      })();
    });
  }

  async function put(accountId: string, attachmentId: string, bytes: ArrayBuffer): Promise<void> {
    if (typeof accountId !== "string" || !accountId) throw new Error("Invalid media account");
    if (typeof attachmentId !== "string" || !attachmentId) throw new Error("Invalid media attachment");
    if (!(bytes instanceof ArrayBuffer) || bytes.byteLength === 0) throw new Error("Invalid media bytes");
    const limit = budget;
    const byteSize = bytes.byteLength;
    // Defence in depth: metadata validation enforces the transport ceiling, but
    // this store is also reachable directly, so it refuses an oversized blob
    // rather than relying on a caller having checked first.
    if (byteSize > MEDIA_MAX_BYTES) throw new Error("Media byte size exceeds the transport limit");
    await serial(accountId, () => transact<void>([BYTES, BUDGET], "readwrite", (tx, resolve, guard) => {
      const store = tx.objectStore(BYTES);
      const budgetStore = tx.objectStore(BUDGET);
      const existing = store.get([accountId, attachmentId]);
      const total = budgetStore.get(accountId);
      let remaining = 2;
      const complete = () => {
        if (--remaining !== 0) return;
        const prior = existing.result as ByteRow | undefined;
        const priorTotal = (total.result as BudgetRow | undefined)?.totalBytes ?? 0;
        const delta = byteSize - (prior?.byteSize ?? 0);
        if (priorTotal + delta > limit) {
          throw new MediaStorageFullError(Math.max(0, delta), Math.max(0, limit - priorTotal));
        }
        store.put({ accountId, attachmentId, bytes, byteSize, storedAt: now() } satisfies ByteRow);
        budgetStore.put({ accountId, totalBytes: priorTotal + delta } satisfies BudgetRow);
        resolve(undefined);
      };
      existing.onsuccess = guard(complete);
      total.onsuccess = guard(complete);
    }));
  }

  async function get(accountId: string, attachmentId: string): Promise<ArrayBuffer | null> {
    if (typeof accountId !== "string" || !accountId) throw new Error("Invalid media account");
    if (typeof attachmentId !== "string" || !attachmentId) throw new Error("Invalid media attachment");
    return transact<ArrayBuffer | null>([BYTES], "readonly", (tx, resolve) => {
      const request = tx.objectStore(BYTES).get([accountId, attachmentId]);
      request.onsuccess = () => resolve((request.result as ByteRow | undefined)?.bytes ?? null);
    });
  }

  async function has(accountId: string, attachmentId: string): Promise<boolean> {
    return (await get(accountId, attachmentId)) !== null;
  }

  async function remove(accountId: string, attachmentIds: readonly string[]): Promise<void> {
    if (typeof accountId !== "string" || !accountId) throw new Error("Invalid media account");
    const ids = [...new Set(attachmentIds)];
    for (const id of ids) {
      if (typeof id !== "string" || !id) throw new Error("Invalid media attachment");
    }
    if (ids.length === 0) return;
    await serial(accountId, () => transact<void>([BYTES, BUDGET], "readwrite", (tx, resolve, guard) => {
      const store = tx.objectStore(BYTES);
      const budgetStore = tx.objectStore(BUDGET);
      const total = budgetStore.get(accountId);
      let released = 0;
      let outstanding = ids.length;
      const settle = () => {
        if (outstanding !== 0) return;
        const priorTotal = (total.result as BudgetRow | undefined)?.totalBytes ?? 0;
        budgetStore.put({ accountId, totalBytes: Math.max(0, priorTotal - released) } satisfies BudgetRow);
        resolve(undefined);
      };
      total.onsuccess = guard(settle);
      for (const id of ids) {
        const request = store.get([accountId, id]);
        request.onsuccess = guard(() => {
          const row = request.result as ByteRow | undefined;
          if (row) {
            released += row.byteSize;
            store.delete([accountId, id]);
          }
          outstanding -= 1;
          settle();
        });
      }
    }));
  }

  async function keys(accountId: string): Promise<string[]> {
    if (typeof accountId !== "string" || !accountId) throw new Error("Invalid media account");
    return transact<string[]>([BYTES], "readonly", (tx, resolve) => {
      const request = tx.objectStore(BYTES).index("account").getAll(accountId);
      request.onsuccess = () => resolve((request.result as ByteRow[]).map((row) => row.attachmentId));
    });
  }

  async function totalBytes(accountId: string): Promise<number> {
    if (typeof accountId !== "string" || !accountId) throw new Error("Invalid media account");
    return transact<number>([BUDGET], "readonly", (tx, resolve) => {
      const request = tx.objectStore(BUDGET).get(accountId);
      request.onsuccess = () => resolve((request.result as BudgetRow | undefined)?.totalBytes ?? 0);
    });
  }

  async function sweep(accountId: string, keep: ReadonlySet<string>, limit: number): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid media sweep limit");
    // Captured before the transaction opens so the whole pass uses one boundary.
    const boundary = now() - MEDIA_SWEEP_GRACE_MS;
    return serial(accountId, () => transact<number>([BYTES, BUDGET], "readwrite", (tx, resolve, guard) => {
      const store = tx.objectStore(BYTES);
      const budgetStore = tx.objectStore(BUDGET);
      // IndexedDB fires request events in the order the requests were made, so
      // the budget read has completed by the time the cursor's first event runs.
      const total = budgetStore.get(accountId);
      const orphans: ByteRow[] = [];
      const cursor = store.index("account").openCursor(accountId);
      cursor.onsuccess = guard(() => {
        const current = cursor.result;
        if (!current || orphans.length >= limit) {
          const priorTotal = (total.result as BudgetRow | undefined)?.totalBytes ?? 0;
          const released = orphans.reduce((sum, row) => sum + row.byteSize, 0);
          for (const row of orphans) store.delete([accountId, row.attachmentId]);
          budgetStore.put({ accountId, totalBytes: Math.max(0, priorTotal - released) } satisfies BudgetRow);
          resolve(orphans.length);
          return;
        }
        const row = current.value as ByteRow;
        // Fresh bytes with no attachment row are a send in flight, not an
        // orphan: the adapter writes the row immediately after `put` resolves.
        // A non-finite `storedAt` (only reachable from a corrupt record, since
        // this store always writes `now()`) compares false and is therefore
        // never swept. That leaks at most one entry and never deletes live bytes.
        if (!keep.has(row.attachmentId) && row.storedAt <= boundary) orphans.push(row);
        current.continue();
      });
    }));
  }

  async function clearAccount(accountId: string): Promise<void> {
    if (typeof accountId !== "string" || !accountId) throw new Error("Invalid media account");
    await serial(accountId, () => transact<void>([BYTES, BUDGET], "readwrite", (tx, resolve, guard) => {
      const store = tx.objectStore(BYTES);
      const cursor = store.index("account").openCursor(accountId);
      cursor.onsuccess = guard(() => {
        const current = cursor.result;
        if (!current) {
          tx.objectStore(BUDGET).delete(accountId);
          resolve(undefined);
          return;
        }
        current.delete();
        current.continue();
      });
    }));
  }

  async function clearAll(): Promise<void> {
    // Account deletion. Admission is decided here, at call time: once the purge
    // has been asked for it must finish, even if `close()` arrives while it is
    // waiting behind the queue. Re-checking `closed` after the await would abort
    // the purge and leave media behind — the one outcome this method exists to
    // prevent.
    assertOpen();
    const pending = [...queues.values()];
    globalBarrier = globalBarrier.catch(() => undefined).then(async () => {
      await Promise.allSettled(pending);
      await transact<void>([BYTES, BUDGET], "readwrite", (tx, resolve) => {
        tx.objectStore(BYTES).clear();
        tx.objectStore(BUDGET).clear();
        resolve(undefined);
      }, false);
    });
    await globalBarrier;
  }

  function close(): Promise<void> {
    if (closed) return Promise.resolve();
    closed = true;
    // Await the queue *and* the global barrier, so a `clearAll` already admitted
    // is durable before the handle goes away.
    return Promise.allSettled([...queues.values()])
      .then(() => globalBarrier.catch(() => undefined))
      .then(() => { db.close(); });
  }

  return { put, get, has, delete: remove, keys, totalBytes, sweep, clearAccount, clearAll, close };
}
