import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import type { DbAdapter } from "./types.js";

/**
 * Applies ordered `supabase/migrations/*.sql` files and records them in
 * `schema_migrations`. Intended for PostgreSQL/Supabase; the SQLite provider
 * creates its schema inline and does not need this.
 */
export const MIGRATIONS_DIR = path.resolve(config.packageRoot, "..", "..", "supabase", "migrations");

export function migrationFiles(dir = MIGRATIONS_DIR): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".sql"))
    .sort();
}

export async function applyMigrations(db: DbAdapter, dir = MIGRATIONS_DIR): Promise<string[]> {
  await db.run(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const applied: string[] = [];
  for (const file of migrationFiles(dir)) {
    const seen = await db.get<{ version: string }>(
      "SELECT version FROM schema_migrations WHERE version = ?",
      [file],
    );
    if (seen) continue;
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    await db.run(sql);
    await db.run("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", [
      file,
      new Date().toISOString(),
    ]);
    applied.push(file);
  }
  return applied;
}
