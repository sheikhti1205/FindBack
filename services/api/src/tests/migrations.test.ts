import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MIGRATIONS = fileURLToPath(new URL("../../../../supabase/migrations/", import.meta.url));
const CONSUME_FILE = "20260916000000_consume_staging_upload.sql";
const LOCK_FILE = "20260916010000_add_staging_upload_lock_prerequisites.sql";

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
