import { config } from "../config.js";
import { SqliteAdapter } from "./sqliteAdapter.js";
import { SqliteStore } from "./store/sqliteStore.js";
import { SupabaseStore } from "./store/supabaseStore.js";
import type { Store } from "./store/types.js";
import type { DbAdapter, Dialect, Row, SqlValue } from "./types.js";

export type { DbAdapter, Dialect, Row, SqlValue };
export type { Store } from "./store/types.js";

let adapter: DbAdapter | null = null;
let store: Store | null = null;

/**
 * The active SQL adapter. SQLite is the only SQL backend: it powers the
 * automated test harness and local demo (`seed`). Production uses the
 * Supabase Data API through `getStore()` and never touches this.
 */
export function getAdapter(): DbAdapter {
  if (!adapter) adapter = new SqliteAdapter(config.dbFile);
  return adapter;
}

/** Test/CLI hook to release the current adapter before switching providers. */
export async function closeDb(): Promise<void> {
  if (adapter) {
    await adapter.close();
    adapter = null;
  }
  store = null;
}

/**
 * The active typed Store used by the domain services.
 *
 * `supabase` targets the Supabase Data API with the backend-only secret key
 * (the real application backend). `sqlite` is the in-memory test harness and
 * local demo backend.
 */
export function getStore(): Store {
  if (store) return store;
  store =
    config.dbProvider === "supabase"
      ? new SupabaseStore(config.supabaseUrl, config.supabaseSecretKey)
      : new SqliteStore(getAdapter());
  return store;
}

/** Rebuild the active database (used by tests). */
export async function resetDb(): Promise<void> {
  await getAdapter().reset();
}

// Thin delegating helpers so domain code can keep calling run/get/all with `await`.
export function run(sql: string, params: unknown[] = []): Promise<void> {
  return getAdapter().run(sql, params);
}

export function runResult(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
  return getAdapter().runResult(sql, params);
}

export function get<T = Row>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  return getAdapter().get<T>(sql, params);
}

export function all<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
  return getAdapter().all<T>(sql, params);
}
