/**
 * Provider-agnostic database contract.
 *
 * SQLite (`node:sqlite`) is synchronous; PostgreSQL (`pg`) is asynchronous.
 * To let both backends be selected at runtime (DB_PROVIDER), the whole data
 * access layer is async. Every SQL string keeps `?` placeholders — the
 * PostgreSQL adapter rewrites them to `$1, $2, ...`.
 */

export type Row = Record<string, unknown>;

/** Values a bound parameter may hold. */
export type SqlValue = string | number | bigint | Uint8Array | null;

export type Dialect = "sqlite" | "postgres";

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
