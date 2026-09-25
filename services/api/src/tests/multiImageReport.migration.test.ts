import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MIGRATIONS = fileURLToPath(new URL("../../../../supabase/migrations/", import.meta.url));
// New forward-only migration owned by packet D1. Must sort after the latest
// existing migration without rewriting any applied history.
const MULTI_FILE = "20260926000000_multi_image_report.sql";
const PREVIOUS_LATEST = "20260925000000_fix_calendar_date_subscript.sql";
// The old single-key RPC definition; must stay present and unchanged.
const CONSUME_FILE = "20260916000000_consume_staging_upload.sql";

function readMigration(name: string): string {
  return fs.readFileSync(path.join(MIGRATIONS, name), "utf8");
}

describe("multi-image report migration (static, no live DB)", () => {
  it("ships a new forward-only migration after the previous latest", () => {
    const full = path.join(MIGRATIONS, MULTI_FILE);
    expect(fs.existsSync(full)).toBe(true);
    expect(MULTI_FILE > PREVIOUS_LATEST).toBe(true);
  });

  it("adds display_order to attachments as not-null with default 1", () => {
    const sql = readMigration(MULTI_FILE);
    expect(sql).toMatch(/alter table public\.attachments/i);
    expect(sql).toMatch(/add column if not exists display_order/i);
    expect(sql).toMatch(/display_order integer not null default 1/i);
  });

  it("backfills deterministically with the oldest attachment first", () => {
    const sql = readMigration(MULTI_FILE);
    expect(sql).toMatch(/row_number\(\)\s*over\s*\(\s*partition by post_id/i);
    expect(sql).toMatch(/order by created_at asc, id asc/i);
  });

  it("fails loudly on unexpected data shape instead of truncating", () => {
    const sql = readMigration(MULTI_FILE);
    expect(sql).toMatch(/having count\(\*\) > 5/i);
    expect(sql).toMatch(/more than 5 attachments/i);
    expect(sql).toMatch(/raise exception/i);
  });

  it("constrains one deterministic order per post within 1..5", () => {
    const sql = readMigration(MULTI_FILE);
    expect(sql).toMatch(/unique\s*\(\s*post_id\s*,\s*display_order\s*\)/i);
    expect(sql).toMatch(/check\s*\(\s*display_order between 1 and 5\s*\)/i);
  });

  it("defines a NEW versioned RPC and never redefines the old single-key one", () => {
    const sql = readMigration(MULTI_FILE);
    expect(sql).toMatch(
      /create or replace function public\.findback_create_post_client_multi/i,
    );
    expect(sql).not.toMatch(
      /function public\.findback_create_post_client\s*\(/i,
    );
  });

  it("leaves the old single-key RPC file untouched", () => {
    const consumeFull = path.join(MIGRATIONS, CONSUME_FILE);
    expect(fs.existsSync(consumeFull)).toBe(true);
    const sql = readMigration(CONSUME_FILE);
    expect(sql).toMatch(/function public\.findback_create_post_client\s*\(/i);
    expect(sql).toMatch(/p_attachment_key text default null/i);
    expect(sql).not.toMatch(/findback_create_post_client_multi/i);
    expect(sql).not.toMatch(/display_order/i);
  });

  it("accepts 0..5 staging keys and rejects duplicates", () => {
    const sql = readMigration(MULTI_FILE);
    expect(sql).toMatch(/p_attachment_keys text\[\] default '\{\}'/i);
    expect(sql).toMatch(/array_length\s*\(\s*v_keys\s*,\s*1\s*\)\s*>\s*5/i);
    expect(sql).toMatch(/at most 5 attachments/i);
    expect(sql).toMatch(/duplicate attachment keys/i);
  });

  it("validates each key against caller-owned staging rows", () => {
    const sql = readMigration(MULTI_FILE);
    expect(sql).toMatch(/from public\.uploads/i);
    expect(sql).toMatch(/v_upload\.user_id <> v_uid/i);
    expect(sql).toMatch(/attachment was not uploaded by you/i);
    expect(sql).toMatch(/attachment key does not exist/i);
  });

  it("locks staging rows in deterministic key order", () => {
    const sql = readMigration(MULTI_FILE);
    expect(sql).toMatch(/order by id\s+for update/i);
  });

  it("inserts attachments with explicit display_order", () => {
    const sql = readMigration(MULTI_FILE);
    expect(sql).toMatch(
      /insert into public\.attachments\s*\([\s\S]*?display_order[\s\S]*?\)\s*values/i,
    );
  });

  it("consumes exactly the given staging rows in the same transaction", () => {
    const sql = readMigration(MULTI_FILE);
    expect(sql).toMatch(/delete from public\.uploads/i);
    expect(sql).toMatch(/id = any\s*\(\s*v_keys\s*\)/i);
    expect(sql).toMatch(/user_id = v_uid/i);
    expect(sql).toMatch(/get diagnostics/i);
  });

  it("is rollback-safe with no partial-insert path", () => {
    const sql = readMigration(MULTI_FILE);
    expect(sql).not.toMatch(/exception\s+when/i);
    expect(sql).not.toMatch(/savepoint/i);
  });

  it("grants the new RPC like the old one without touching live data", () => {
    const sql = readMigration(MULTI_FILE);
    expect(sql).toMatch(/security invoker/i);
    expect(sql).toMatch(/set search_path = public, pg_temp/i);
    expect(sql).toMatch(
      /revoke all on function public\.findback_create_post_client_multi/i,
    );
    expect(sql).toMatch(
      /grant execute on function public\.findback_create_post_client_multi/i,
    );
    expect(sql).not.toMatch(/drop table/i);
    expect(sql).not.toMatch(/delete from storage\.objects/i);
    expect(sql).not.toMatch(/truncate/i);
  });
});
