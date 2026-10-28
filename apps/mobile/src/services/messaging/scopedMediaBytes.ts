import { openMediaBytes, type MediaBytesOptions, type MediaBytesStore } from "./mediaBytes";
import { isUuid } from "./validation";

export interface MediaStorageOwner {
  platform: "web" | "android";
  accountId: string;
  deviceId: string;
  backendUrl: string;
}
export type ScopedMediaBytes = MediaBytesStore;
export type ScopedMediaBytesOptions = Omit<MediaBytesOptions, "databaseName">;

const REGISTRY = "findback-chat-media-owners-v1";
const OWNERS = "owners";
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

function identity(owner: Readonly<MediaStorageOwner>): string {
  return JSON.stringify([owner.platform, owner.accountId, owner.deviceId, owner.backendUrl]);
}

/** Match the actual metadata database, not merely the desired byte namespace. */
function metadataKey(owner: Readonly<MediaStorageOwner>): string {
  return JSON.stringify(owner.platform === "android"
    ? [owner.platform, owner.accountId] : [owner.platform, owner.accountId, owner.deviceId]);
}

function connectRegistry(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(REGISTRY, 1);
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
      request.result.createObjectStore(OWNERS, { keyPath: "metadataKey" });
    };
    request.onsuccess = () => {
      if (refused) { request.result.close(); return; }
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}

async function bindOwner(factory: IDBFactory, owner: Readonly<MediaStorageOwner>): Promise<void> {
  const db = await connectRegistry(factory);
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(OWNERS, "readwrite", { durability: "strict" });
      let failure: unknown;
      const guard = (work: () => void) => () => {
        try { work(); } catch (error) {
          failure = error;
          try { tx.abort(); } catch { /* terminal; handlers own completion */ }
        }
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(failure ?? new Error("Media ownership transaction aborted"));
      tx.onerror = () => { /* reported through abort */ };
      guard(() => {
        if (tx.durability !== "strict") throw new Error("Media ownership requires strict transaction durability");
        const store = tx.objectStore(OWNERS);
        const key = metadataKey(owner);
        const found = store.get(key);
        found.onsuccess = guard(() => {
          if (found.result !== undefined) {
            // Corrupt/unknown records refuse too; never overwrite provenance.
            if (found.result.identity !== identity(owner)) throw new Error("Media storage ownership conflict");
          } else {
            store.add({ metadataKey: key, identity: identity(owner), owner });
          }
        });
      })();
    });
  } finally { db.close(); }
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
  await bindOwner(factory, owner);
  const raw = await openMediaBytes({ indexedDB: factory, now: options.now, budgetBytes: options.budgetBytes,
    databaseName: `findback-chat-media-bytes-v1:${identity(owner)}` });
  const state = { identity: identity(owner), closed: false };
  function admit(accountId = owner.accountId) {
    if (state.closed) throw new Error("Media byte storage closed");
    if (accountId !== owner.accountId) throw new Error("Media byte storage scope mismatch");
  }
  let closing: Promise<void> | undefined;
  const port: ScopedMediaBytes = Object.freeze({
    async put(accountId: string, attachmentId: string, bytes: ArrayBuffer) {
      admit(accountId); return raw.put(accountId, attachmentId, bytes);
    },
    async get(accountId: string, attachmentId: string) { admit(accountId); return raw.get(accountId, attachmentId); },
    async has(accountId: string, attachmentId: string) { admit(accountId); return raw.has(accountId, attachmentId); },
    async delete(accountId: string, ids: readonly string[]) { admit(accountId); return raw.delete(accountId, ids); },
    async keys(accountId: string) { admit(accountId); return raw.keys(accountId); },
    async totalBytes(accountId: string) { admit(accountId); return raw.totalBytes(accountId); },
    async sweep(accountId: string, keep: ReadonlySet<string>, limit: number) {
      admit(accountId); return raw.sweep(accountId, keep, limit);
    },
    async clearAccount(accountId: string) { admit(accountId); return raw.clearAccount(accountId); },
    // This database holds exactly one owner. The raw whole-store barrier drains
    // an admitted purge even if close is called before its transaction starts.
    async clearAll() { admit(); return raw.clearAll(); },
    close() {
      if (!closing) {
        state.closed = true;
        closing = raw.close();
      }
      return closing;
    },
  });
  ownership.set(port, state);
  return port;
}

/** A cast, spread or copied brand cannot confer a live production ownership. */
export function assertMediaBytesOwner(port: unknown, value: MediaStorageOwner): void {
  const owner = copyOwner(value);
  const state = port && typeof port === "object" ? ownership.get(port) : undefined;
  if (!state || state.identity !== identity(owner)) throw new Error("Media byte storage ownership mismatch");
  if (state.closed) throw new Error("Media byte storage closed");
}
