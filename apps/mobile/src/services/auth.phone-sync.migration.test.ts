import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function sql() {
  return readFileSync(resolve(process.cwd(), "../../supabase/migrations/20261006120000_auth_phone_verification_sync.sql"), "utf8");
}

describe("server-owned phone verification migration", () => {
  it("requires a confirmed auth phone matching the normalized desired number", () => {
    expect(sql()).toMatch(/new\.phone_confirmed_at is not null/i);
    expect(sql()).toMatch(/v_phone = public\.findback_normalize_bd_phone\(new\.phone\)/i);
    expect(sql()).not.toMatch(/->>\s*'phoneVerified'|->>\s*'phone_verified'/i);
  });
  it("syncs only the auth user's row and retains email sync", () => {
    expect(sql()).toMatch(/where id = new\.id::text/i);
    expect(sql()).toMatch(/email_confirmed_at is not null/i);
    expect(sql()).toMatch(/phone_verified = v_phone_verified/i);
    expect(sql()).toMatch(/phone = coalesce\(v_phone, phone\)/i);
  });
  it("backfills existing rows without broadening client privileges", () => {
    expect(sql()).toMatch(/update public\.users u[\s\S]*from auth\.users a/i);
    expect(sql()).toMatch(/u\.id = a\.id::text/i);
    expect(sql()).toMatch(/revoke all on function public\.handle_auth_user_updated\(\) from public, anon, authenticated/i);
    expect(sql()).not.toMatch(/grant (update|insert|execute)/i);
    expect(sql()).toMatch(/security definer\s+set search_path = public, pg_temp/i);
  });
  it("does not let an unverified display number reserve confirmed Auth ownership", () => {
    expect(sql()).toMatch(/drop index if exists public\.ux_users_phone_lower/i);
  });
});
