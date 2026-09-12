import pg from "pg";
import type { DbAdapter, Row } from "./types.js";

/**
 * Minimal surface the adapter needs from a PostgreSQL client. Keeping it this
 * small lets tests supply a fake instead of a live database.
 */
export interface PgQueryResult {
  rows: Row[];
  rowCount: number | null;
}

export interface PgQueryable {
  query(text: string, values?: unknown[]): Promise<PgQueryResult>;
  end(): Promise<void>;
}

// Preserve the JS types the SQLite provider produced: COUNT(*) is int8 and
// AVG(score) is numeric, both of which `pg` would otherwise return as strings.
pg.types.setTypeParser(20, (value) => Number(value)); // int8
pg.types.setTypeParser(1700, (value) => Number(value)); // numeric

/** Rewrite `?` placeholders to Postgres `$1, $2, ...`. */
export function toPgPlaceholders(sql: string): string {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

export class PostgresAdapter implements DbAdapter {
  readonly dialect = "postgres" as const;

  constructor(private readonly client: PgQueryable) {}

  async init(): Promise<void> {
    await this.client.query("SELECT 1");
  }

  async run(sql: string, params: unknown[] = []): Promise<void> {
    await this.query(sql, params);
  }

  async runResult(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    const result = await this.query(sql, params);
    return { changes: result.rowCount ?? 0 };
  }

  async get<T = Row>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const result = await this.query(sql, params);
    return result.rows[0] as T | undefined;
  }

  async all<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.query(sql, params);
    return result.rows as T[];
  }

  async close(): Promise<void> {
    await this.client.end();
  }

  /**
   * Drops and recreates the `public` schema. PostgreSQL-only helper used by
   * reset flows; apply `supabase/migrations/*.sql` afterwards to restore the
   * tables (see `applyMigrations`).
   */
  async reset(): Promise<void> {
    await this.client.query("DROP SCHEMA IF EXISTS public CASCADE");
    await this.client.query("CREATE SCHEMA public");
  }

  private async query(sql: string, params: unknown[]): Promise<PgQueryResult> {
    // Pass no values array for multi-statement DDL (extended protocol rejects it).
    const text = toPgPlaceholders(sql);
    return params.length ? this.client.query(text, params) : this.client.query(text);
  }
}

/** Build a pooled client from a Supabase/PostgreSQL connection URI. */
export function createPgPool(connectionString: string): PgQueryable {
  const pool = new pg.Pool({ connectionString, max: 10 });
  return {
    query: (text, values) =>
      (values ? pool.query(text, values) : pool.query(text)) as unknown as Promise<PgQueryResult>,
    end: () => pool.end(),
  };
}
