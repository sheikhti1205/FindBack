import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(process.cwd(), "../..");
const MIGRATION = resolve(REPO_ROOT, "supabase/migrations/20261002020000_push_devices_and_preferences.sql");

function sql(): string {
  return readFileSync(MIGRATION, "utf8");
}

describe("push devices and preferences migration", () => {
  it("adds a dispatch marker to notifications", () => {
    const text = sql();
    expect(text).toMatch(/alter table public\.notifications add column if not exists pushed_at text/i);
    expect(text).toMatch(/where pushed_at is null and deleted_at is null/i);
  });

  it("keeps device tokens and preferences private to the service role", () => {
    const text = sql();
    for (const table of ["device_tokens", "notification_preferences"]) {
      expect(text).toMatch(new RegExp(`alter table public\\.${table} enable row level security`, "i"));
    }
    // No permissive policies: the definer RPCs are the only client door.
    expect(text).not.toMatch(/create policy/i);
  });

  it("scopes every client RPC to auth.uid and never trusts a caller user id", () => {
    const text = sql();
    for (const fn of [
      "findback_register_device_token_client",
      "findback_unregister_device_token_client",
      "findback_get_notification_preferences_client",
      "findback_set_notification_preferences_client",
    ]) {
      expect(text).toMatch(new RegExp(`function public\\.${fn}`, "i"));
    }
    expect(text).not.toMatch(/p_user_id/);
    expect(text).toMatch(/v_uid text := auth\.uid\(\)::text/);
  });

  it("grants execute only to authenticated", () => {
    const text = sql();
    expect(text).toMatch(/grant execute on function public\.findback_register_device_token_client\(text, text\) to authenticated/i);
    expect(text).toMatch(/grant execute on function public\.findback_get_notification_preferences_client\(\) to authenticated/i);
    expect(text).toMatch(/revoke all on function public\.findback_set_notification_preferences_client\([^)]*\) from public, anon/i);
  });
});
