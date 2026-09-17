import type { PostItem } from "@findback/shared";
import type { FeedFilters } from "../services/posts";

interface FeedCacheEntry {
  items: PostItem[];
  total: number;
  cursor: string | null;
  scrollTop: number;
  filters: string;
  lastRefresh: number;
  newPostCount: number;
}

/** Per-session in-memory cache keyed by filter string. */
const sessionCache = new Map<string, FeedCacheEntry>();
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
  };
  return JSON.stringify(normalized);
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
): void {
  sessionCache.set(filterKey, {
    ...data,
    filters: filterKey,
    lastRefresh: Date.now(),
    newPostCount: 0,
  });
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
  if (entry) entry.newPostCount = Math.max(0, entry.newPostCount + delta);
}

export function clearNewPostCount(filterKey: string): void {
  const entry = sessionCache.get(filterKey);
  if (entry) entry.newPostCount = 0;
}

export function getNewPostCount(filterKey: string): number {
  return sessionCache.get(filterKey)?.newPostCount ?? 0;
}
