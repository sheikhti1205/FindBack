/**
 * The metadata transaction and byte-store transaction are separate. Hold one
 * origin-wide account lock across BOTH, including rollback/eviction cleanup.
 * A per-handle Promise queue cannot protect another tab's committed bytes.
 * Lock lifetime follows the returned promise; it is released on failure/crash.
 */
export async function withHistoryLock<T>(accountId: string, signal: AbortSignal,
  requiresMediaLock: boolean, work: () => Promise<T>): Promise<T> {
  const locks = globalThis.navigator?.locks;
  if (!locks) {
    // Existing text-only history needs only its metadata transaction. Never
    // silently downgrade cross-store media safety to a process-local mutex.
    if (requiresMediaLock) return Promise.reject(new Error("Messaging media requires Web Locks"));
    return work();
  }
  return locks.request(`findback-messaging:${accountId}`, { mode: "exclusive", signal }, work);
}
