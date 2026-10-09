import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function sql() {
  return readFileSync(
    resolve(process.cwd(), "../../supabase/migrations/20261009020000_profile_identity.sql"),
    "utf8",
  );
}

/**
 * The migration is auto-applied by the Supabase GitHub integration on push, so
 * these assertions pin the destructive-safety contract: additive columns only,
 * no broad table grant, a self-only SECURITY DEFINER writer, and a public
 * lookup that never returns email/phone.
 */
describe("profile identity migration", () => {
  it("adds the identity columns additively, never dropping data", () => {
    expect(sql()).toMatch(/alter table public\.users\s+add column if not exists bio text/i);
    expect(sql()).toMatch(/alter table public\.users\s+add column if not exists location_label text/i);
    expect(sql()).not.toMatch(/drop table|drop column|delete from|truncate/i);
  });

  it("grants only the new public columns to authenticated (no broad UPDATE)", () => {
    expect(sql()).toMatch(/grant select \(bio, location_label\) on public\.users to authenticated/i);
    expect(sql()).not.toMatch(/grant (update|insert|delete)/i);
    expect(sql()).not.toMatch(/revoke all on public\.users/i);
  });

  it("writes through a self-only SECURITY DEFINER RPC with a locked search_path", () => {
    const text = sql();
    expect(text).toMatch(/create or replace function public\.update_my_profile/i);
    expect(text).toMatch(/security definer\s+set search_path = public, pg_temp/i);
    expect(text).toMatch(/v_uid\s+text := public\.findback_uid\(\)/i);
    expect(text).toMatch(/update public\.users[\s\S]*where id = v_uid/i);
    expect(text).not.toMatch(/p_user_id|p_uid/i);
  });

  it("bounds every identity field and treats blank input as NULL", () => {
    const text = sql();
    expect(text).toMatch(/char_length\(v_display\) > 80/i);
    expect(text).toMatch(/char_length\(v_bio\) > 280/i);
    expect(text).toMatch(/char_length\(v_loc\) > 60/i);
    expect(text).toMatch(/nullif\(btrim\(coalesce\(p_bio, ''\)\), ''\)/i);
    expect(text).toMatch(/nullif\(btrim\(coalesce\(p_location_label, ''\)\), ''\)/i);
  });

  it("revokes the writer from anon and grants it only to authenticated", () => {
    const text = sql();
    expect(text).toMatch(/revoke all on function public\.update_my_profile\(text, text, text\) from public/i);
    expect(text).toMatch(/revoke execute on function public\.update_my_profile\(text, text, text\) from anon/i);
    expect(text).toMatch(/grant execute on function public\.update_my_profile\(text, text, text\) to authenticated/i);
  });

  it("extends the public lookup with safe columns and never email/phone", () => {
    const text = sql();
    expect(text).toMatch(/create function public\.public_profile_by_username\(p_username text\)/i);
    expect(text).toMatch(/\bdisplay_name text\b/i);
    expect(text).toMatch(/\bbio text\b/i);
    expect(text).toMatch(/\blocation_label text\b/i);
    expect(text).toMatch(/u\.email_verified/i);
    expect(text).not.toMatch(/u\.email\b|u\.phone\b/i);
    expect(text).toMatch(/grant execute on function public\.public_profile_by_username\(text\) to anon, authenticated/i);
  });
});
