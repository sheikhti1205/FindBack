/** Account-scoped, atomic photo-byte snapshots. No image bytes enter localStorage. */
interface SavedFile { id: string; name: string; type: string; bytes: ArrayBuffer }
const DATABASE = "findback-report-photo-bytes";
const STORE = "accounts";
let connection: Promise<IDBDatabase> | null = null;
const queue = new Map<string, Promise<void>>();
let globalClear: Promise<void> = Promise.resolve();

function database(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("Persistent photo storage is unavailable"));
  connection ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Photo storage could not open"));
  }).catch((err: unknown) => {
    connection = null;
    throw err;
  });
  return connection;
}

function enqueue(account: string, action: () => Promise<void>): Promise<void> {
  const barrier = globalClear;
  const result = (queue.get(account) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    await barrier;
    await action();
  });
  queue.set(account, result);
  void result.finally(() => { if (queue.get(account) === result) queue.delete(account); }).catch(() => undefined);
  return result;
}

function buffer(file: File): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === "function") return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

async function transact<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore, resolve: (value: T) => void) => void): Promise<T> {
  const db = await database();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    let value: T;
    tx.oncomplete = () => resolve(value);
    tx.onabort = () => reject(tx.error ?? new Error("Photo storage transaction aborted"));
    tx.onerror = () => reject(tx.error ?? new Error("Photo storage transaction failed"));
    action(tx.objectStore(STORE), (result) => { value = result; });
  });
}

export function writePhotoBytes(account: string, entries: { id: string; file: File }[]): Promise<void> {
  return enqueue(account, async () => {
    const snapshot: SavedFile[] = await Promise.all(entries.map(async ({ id, file }) => ({ id, name: file.name, type: file.type, bytes: await buffer(file) })));
    await transact<void>("readwrite", (store) => { store.put(snapshot, account); });
  });
}

export async function readPhotoBytes(account: string, id: string): Promise<File | null> {
  await globalClear;
  await queue.get(account)?.catch(() => undefined);
  const entries = await transact<SavedFile[] | undefined>("readonly", (store, done) => {
    const request = store.get(account);
    request.onsuccess = () => done(request.result as SavedFile[] | undefined);
  });
  const entry = entries?.find((candidate) => candidate.id === id);
  return entry ? new File([entry.bytes], entry.name, { type: entry.type }) : null;
}

export function clearPhotoBytes(account: string): Promise<void> {
  return enqueue(account, () => transact<void>("readwrite", (store) => { store.delete(account); }));
}

/** Sign-out cannot rely on localStorage's account index (it may have been blocked). */
export function clearAllPhotoBytes(): Promise<void> {
  const pending = [...queue.values()];
  globalClear = globalClear.catch(() => undefined).then(async () => {
    await Promise.allSettled(pending);
    await transact<void>("readwrite", (store) => { store.clear(); });
  });
  return globalClear;
}
