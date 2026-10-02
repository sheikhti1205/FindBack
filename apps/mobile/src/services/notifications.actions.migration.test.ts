import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(process.cwd(), "../..");
const MIGRATION = resolve(REPO_ROOT, "supabase/migrations/20261002000000_notifications_inbox_actions.sql");

function sql(): string {
  return readFileSync(MIGRATION, "utf8");
}

describe("notifications inbox-actions migration", () => {
  it("adds a soft-delete marker and active/deleted indexes", () => {
    const text = sql();
    expect(text).toMatch(/add column if not exists deleted_at text/i);
    expect(text).toMatch(/idx_notifications_user_active/i);
    expect(text).toMatch(/idx_notifications_user_deleted/i);
    expect(text).toMatch(/where deleted_at is null/i);
    expect(text).toMatch(/where deleted_at is not null/i);
  });

  it("dedupes new notifications only against active rows", () => {
    const text = sql();
    expect(text).toMatch(/function public\.findback_insert_notification/);
    expect(text).toMatch(/and n\.deleted_at is null/i);
  });

  it("supersedes only active unread reaction rows on a switch", () => {
    const text = sql();
    expect(text).toMatch(/and n\.read = 0\s+and n\.deleted_at is null/i);
  });

  it("drops the old list signature before recreating it with a deleted flag", () => {
    const text = sql();
    expect(text).toMatch(/drop function if exists public\.findback_list_notifications_client\(\)/i);
    expect(text).toMatch(/function public\.findback_list_notifications_client\(\s*p_deleted boolean default false/i);
  });

  it("counts only active unread rows", () => {
    const text = sql();
    expect(text).toMatch(/where n\.user_id = v_uid and n\.read = 0 and n\.deleted_at is null/i);
  });

  it("exposes read, unread, delete and restore RPCs to authenticated only", () => {
    const text = sql();
    for (const rpc of [
      "findback_mark_notifications_read_client",
      "findback_mark_notifications_unread_client",
      "findback_delete_notifications_client",
      "findback_restore_notifications_client",
    ]) {
      expect(text, `${rpc} defined`).toMatch(new RegExp(`function public\\.${rpc}`));
      expect(text, `${rpc} granted to authenticated`).toMatch(
        new RegExp(`grant execute on function public\\.${rpc}\\(text\\[\\]\\)[\\s\\S]*? to authenticated`),
      );
      expect(text, `${rpc} revoked from anon`).toMatch(
        new RegExp(`revoke all on function public\\.${rpc}\\(text\\[\\]\\)[\\s\\S]*?from public, anon`),
      );
    }
  });
});
