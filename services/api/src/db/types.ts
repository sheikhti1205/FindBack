/**
 * SQL adapter contract for the SQLite test/demo backend.
 *
 * Production persistence goes through the typed `Store` (Supabase Data API);
 * this low-level SQL layer exists only so the automated test harness and local
 * demo can run against an in-memory SQLite database. `node:sqlite` is
 * synchronous, but the methods are async so callers stay backend-agnostic.
 */

export type Row = Record<string, unknown>;

/** Values a bound parameter may hold. */
export type SqlValue = string | number | bigint | Uint8Array | null;

export type Dialect = "sqlite";

export interface DbAdapter {
  readonly dialect: Dialect;

  /** Ensure the schema exists and the connection is usable. */
  init(): Promise<void>;

  /** Execute a statement, ignoring the affected-row count. */
  run(sql: string, params?: unknown[]): Promise<void>;

  /** Execute a statement and return how many rows changed. */
  runResult(sql: string, params?: unknown[]): Promise<{ changes: number }>;

  /** First matching row, or undefined. */
  get<T = Row>(sql: string, params?: unknown[]): Promise<T | undefined>;

  /** All matching rows. */
  all<T = Row>(sql: string, params?: unknown[]): Promise<T[]>;

  /** Close the connection / pool. Idempotent. */
  close(): Promise<void>;

  /** Drop all data and recreate the schema. Used by tests. */
  reset(): Promise<void>;
}
