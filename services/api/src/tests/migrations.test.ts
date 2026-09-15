import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MIGRATIONS = fileURLToPath(new URL("../../../../supabase/migrations/", import.meta.url));
const FILE = "20260916000000_consume_staging_upload.sql";

describe("consume staging upload migration", () => {
  it("deletes the exact caller-owned staging row inside the create RPC", () => {
    const full = path.join(MIGRATIONS, FILE);
    expect(fs.existsSync(full)).toBe(true);
    const sql = fs.readFileSync(full, "utf8");
    expect(sql).toMatch(/create or replace function public\.findback_create_post_client/i);
    expect(sql).toMatch(/grant update \(id\) on public\.uploads to authenticated/i);
    expect(sql).toMatch(/create policy uploads_lock_own/i);
    expect(sql).toMatch(/on public\.uploads for update to authenticated/i);
    expect(sql).toMatch(/with check \(false\)/i);
    expect(sql).toMatch(/delete from public\.uploads/i);
    expect(sql).toMatch(/id = p_attachment_key/i);
    expect(sql).toMatch(/user_id = v_uid/i);
    expect(sql).toMatch(/where id = p_attachment_key\s+for update/i);
    expect(sql).not.toMatch(/delete from public\.uploads\s*;/i);
  });

  it("is ordered after the migration it replaces", () => {
    expect(FILE > "20260914190000_post_mutations.sql").toBe(true);
  });
});
