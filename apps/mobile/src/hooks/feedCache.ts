import type { PostItem } from "@findback/shared";
import type { FeedFilters } from "../services/posts";
import { nearbyCenterFingerprint } from "../services/nearby";

interface FeedCacheEntry {
  items: PostItem[];
  total: number;
  cursor: string | null;
  scrollTop: number;
  filters: string;
  lastRefresh: number;
  newPostCount: number;
  /** Set when a realtime INSERT arrived while this feed was not mounted. */
  dirty: boolean;
}

/** Per-session in-memory cache keyed by filter string. */
const sessionCache = new Map<string, FeedCacheEntry>();
/**
 * Monotonic invalidation epoch. A feed that loaded before an invalidation must
 * not persist its older items as fresh: its save keeps `dirty` set so the next
 * mount refetches instead of restoring a stale row.
 */
let cacheEpoch = 0;
const STALE_MS = 5 * 60 * 1000; // 5 minutes

/** Normalized filter identity: type/search/query trimmed, empties collapsed. */
export function feedFilterKey(filters: FeedFilters): string {
  const normalized = {
    type: (filters.type ?? "").trim(),
    category: (filters.category ?? "").trim(),
    status: (filters.status ?? "").trim(),
    q: (filters.q ?? "").trim(),
    sort: (filters.sort ?? "").trim(),
    dateFrom: (filters.dateFrom ?? "").trim(),
    dateTo: (filters.dateTo ?? "").trim(),
    userId: (filters.userId ?? "").trim(),
    // Nearby scope: on/off + radius + rounded-center fingerprint. The exact
    // fix never enters the key (only the ~100 m rounded cell), and the
    // center never enters the URL either.
    near: nearbyFeedKey(filters),
  };
  return JSON.stringify(normalized);
}

/** Nearby slice of the cache identity: "" when nearby is off. */
function nearbyFeedKey(filters: FeedFilters): string {
  if (
    typeof filters.nearLat !== "number" ||
    typeof filters.nearLng !== "number" ||
    typeof filters.radiusM !== "number" ||
    !Number.isFinite(filters.nearLat) ||
    !Number.isFinite(filters.nearLng) ||
    !Number.isFinite(filters.radiusM)
  ) {
    return "";
  }
  return nearbyCenterFingerprint({ lat: filters.nearLat, lng: filters.nearLng }, filters.radiusM);
}

/** Full session key: base scope plus normalized filter identity. */
export function buildFeedCacheKey(base: string, filters: FeedFilters): string {
  return `${base}:${feedFilterKey(filters)}`;
}

/** Clear all per-session feed caches (logout). */
export function clearFeedCaches(): void {
  sessionCache.clear();
}

export function saveFeedCache(
  filterKey: string,
  data: { items: PostItem[]; total: number; cursor: string | null; scrollTop: number },
  options: { clearNewPostCount?: boolean; loadedEpoch?: number; dirty?: boolean } = {},
): void {
  const existing = sessionCache.get(filterKey);
  // A feed loaded before the last invalidation cannot certify its items as
  // fresh. Its save stays dirty so a later mount refetches. A snapshot whose
  // restored rows were already dirty keeps that provenance until a successful
  // full replacement, regardless of the latest append/restore epoch.
  const stale =
    options.dirty === true ||
    (options.loadedEpoch !== undefined && options.loadedEpoch !== cacheEpoch);
  sessionCache.set(filterKey, {
    ...data,
    filters: filterKey,
    lastRefresh: Date.now(),
    // A save of data loaded after the last invalidation is fresh. The pending
    // new-post pill is preserved unless the caller explicitly consumed it.
    dirty: stale,
    newPostCount: options.clearNewPostCount ? 0 : (existing?.newPostCount ?? 0),
  });
}

/** The current invalidation epoch; feeds capture it when they load. */
export function feedCacheEpoch(): number {
  return cacheEpoch;
}

/**
 * Mark every cached feed dirty because a new post arrived while it was not
 * mounted. The next load restores the visible items (no flash) and refetches.
 */
export function invalidateFeedCaches(): void {
  cacheEpoch += 1;
  for (const entry of sessionCache.values()) entry.dirty = true;
}

export function loadFeedCache(filterKey: string): FeedCacheEntry | null {
  const entry = sessionCache.get(filterKey);
  if (!entry) return null;
  if (Date.now() - entry.lastRefresh > STALE_MS) {
    sessionCache.delete(filterKey);
    return null;
  }
  return entry;
}

export function incrementNewPostCount(filterKey: string, delta: number): void {
  const entry = sessionCache.get(filterKey);
  if (entry) {
    entry.newPostCount = Math.max(0, entry.newPostCount + delta);
    return;
  }
  // A realtime INSERT can arrive before this filter's first persist (a fresh
  // mount has nothing saved yet). Create a dirty count-only entry so the
  // new-posts pill still raises; dirty keeps the next load fetching instead
  // of restoring an empty list.
  if (delta <= 0) return;
  sessionCache.set(filterKey, {
    items: [],
    total: 0,
    cursor: null,
    scrollTop: 0,
    filters: filterKey,
    lastRefresh: Date.now(),
    newPostCount: delta,
    dirty: true,
  });
}

export function clearNewPostCount(filterKey: string): void {
  const entry = sessionCache.get(filterKey);
  if (entry) entry.newPostCount = 0;
}

export function getNewPostCount(filterKey: string): number {
  return sessionCache.get(filterKey)?.newPostCount ?? 0;
}
