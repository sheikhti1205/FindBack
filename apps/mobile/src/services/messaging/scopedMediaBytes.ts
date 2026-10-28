import { openMediaBytes, type MediaBytesOptions, type MediaBytesStore } from "./mediaBytes";
import { isUuid } from "./validation";
import { withHistoryLock } from "./historyLock";

export interface MediaStorageOwner {
  platform: "web" | "android";
  accountId: string;
  deviceId: string;
  backendUrl: string;
}
export type ScopedMediaBytes = MediaBytesStore;
export type ScopedMediaBytesOptions = Omit<MediaBytesOptions, "databaseName">;
/** A pre-media/text-only scope has no recoverable backend provenance. */
export type MessagingStorageScope = Omit<MediaStorageOwner, "backendUrl"> & { backendUrl?: string };

const REGISTRY = "findback-chat-media-owners-v1";
const OWNERS = "owners";
const DELETIONS = "deletions";
const ownership = new WeakMap<object, { identity: string; closed: boolean }>();

/** No credentials or request-specific URL components enter persistent identity. */
function copyOwner(value: MediaStorageOwner): Readonly<MediaStorageOwner> {
  if (!value || (value.platform !== "web" && value.platform !== "android")
    || !isUuid(value.accountId) || !isUuid(value.deviceId)) {
    throw new Error("Invalid media storage scope");
  }
  const backend = value.backendUrl;
  if (typeof backend !== "string" || !backend || backend.trim() !== backend
    || /[\s\\?#]/.test(backend) || !/^https?:\/\//i.test(backend)) {
    throw new Error("Invalid media backend");
  }
  let url: URL;
  try { url = new URL(backend); } catch { throw new Error("Invalid media backend"); }
  if (!url.hostname || url.username || url.password) throw new Error("Invalid media backend");
  return Object.freeze({ platform: value.platform, accountId: value.accountId,
    deviceId: value.deviceId, backendUrl: url.href.replace(/\/+$/, "") });
}

function copyScope(value: MessagingStorageScope): Readonly<MessagingStorageScope> {
  if (value?.backendUrl !== undefined) return copyOwner(value as MediaStorageOwner);
  if (!value || (value.platform !== "web" && value.platform !== "android")
    || !isUuid(value.accountId) || !isUuid(value.deviceId)) throw new Error("Invalid messaging storage scope");
  return Object.freeze({ platform: value.platform, accountId: value.accountId, deviceId: value.deviceId });
}

function identity(owner: Readonly<MessagingStorageScope>): string {
  return JSON.stringify([owner.platform, owner.accountId, owner.deviceId, owner.backendUrl ?? null]);
}

/** Match the actual metadata database, not merely the desired byte namespace. */
function metadataKey(owner: Readonly<MessagingStorageScope>): string {
  return JSON.stringify(owner.platform === "android"
    ? [owner.platform, owner.accountId] : [owner.platform, owner.accountId, owner.deviceId]);
}

function connectRegistry(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(REGISTRY, 3);
    let refused = false;
    request.onblocked = () => {
      refused = true;
      reject(new Error("Media ownership storage upgrade blocked"));
    };
    request.onerror = () => reject(new Error("Media ownership storage could not open"));
    request.onupgradeneeded = () => {
      // An IDB open cannot be cancelled. Do not leak a late connection or commit
      // an upgrade after the caller has already received a blocked failure.
      if (refused) { request.transaction!.abort(); return; }
      if (!request.result.objectStoreNames.contains(OWNERS)) request.result.createObjectStore(OWNERS, { keyPath: "metadataKey" });
      if (!request.result.objectStoreNames.contains(DELETIONS)) request.result.createObjectStore(DELETIONS, { keyPath: "accountId" });
    };
    request.onsuccess = () => {
      if (refused) { request.result.close(); return; }
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}

function storageFactory(factory?: IDBFactory): IDBFactory {
  const result = factory ?? globalThis.indexedDB;
  if (!result) throw new Error("Media ownership storage unavailable");
  return result;
}

type Guard = (work: () => void) => () => void;
async function registryTransaction<T>(factory: IDBFactory, mode: IDBTransactionMode,
  work: (tx: IDBTransaction, guard: Guard, result: (value: T) => void) => void): Promise<T> {
  const db = await connectRegistry(factory);
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction([OWNERS, DELETIONS], mode, { durability: "strict" });
      let failure: unknown;
      let value: T;
      const guard = (work: () => void) => () => {
        try { work(); } catch (error) {
          failure = error;
          try { tx.abort(); } catch { /* terminal; handlers own completion */ }
        }
      };
      tx.oncomplete = () => resolve(value);
      tx.onabort = () => reject(failure ?? new Error("Media ownership transaction aborted"));
      tx.onerror = () => { /* reported through abort */ };
      guard(() => {
        if (mode === "readwrite" && tx.durability !== "strict") throw new Error("Media ownership requires strict transaction durability");
        work(tx, guard, (next) => { value = next; });
      })();
    });
  } finally { db.close(); }
}

function readScope(record: unknown): Readonly<MessagingStorageScope> {
  if (!record || typeof record !== "object" || !("owner" in record)) throw new Error("Media storage ownership corrupt");
  const owner = copyScope(record.owner as MessagingStorageScope);
  if (!("metadataKey" in record) || record.metadataKey !== metadataKey(owner)
    || !("identity" in record) || record.identity !== identity(owner)) throw new Error("Media storage ownership corrupt");
  return owner;
}

interface DeletionRecord {
  accountId: string;
  pending: boolean;
  revision: number;
  authPending: boolean;
  authRevision: number;
}

function readDeletion(record: unknown): DeletionRecord | undefined {
  if (record === undefined) return undefined;
  if (!record || typeof record !== "object" || !("accountId" in record) || !isUuid(record.accountId)
    || !("pending" in record) || typeof record.pending !== "boolean"
    || !("revision" in record) || typeof record.revision !== "number"
    || !Number.isSafeInteger(record.revision) || record.revision < 1) throw new Error("Messaging deletion record corrupt");
  // v2 rows tracked messaging only. Both absent is the legacy shape; a partial
  // or malformed new pair is corruption, never an implicit acknowledgment.
  const legacy = !("authPending" in record) && !("authRevision" in record);
  if (!legacy && (!("authPending" in record) || typeof record.authPending !== "boolean"
    || !("authRevision" in record) || typeof record.authRevision !== "number"
    || !Number.isSafeInteger(record.authRevision) || record.authRevision < 1)) {
    throw new Error("Account auth cleanup record corrupt");
  }
  return { accountId: record.accountId, pending: record.pending, revision: record.revision,
    authPending: legacy ? false : (record as { authPending: boolean }).authPending,
    authRevision: legacy ? 0 : (record as { authRevision: number }).authRevision };
}

export async function assertMessagingAccountActive(accountId: string, factory?: IDBFactory): Promise<void> {
  if (!isUuid(accountId)) throw new Error("Invalid messaging account");
  await registryTransaction<void>(storageFactory(factory), "readonly", (tx, guard) => {
    const request = tx.objectStore(DELETIONS).get(accountId);
    request.onsuccess = guard(() => {
      if (readDeletion(request.result)) throw new Error("Messaging account deleted");
    });
  });
}

/** Binding and deletion admission share one strict registry transaction. */
export async function registerMessagingStorageScope(value: MessagingStorageScope, factory?: IDBFactory): Promise<void> {
  const owner = copyScope(value);
  await registryTransaction<void>(storageFactory(factory), "readwrite", (tx, guard) => {
    const deleted = tx.objectStore(DELETIONS).get(owner.accountId);
    deleted.onsuccess = guard(() => {
      if (readDeletion(deleted.result)) throw new Error("Messaging account deleted");
      const store = tx.objectStore(OWNERS), key = metadataKey(owner), found = store.get(key);
      found.onsuccess = guard(() => {
        if (found.result === undefined) store.add({ metadataKey: key, identity: identity(owner), owner });
        else {
          const prior = readScope(found.result);
          if (prior.deviceId !== owner.deviceId || (prior.backendUrl && owner.backendUrl && prior.backendUrl !== owner.backendUrl)) {
            throw new Error("Media storage ownership conflict");
          }
          // Text-only access never erases an existing backend binding. First
          // media use can bind a registered legacy scope, not invent provenance.
          if (!prior.backendUrl && owner.backendUrl) store.put({ metadataKey: key, identity: identity(owner), owner });
        }
      });
    });
  });
}

async function withByteLock<T>(accountId: string, work: () => Promise<T>): Promise<T> {
  const locks = globalThis.navigator?.locks;
  if (!locks) throw new Error("Messaging media requires Web Locks");
  return await locks.request(`findback-messaging-bytes:${accountId}`, { mode: "exclusive" }, work);
}

/** Order is history lock -> byte lock -> registry. Byte ports never take the
 * history lock, including when called from an already-locked adapter. */
export async function beginMessagingAccountDeletion(accountId: string, factory?: IDBFactory): Promise<number> {
  return beginDeletion(accountId, false, factory);
}

/** Canonical auth owner only, AFTER the server confirms captured-account
 * deletion. Both local responsibilities are admitted by the same strict commit. */
export async function beginConfirmedAccountDeletion(accountId: string, factory?: IDBFactory): Promise<number> {
  return beginDeletion(accountId, true, factory);
}

async function beginDeletion(accountId: string, includeAuth: boolean, factory?: IDBFactory): Promise<number> {
  if (!isUuid(accountId)) throw new Error("Invalid messaging account");
  const dbFactory = storageFactory(factory);
  return withHistoryLock(accountId, new AbortController().signal, true, () => withByteLock(accountId, () =>
    registryTransaction<number>(dbFactory, "readwrite", (tx, guard, result) => {
      const store = tx.objectStore(DELETIONS), found = store.get(accountId);
      found.onsuccess = guard(() => {
        const prior = readDeletion(found.result);
        const revision = (prior?.revision ?? 0) + 1;
        if (!Number.isSafeInteger(revision)) throw new Error("Messaging deletion revision exhausted");
        // Rechecking a completed account is itself pending until the full scope
        // inventory/purge succeeds again. Failure cannot masquerade as complete.
        const authRevision = (prior?.authRevision ?? 0) + (includeAuth ? 1 : 0);
        if (!Number.isSafeInteger(authRevision)) throw new Error("Account auth cleanup revision exhausted");
        // Do not materialize the legacy zero-revision pair. A non-legacy auth
        // record always has a positive revision, even after acknowledgment.
        store.put({ accountId, pending: true, revision,
          ...(authRevision > 0 ? { authRevision, authPending: includeAuth || prior!.authPending } : {}) });
        result(includeAuth ? authRevision : revision);
      });
    })));
}

export interface PendingAccountDeletion {
  accountId: string;
  messagingPending: boolean;
  authPending: boolean;
  authRevision: number;
}

/** Return valid pending work AND incomplete-inventory errors, so corruption in
 * one row cannot starve another account's admitted cleanup. No payload/keys. */
export async function inspectPendingAccountDeletions(factory?: IDBFactory): Promise<{
  pending: PendingAccountDeletion[]; failures: unknown[];
}> {
  return registryTransaction(storageFactory(factory), "readonly", (tx, guard, result) => {
    const request = tx.objectStore(DELETIONS).getAll();
    request.onsuccess = guard(() => {
      const pending: PendingAccountDeletion[] = [], failures: unknown[] = [];
      for (const record of request.result) {
        try {
          const row = readDeletion(record)!;
          if (row.pending || row.authPending) pending.push({ accountId: row.accountId,
            messagingPending: row.pending, authPending: row.authPending, authRevision: row.authRevision });
        } catch (error) { failures.push(error); }
      }
      pending.sort((a, b) => a.accountId.localeCompare(b.accountId));
      result({ pending, failures });
    });
  });
}

/** Only acknowledges the captured auth/key attempt; never clears media pending
 * or the permanent account fence. A newer attempt cannot be lost to an old one. */
export async function finishAccountAuthCleanup(accountId: string, revision: number, factory?: IDBFactory): Promise<void> {
  if (!isUuid(accountId)) throw new Error("Invalid messaging account");
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("Invalid account auth cleanup revision");
  await registryTransaction<void>(storageFactory(factory), "readwrite", (tx, guard) => {
    const store = tx.objectStore(DELETIONS), request = store.get(accountId);
    request.onsuccess = guard(() => {
      const deletion = readDeletion(request.result);
      if (!deletion || deletion.authRevision !== revision) throw new Error("Account auth cleanup superseded; retry required");
      store.put({ ...deletion, authPending: false });
    });
  });
}

/** Trusted platform discovery of a pre-registry text database. It may only add
 * a scope AFTER fencing; never supplies/overwrites historical backend identity. */
export async function registerMessagingCleanupScope(value: Omit<MediaStorageOwner, "backendUrl">, factory?: IDBFactory): Promise<void> {
  const owner = copyScope({ platform: value.platform, accountId: value.accountId, deviceId: value.deviceId });
  await registryTransaction<void>(storageFactory(factory), "readwrite", (tx, guard) => {
    const deleted = tx.objectStore(DELETIONS).get(owner.accountId);
    deleted.onsuccess = guard(() => {
      const deletion = readDeletion(deleted.result);
      if (!deletion) throw new Error("Messaging deletion not admitted");
      const store = tx.objectStore(OWNERS), key = metadataKey(owner), found = store.get(key);
      found.onsuccess = guard(() => {
        if (found.result !== undefined) {
          if (readScope(found.result).deviceId !== owner.deviceId) throw new Error("Media storage ownership conflict");
          return;
        }
        store.add({ metadataKey: key, identity: identity(owner), owner });
        tx.objectStore(DELETIONS).put(deletion.authRevision > 0 ? { ...deletion, pending: true }
          : { accountId: deletion.accountId, pending: true, revision: deletion.revision });
      });
    });
  });
}

export async function listPendingMessagingDeletions(factory?: IDBFactory): Promise<string[]> {
  return registryTransaction(storageFactory(factory), "readonly", (tx, guard, result) => {
    const request = tx.objectStore(DELETIONS).getAll();
    request.onsuccess = guard(() => result(request.result.map((row) => readDeletion(row)!)
      .filter((row) => row.pending).map((row) => row.accountId).sort()));
  });
}

export async function listMessagingStorageScopes(accountId: string, factory?: IDBFactory): Promise<Readonly<MessagingStorageScope>[]> {
  const inventory = await inspectMessagingStorageScopes(accountId, factory);
  if (inventory.failures.length) throw new AggregateError(inventory.failures, "Messaging storage inventory corrupt");
  return inventory.scopes;
}

/** Cleanup needs both valid scopes and a hard incomplete-inventory signal. A
 * corrupt record must not starve the deletion of unrelated, validated scopes. */
export async function inspectMessagingStorageScopes(accountId: string, factory?: IDBFactory): Promise<{
  scopes: Readonly<MessagingStorageScope>[]; failures: unknown[];
}> {
  if (!isUuid(accountId)) throw new Error("Invalid messaging account");
  return registryTransaction(storageFactory(factory), "readonly", (tx, guard, result) => {
    const request = tx.objectStore(OWNERS).getAll();
    request.onsuccess = guard(() => {
      const scopes: Readonly<MessagingStorageScope>[] = [], failures: unknown[] = [];
      for (const record of request.result) {
        try {
          const scope = readScope(record);
          if (scope.accountId === accountId) scopes.push(scope);
        } catch (error) { failures.push(error); }
      }
      result({ scopes, failures });
    });
  });
}

/** Trusted cleanup owner only: call after every registered scope purged/closed.
 * The permanent fence remains even when the pending work is acknowledged. */
export async function finishMessagingAccountDeletion(accountId: string, revision: number, factory?: IDBFactory): Promise<void> {
  if (!isUuid(accountId)) throw new Error("Invalid messaging account");
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("Invalid messaging deletion revision");
  await registryTransaction<void>(storageFactory(factory), "readwrite", (tx, guard) => {
    const store = tx.objectStore(DELETIONS), request = store.get(accountId);
    request.onsuccess = guard(() => {
      const deletion = readDeletion(request.result);
      if (!deletion) throw new Error("Messaging deletion not admitted");
      if (deletion.revision !== revision) throw new Error("Messaging deletion superseded; retry required");
      store.put(deletion.authRevision > 0 ? { ...deletion, pending: false }
        : { accountId: deletion.accountId, pending: false, revision: deletion.revision });
    });
  });
}

/**
 * Production composition: bind metadata before any byte/history cleanup. The
 * registry is a compare-or-insert transaction across independent tabs, and its
 * binding survives close/restart. It does not invent legacy text provenance.
 */
export async function openScopedMediaBytes(value: MediaStorageOwner, options: ScopedMediaBytesOptions = {}): Promise<ScopedMediaBytes> {
  const owner = copyOwner(value);
  const factory = options.indexedDB ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!factory) throw new Error("Media ownership storage unavailable");
  await registerMessagingStorageScope(owner, factory);
  const raw = await openMediaBytes({ indexedDB: factory, now: options.now, budgetBytes: options.budgetBytes,
    databaseName: `findback-chat-media-bytes-v1:${identity(owner)}` });
  const state = { identity: identity(owner), closed: false };
  function admit(accountId = owner.accountId) {
    if (state.closed) throw new Error("Media byte storage closed");
    if (accountId !== owner.accountId) throw new Error("Media byte storage scope mismatch");
  }
  let closing: Promise<void> | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  function run<T>(accountId: string, work: () => Promise<T>): Promise<T> {
    admit(accountId);
    const next = tail.then(() => withByteLock(owner.accountId, async () => {
      // Accepted work drains before close; a durable deletion fence still rejects
      // it before entering the raw transaction, even in another tab.
      await assertMessagingAccountActive(owner.accountId, factory);
      return work();
    }));
    tail = next.catch(() => undefined);
    return next;
  }
  const port: ScopedMediaBytes = Object.freeze({
    async put(accountId: string, attachmentId: string, bytes: ArrayBuffer) {
      const captured = bytes.slice(0);
      return run(accountId, () => raw.put(accountId, attachmentId, captured));
    },
    async get(accountId: string, attachmentId: string) { return run(accountId, () => raw.get(accountId, attachmentId)); },
    async has(accountId: string, attachmentId: string) { return run(accountId, () => raw.has(accountId, attachmentId)); },
    async delete(accountId: string, ids: readonly string[]) { const captured = [...ids]; return run(accountId, () => raw.delete(accountId, captured)); },
    async keys(accountId: string) { return run(accountId, () => raw.keys(accountId)); },
    async totalBytes(accountId: string) { return run(accountId, () => raw.totalBytes(accountId)); },
    async sweep(accountId: string, keep: ReadonlySet<string>, limit: number) {
      const captured = new Set(keep); return run(accountId, () => raw.sweep(accountId, captured, limit));
    },
    async clearAccount(accountId: string) { return run(accountId, () => raw.clearAccount(accountId)); },
    // This database holds exactly one owner. The raw whole-store barrier drains
    // an admitted purge even if close is called before its transaction starts.
    async clearAll() { return run(owner.accountId, () => raw.clearAll()); },
    close() {
      if (!closing) {
        state.closed = true;
        closing = tail.then(() => raw.close());
      }
      return closing;
    },
  });
  ownership.set(port, state);
  return port;
}

/** Destructive capability only; not a normal byte port or a way to rebind an
 * owner. Used solely by cleanup adapters after a durable account fence. */
export async function openMessagingCleanupBytes(value: MessagingStorageScope, factory?: IDBFactory): Promise<ScopedMediaBytes> {
  const owner = copyScope(value), dbFactory = storageFactory(factory);
  await registryTransaction<void>(dbFactory, "readonly", (tx, guard) => {
    const deleted = tx.objectStore(DELETIONS).get(owner.accountId);
    deleted.onsuccess = guard(() => {
      if (!readDeletion(deleted.result)) throw new Error("Messaging deletion not admitted");
    });
    const record = tx.objectStore(OWNERS).get(metadataKey(owner));
    record.onsuccess = guard(() => {
      if (identity(readScope(record.result)) !== identity(owner)) throw new Error("Media storage ownership conflict");
    });
  });
  const raw = await openMediaBytes({ indexedDB: dbFactory,
    databaseName: `findback-chat-media-bytes-v1:${identity(owner)}` });
  const refuse = async (): Promise<never> => { throw new Error("Messaging deletion cleanup only"); };
  const check = (accountId: string) => { if (accountId !== owner.accountId) throw new Error("Media byte storage scope mismatch"); };
  return Object.freeze({ put: refuse, get: refuse, has: refuse, delete: refuse, totalBytes: refuse,
    sweep: refuse, clearAll: refuse,
    async keys(accountId: string) { check(accountId); return withByteLock(accountId, () => raw.keys(accountId)); },
    async clearAccount(accountId: string) { check(accountId); return withByteLock(accountId, () => raw.clearAccount(accountId)); },
    close: () => raw.close() });
}

/** A cast, spread or copied brand cannot confer a live production ownership. */
export function assertMediaBytesOwner(port: unknown, value: MediaStorageOwner): void {
  const owner = copyOwner(value);
  const state = port && typeof port === "object" ? ownership.get(port) : undefined;
  if (!state || state.identity !== identity(owner)) throw new Error("Media byte storage ownership mismatch");
  if (state.closed) throw new Error("Media byte storage closed");
}
