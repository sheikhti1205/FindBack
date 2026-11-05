/**
 * S8 durable update preferences: popup opt-in and per-release dismissal.
 *
 * Two independent facts, deliberately not one "seen updates" blob:
 *
 * - `popupEnabled` is the reader's choice, OFF by default. Update notices are
 *   passive in Settings unless the reader asks for more.
 * - `dismissedReleases` is per release id. Escape, back, outside-close, the
 *   explicit close button and "later" all count as dismissal, and dismissal is
 *   durable: a normal launch, a recheck or an install never re-asks about the
 *   same release. A genuinely later release has a new id and may appear.
 *
 * Dismissal is not the same as the permanent Updates row (which is always
 * reachable) and never cancels an active download.
 *
 * Unreadable storage is treated as "no preference saved" — never as consent.
 */

export const UPDATE_PREFS_STORAGE_KEY = "findback.updates.preferences.v1";
export const UPDATE_DISMISSED_STORAGE_KEY = "findback.updates.dismissed.v1";
export const UPDATE_SEEN_STORAGE_KEY = "findback.updates.seen.v1";

export interface UpdatePreferences {
  readonly popupEnabled: boolean;
}

export const DEFAULT_UPDATE_PREFERENCES: UpdatePreferences = Object.freeze({
  popupEnabled: false,
});

export type UpdateStorage = Pick<Storage, "getItem" | "setItem"> | null;

function storageOrNull(storage: UpdateStorage | undefined): UpdateStorage {
  if (storage !== undefined) return storage;
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function readJson(storage: UpdateStorage, key: string): unknown {
  if (storage === null) return null;
  try {
    const raw = storage.getItem(key);
    if (raw === null) return null;
    return JSON.parse(raw) as unknown;
  } catch {
    // Corrupt entry: no saved preference, not a reason to throw at boot.
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Only an explicit `true` enables popups; everything else is the default. */
export function loadUpdatePreferences(storage?: UpdateStorage): UpdatePreferences {
  const raw = readJson(storageOrNull(storage), UPDATE_PREFS_STORAGE_KEY);
  if (!isRecord(raw)) return DEFAULT_UPDATE_PREFERENCES;
  return { popupEnabled: raw.popupEnabled === true };
}

export function saveUpdatePreferences(
  preferences: UpdatePreferences,
  storage?: UpdateStorage,
): UpdatePreferences {
  const resolved = storageOrNull(storage);
  const next: UpdatePreferences = { popupEnabled: preferences.popupEnabled === true };
  if (resolved !== null) {
    try {
      resolved.setItem(UPDATE_PREFS_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Quota/private mode: the in-memory choice still applies this session.
    }
  }
  return next;
}

/**
 * Dismissed release ids, oldest first. Non-string and duplicate entries are
 * dropped rather than repaired, so a hand-edited value cannot hide a release.
 */
export function loadDismissedReleases(storage?: UpdateStorage): readonly string[] {
  return loadReleaseIds(UPDATE_DISMISSED_STORAGE_KEY, storage);
}

export function loadSeenReleases(storage?: UpdateStorage): readonly string[] {
  return loadReleaseIds(UPDATE_SEEN_STORAGE_KEY, storage);
}

function loadReleaseIds(key: string, storage?: UpdateStorage): readonly string[] {
  const raw = readJson(storageOrNull(storage), key);
  if (!isRecord(raw) || !Array.isArray(raw.releaseIds)) return [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const entry of raw.releaseIds) {
    if (typeof entry !== "string") continue;
    const id = entry.trim();
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function isReleaseDismissed(releaseId: string, storage?: UpdateStorage): boolean {
  return loadDismissedReleases(storage).includes(releaseId.trim());
}

/** Unknown/corrupt receipts must not be replaced with a blank history. */
export function dismissalHistoryReadable(storage?: UpdateStorage): boolean {
  return historyReadable(UPDATE_DISMISSED_STORAGE_KEY, storage);
}

export function seenHistoryReadable(storage?: UpdateStorage): boolean {
  return historyReadable(UPDATE_SEEN_STORAGE_KEY, storage);
}

function historyReadable(key: string, storage?: UpdateStorage): boolean {
  const resolved = storageOrNull(storage);
  if (resolved === null) return false;
  try {
    const entry = resolved.getItem(key);
    if (entry === null) return true;
    const raw: unknown = JSON.parse(entry);
    return isRecord(raw) && Array.isArray(raw.releaseIds) &&
      raw.releaseIds.every(id => typeof id === "string" && id.trim() !== "");
  } catch { return false; }
}

/**
 * Persist a dismissal. Idempotent, and it never throws: failing to
 * write must not turn "later" into a modal the reader cannot close.
 */
export function dismissRelease(releaseId: string, storage?: UpdateStorage): readonly string[] {
  return persistReleaseId(UPDATE_DISMISSED_STORAGE_KEY, releaseId, storage);
}

export function markReleaseSeen(releaseId: string, storage?: UpdateStorage): readonly string[] {
  return persistReleaseId(UPDATE_SEEN_STORAGE_KEY, releaseId, storage);
}

function persistReleaseId(key: string, releaseId: string, storage?: UpdateStorage): readonly string[] {
  const id = releaseId.trim();
  const resolved = storageOrNull(storage);
  const existing = loadReleaseIds(key, resolved);
  if (id === "") return existing;
  const next = [...existing.filter((entry) => entry !== id), id];
  if (resolved !== null && historyReadable(key, resolved)) {
    try {
      resolved.setItem(key, JSON.stringify({ releaseIds: next }));
    } catch {
      // See saveUpdatePreferences.
    }
  }
  return next;
}
