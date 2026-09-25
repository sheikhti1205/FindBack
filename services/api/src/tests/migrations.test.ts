import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MIGRATIONS = fileURLToPath(new URL("../../../../supabase/migrations/", import.meta.url));
const CONSUME_FILE = "20260916000000_consume_staging_upload.sql";
const LOCK_FILE = "20260916010000_add_staging_upload_lock_prerequisites.sql";
// The migration that (erroneously) introduced text subscripting in the date helper.
const BUG_FILE = "20260919000000_validation_alignment.sql";
// The forward-only correction for the publishing failure.
const CALENDAR_FIX_FILE = "20260925000000_fix_calendar_date_subscript.sql";

function readMigrations(): Array<{ name: string; sql: string }> {
  return fs
    .readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, sql: fs.readFileSync(path.join(MIGRATIONS, name), "utf8") }));
}

/** Strip SQL comments (line + block) while preserving newlines, so line numbers stay valid. */
function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/--[^\n]*/g, "");
}

describe("consume staging upload migration", () => {
  it("deletes the exact caller-owned staging row inside the create RPC", () => {
    const full = path.join(MIGRATIONS, CONSUME_FILE);
    expect(fs.existsSync(full)).toBe(true);
    const sql = fs.readFileSync(full, "utf8");
    expect(sql).toMatch(/create or replace function public\.findback_create_post_client/i);
    expect(sql).toMatch(/delete from public\.uploads/i);
    expect(sql).toMatch(/id = p_attachment_key/i);
    expect(sql).toMatch(/user_id = v_uid/i);
    expect(sql).toMatch(/where id = p_attachment_key\s+for update/i);
    expect(sql).not.toMatch(/delete from public\.uploads\s*;/i);
  });

  it("keeps the lock prerequisites in a newer idempotent migration", () => {
    const consumeFull = path.join(MIGRATIONS, CONSUME_FILE);
    const lockFull = path.join(MIGRATIONS, LOCK_FILE);
    expect(fs.existsSync(consumeFull)).toBe(true);
    expect(fs.existsSync(lockFull)).toBe(true);

    const consumeSql = fs.readFileSync(consumeFull, "utf8");
    const lockSql = fs.readFileSync(lockFull, "utf8");
    expect(consumeSql).not.toMatch(/grant update \(id\) on public\.uploads to authenticated/i);
    expect(consumeSql).not.toMatch(/create policy uploads_lock_own/i);
    expect(lockSql).toMatch(/grant update \(id\) on public\.uploads to authenticated/i);
    expect(lockSql).toMatch(/drop policy if exists uploads_lock_own/i);
    expect(lockSql).toMatch(/create policy uploads_lock_own/i);
    expect(lockSql).toMatch(/on public\.uploads for update to authenticated/i);
    expect(lockSql).toMatch(/with check \(false\)/i);
  });

  it("orders both migrations after the migration they replace", () => {
    expect(CONSUME_FILE > "20260914190000_post_mutations.sql").toBe(true);
    expect(LOCK_FILE > CONSUME_FILE).toBe(true);
  });
});

describe("calendar date validation migration (regression guard)", () => {
  it("corrects the broken helper in a forward-only migration", () => {
    const fix = readMigrations().find((m) => m.name === CALENDAR_FIX_FILE);
    expect(fix).toBeDefined();
    // Forward-only: the fix must sort after the migration that introduced the bug.
    expect(CALENDAR_FIX_FILE > BUG_FILE).toBe(true);
    // Idempotent re-push, and the PostgreSQL-valid extraction + calendar check.
    expect(fix?.sql).toMatch(/create or replace function public\.findback_is_valid_calendar_date/i);
    expect(fix?.sql).toMatch(/substring\(\s*p_date from 1 for 4\s*\)/i);
    expect(fix?.sql).toMatch(/substring\(\s*p_date from 6 for 2\s*\)/i);
    expect(fix?.sql).toMatch(/substring\(\s*p_date from 9 for 2\s*\)/i);
    expect(fix?.sql).toMatch(/make_date\(/i);
    expect(fix?.sql).toMatch(/\^\[0-9\]\{4\}-\[0-9\]\{2\}-\[0-9\]\{2\}\$/);
    expect(fix?.sql).toMatch(/security invoker/i);
    expect(fix?.sql).toMatch(/set search_path = public, pg_temp/i);
  });

  it("makes the newest helper definition the corrected one, not a history rewrite", () => {
    const defs = readMigrations().filter((m) =>
      /create or replace function public\.findback_is_valid_calendar_date/i.test(m.sql),
    );
    expect(defs.length).toBeGreaterThanOrEqual(2);
    const newest = defs[defs.length - 1] as { name: string; sql: string };
    expect(newest.name).toBe(CALENDAR_FIX_FILE);
    expect(stripSqlComments(newest.sql)).not.toMatch(/p_date\s*\[/);
    // The original bug stays in applied history — the fix must never be an edit of it.
    expect((defs[0] as { name: string }).name).toBe(BUG_FILE);
    expect(stripSqlComments((defs[0] as { sql: string }).sql)).toMatch(/p_date\[1:4\]/);
  });

  it("ships no text-subscript slicing anywhere else in the migration chain", () => {
    const slice = /\b[a-zA-Z_][a-zA-Z0-9_]*\s*\[\s*\d+\s*:\s*\d+\s*\]/;
    const offenders: string[] = [];
    for (const migration of readMigrations()) {
      stripSqlComments(migration.sql).split("\n").forEach((line, index) => {
        if (slice.test(line)) offenders.push(`${migration.name}:${index + 1}`);
      });
    }
    // Only the historical, already-applied occurrence is permitted.
    expect(offenders).toEqual([`${BUG_FILE}:43`, `${BUG_FILE}:44`, `${BUG_FILE}:45`]);
  });
});
