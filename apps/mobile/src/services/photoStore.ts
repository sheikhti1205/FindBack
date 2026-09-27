import type { PickedPhoto } from "./photo";
import { storage } from "./storage";
import { clearAllPhotoBytes, clearPhotoBytes, readPhotoBytes, writePhotoBytes } from "./photoBytes";

/**
 * Photo File store: in-memory Files for the live session + a durable
 * per-account descriptor registry (services/storage boundary, mockable).
 *
 * A `File` from the web file input only has a `blob:` URL, which dies with the
 * component. The report composer survives navigation to Offline AI / Help, so
 * the File must outlive the screen while staying out of the serialized draft
 * (Files are not JSON). Drafts keep ordered photo ids; the Files live here.
 *
 * Durability across process death (G15): IndexedDB holds full-size Files;
 * small Files fall back to data URLs where IndexedDB is unavailable. Native
 * URI references can also be revived via photoToFile on a later session.
 *
 * Persist is warning-only: when bytes cannot be stored durably (no IndexedDB
 * and a File too large for the data-URL fallback, with no native ref), the
 * registry is still written metadata-only and the call resolves with
 * `{ durable: false, warning }` instead of throwing — so restore can prune
 * those orphans and the UI can warn without losing the live session Files.
 * Only real storage failures (IndexedDB write or descriptor write) reject.
 */

export interface StashedPhotoMeta {
  picked: PickedPhoto | null;
  accountId?: string | null;
}

export interface StoredPhotoDescriptor {
  id: string;
  name: string;
  type: string;
  size: number;
  nativeUri?: string | null;
  webPath?: string | null;
  format?: string | null;
  /** Byte payload for small files only (metadata-only when absent). */
  dataUrl?: string;
  savedAt: number;
}

const PHOTOS_KEY_PREFIX = "findback:reportPhotos:v1:";
const PHOTOS_ACCOUNT_INDEX_KEY = "findback:reportPhotoAccounts:v1";
const DEFAULT_ACCOUNT = "default";

/** Data-URL fallback limit when IndexedDB is unavailable. */
export const MAX_DURABLE_PHOTO_BYTES = 1_500_000;

const files = new Map<string, File>();
const metas = new Map<string, StashedPhotoMeta>();
let seq = 0;
/** Latest-writer-wins token so overlapping persists cannot resurrect removals. */
const persistSeq = new Map<string, number>();

function invalidatePersist(accountId?: string | null): number {
  const key = photosKey(accountId);
  const next = (persistSeq.get(key) ?? 0) + 1;
  persistSeq.set(key, next);
  return next;
}

function photosKey(accountId?: string | null): string {
  return `${PHOTOS_KEY_PREFIX}${accountId ?? DEFAULT_ACCOUNT}`;
}

function readAccountIndex(): string[] {
  try {
    const raw = storage.getItem(PHOTOS_ACCOUNT_INDEX_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function trackAccount(accountId?: string | null): void {
  try {
    const key = accountId ?? DEFAULT_ACCOUNT;
    const index = readAccountIndex();
    if (!index.includes(key)) {
      storage.setItem(PHOTOS_ACCOUNT_INDEX_KEY, JSON.stringify([...index, key]));
    }
  } catch {
    /* best-effort */
  }
}

function readRegistry(accountId?: string | null): StoredPhotoDescriptor[] {
  const raw = storage.getItem(photosKey(accountId));
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (v): v is StoredPhotoDescriptor => !!v && typeof (v as StoredPhotoDescriptor).id === "string",
    );
  } catch {
    return [];
  }
}

function writeRegistry(accountId: string | null | undefined, entries: StoredPhotoDescriptor[]): void {
  const key = photosKey(accountId);
  try {
    storage.setItem(key, JSON.stringify(entries));
    trackAccount(accountId);
  } catch {
    // Quota or blocked storage: retry metadata-only (bytes dropped, native
    // refs kept), so ordering/refs still survive even when bytes cannot.
    try {
      const slim = entries.map(({ dataUrl: _dropped, ...rest }) => rest);
      storage.setItem(key, JSON.stringify(slim));
      trackAccount(accountId);
    } catch {
      throw new Error("Photo draft metadata could not be saved");
    }
  }
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === "string") resolve(reader.result);
        else reject(new Error("unreadable file"));
      };
      reader.onerror = () => reject(reader.error ?? new Error("unreadable file"));
      reader.readAsDataURL(file);
    } catch (err) {
      reject(err instanceof Error ? err : new Error("unreadable file"));
    }
  });
}

function dataUrlToFile(dataUrl: string, name: string, type: string): File {
  const comma = dataUrl.indexOf(",");
  if (!dataUrl.startsWith("data:") || comma < 0) throw new Error("bad data URL");
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], name, { type: type || "application/octet-stream" });
}

function pickedFor(id: string, entry?: StoredPhotoDescriptor): PickedPhoto | null {
  const meta = metas.get(id)?.picked;
  if (meta) return meta;
  const nativeUri = entry?.nativeUri ?? null;
  if (nativeUri && !nativeUri.startsWith("blob:")) {
    return {
      nativeUri,
      webPath: entry?.webPath && !entry.webPath.startsWith("blob:") ? entry.webPath : nativeUri,
      format: entry?.format ?? "jpg",
      id: crypto.randomUUID(),
    };
  }
  return null;
}

export function stashPhotoFile(file: File, opts?: { picked?: PickedPhoto | null; accountId?: string | null }): string {
  const id = `photo-${Date.now()}-${seq++}`;
  files.set(id, file);
  metas.set(id, { picked: opts?.picked ?? null, accountId: opts?.accountId ?? null });
  return id;
}

/**
 * Store (or replace) a File under an EXISTING id — e.g. a natively-revived
 * conversion produced during draft recovery. New ids would break the draft's
 * photoIds/photoRefs references, so recovery must restash under the original
 * slot id to keep ordering, dedupe and persistence coherent.
 */
export function restashPhotoFile(id: string, file: File, opts?: { picked?: PickedPhoto | null; accountId?: string | null }): void {
  files.set(id, file);
  const prev = metas.get(id);
  metas.set(id, {
    picked: opts?.picked ?? prev?.picked ?? null,
    accountId: opts?.accountId ?? prev?.accountId ?? null,
  });
  invalidatePersist(opts?.accountId);
}

export function getStashedPhoto(id: string | null | undefined): File | null {
  if (!id) return null;
  return files.get(id) ?? null;
}

export function getStashedPhotoMeta(id: string | null | undefined): StashedPhotoMeta | null {
  if (!id) return null;
  return metas.get(id) ?? null;
}

export function dropStashedPhoto(id: string | null | undefined, accountId?: string | null): void {
  if (!id) return;
  if (accountId !== undefined && metas.get(id)?.accountId && metas.get(id)?.accountId !== accountId) return;
  invalidatePersist(accountId);
  files.delete(id);
  metas.delete(id);
  if (typeof indexedDB !== "undefined") {
    void writePhotoBytes(accountId ?? DEFAULT_ACCOUNT, Array.from(files)
      .filter(([key]) => { const owner = metas.get(key)?.accountId; return !owner || owner === accountId; })
      .map(([key, file]) => ({ id: key, file }))).catch(() => undefined);
  }
  // Prune the descriptor now so a crash before the next persist cannot
  // resurrect a removed photo; the persist effect rewrites the rest.
  try {
    writeRegistry(accountId, readRegistry(accountId).filter((e) => e.id !== id));
  } catch {
    /* best-effort */
  }
}

/**
 * Outcome of {@link persistStashedPhotos}. `durable` is false when at least
 * one stashed File could not be stored durably (no IndexedDB, too large for
 * the data-URL fallback, no native ref to revive it). The registry is still
 * written and the live Files are untouched — callers must surface `warning`
 * instead of treating the photos as safely stored.
 */
export interface StashedPhotosPersistReport {
  durable: boolean;
  warning: string | null;
}

/**
 * Persist every stashed File's descriptor (+ bytes for small files) to the
 * account registry. Registry mirrors memory authoritatively: ids no longer
 * stashed are dropped. Latest call wins (stale overlapping persists abort
 * before writing so a removal cannot be resurrected by a slow earlier call).
 *
 * Warning-only contract: non-durable entries resolve with `durable: false`
 * (restore prunes them as orphans); only IndexedDB/descriptor write failures
 * reject.
 */
export async function persistStashedPhotos(accountId?: string | null): Promise<StashedPhotosPersistReport> {
  const mySeq = invalidatePersist(accountId);
  const key = photosKey(accountId);
  const entries: StoredPhotoDescriptor[] = [];
  for (const [id, file] of files) {
    const meta = metas.get(id);
    if (meta?.accountId && meta.accountId !== accountId) continue;
    // An unowned legacy session file is claimed by its first persisting account.
    if (accountId && meta && !meta.accountId) meta.accountId = accountId;
    const picked = meta?.picked;
    const entry: StoredPhotoDescriptor = {
      id,
      name: file.name,
      type: file.type,
      size: file.size,
      nativeUri: picked?.nativeUri ?? null,
      webPath: picked?.webPath ?? null,
      format: picked?.format ?? null,
      savedAt: Date.now(),
    };
    if (typeof indexedDB === "undefined" && file.size <= MAX_DURABLE_PHOTO_BYTES) {
      try {
        entry.dataUrl = await fileToDataUrl(file);
      } catch {
        /* metadata-only */
      }
    }
    // Superseded by a newer persist/drop: report durable so this stale call
    // neither warns nor resurrects removals; the latest call reports the truth.
    if (mySeq !== persistSeq.get(key)) return { durable: true, warning: null };
    entries.push(entry);
  }
  if (mySeq !== persistSeq.get(key)) return { durable: true, warning: null };
  if (typeof indexedDB !== "undefined") {
    await writePhotoBytes(accountId ?? DEFAULT_ACCOUNT, entries.map((entry) => ({ id: entry.id, file: files.get(entry.id)! })));
    if (mySeq !== persistSeq.get(key)) return { durable: true, warning: null };
  }
  writeRegistry(accountId, entries);
  if (typeof indexedDB === "undefined" && entries.some((entry) => !entry.dataUrl && !entry.nativeUri)) {
    return {
      durable: false,
      warning: "Persistent photo storage is unavailable; keep this page open to retain the selected photos",
    };
  }
  return { durable: true, warning: null };
}

/**
 * Restore stashed Files after process death. Returns the ids that now hold
 * usable Files (rehydrated from bytes or never lost), in registry order.
 * Native-ref-only entries are kept as pending restores (see
 * pendingNativePhotoIds); entries with neither bytes nor a native ref are
 * orphans and are pruned.
 */
export async function restoreStashedPhotos(accountId?: string | null): Promise<string[]> {
  const mySeq = persistSeq.get(photosKey(accountId)) ?? 0;
  const registry = readRegistry(accountId);
  const kept: StoredPhotoDescriptor[] = [];
  const restored: string[] = [];
  for (const entry of registry) {
    if (files.has(entry.id) && (!metas.get(entry.id)?.accountId || metas.get(entry.id)?.accountId === accountId)) {
      kept.push(entry);
      restored.push(entry.id);
      continue;
    }
    if (typeof indexedDB !== "undefined") {
      const stored = await readPhotoBytes(accountId ?? DEFAULT_ACCOUNT, entry.id);
      if (mySeq !== (persistSeq.get(photosKey(accountId)) ?? 0)) return [];
      if (stored) {
        files.set(entry.id, stored);
        metas.set(entry.id, { picked: pickedFor(entry.id, entry), accountId });
        kept.push(entry);
        restored.push(entry.id);
        continue;
      }
    }
    if (entry.dataUrl) {
      try {
        const file = dataUrlToFile(entry.dataUrl, entry.name, entry.type);
        files.set(entry.id, file);
        if (!metas.has(entry.id)) metas.set(entry.id, { picked: pickedFor(entry.id, entry), accountId });
        kept.push(entry);
        restored.push(entry.id);
        continue;
      } catch {
        /* fall through: native ref or orphan */
      }
    }
    if (entry.nativeUri && !entry.nativeUri.startsWith("blob:")) {
      kept.push(entry);
      if (!metas.has(entry.id)) metas.set(entry.id, { picked: pickedFor(entry.id, entry), accountId });
      continue;
    }
    // Orphan: no bytes, no native ref — drop it.
  }
  if (mySeq !== (persistSeq.get(photosKey(accountId)) ?? 0)) return [];
  writeRegistry(accountId, kept);
  return restored;
}

/** Registry ids with a native ref but no usable File (photoToFile can revive). */
export function pendingNativePhotoIds(accountId?: string | null): string[] {
  return readRegistry(accountId)
    .filter((e) => !files.has(e.id) && !!e.nativeUri && !e.nativeUri.startsWith("blob:"))
    .map((e) => e.id);
}

/** Registry descriptor for an id (order/refs audit without the bytes). */
export function getPhotoDescriptor(
  id: string | null | undefined,
  accountId?: string | null,
): StoredPhotoDescriptor | null {
  if (!id) return null;
  return readRegistry(accountId).find((e) => e.id === id) ?? null;
}

/** Drop every stashed File (e.g. on sign-out): memory + all stored registries. */
export function clearPhotoStore(accountId?: string | null): void {
  invalidatePersist(accountId);
  if (accountId === undefined) {
    for (const [key, seq] of persistSeq) persistSeq.set(key, seq + 1);
    files.clear();
    metas.clear();
  } else {
    for (const [id, meta] of metas) {
      if (meta.accountId === accountId) {
        files.delete(id);
        metas.delete(id);
      }
    }
  }
  try {
    if (accountId === undefined) {
      for (const key of readAccountIndex()) {
        storage.removeItem(`${PHOTOS_KEY_PREFIX}${key}`);
      }
      storage.removeItem(PHOTOS_ACCOUNT_INDEX_KEY);
      storage.removeItem(photosKey(null));
    } else {
      storage.removeItem(photosKey(accountId));
    }
  } catch {
    /* best-effort */
  }
  if (typeof indexedDB !== "undefined") {
    if (accountId === undefined) void clearAllPhotoBytes().catch(() => undefined);
    else void clearPhotoBytes(accountId ?? DEFAULT_ACCOUNT).catch(() => undefined);
  }
}

/** Drop every stored photo registry (sign-out path; coordinator wires the call). */
export function clearAllStoredPhotos(): void {
  clearPhotoStore(undefined);
}
