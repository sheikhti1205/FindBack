import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(process.cwd(), "../..");
const MIGRATION = resolve(REPO_ROOT, "supabase/migrations/20261002050000_push_hardening.sql");

function sql(): string {
  return readFileSync(MIGRATION, "utf8");
}

describe("push hardening migration", () => {
  it("makes a device token belong to exactly one current owner", () => {
    const text = sql();
    // Existing duplicates are collapsed before the global unique constraint.
    expect(text).toMatch(/delete from public\.device_tokens d[\s\S]*using public\.device_tokens k/i);
    expect(text).toMatch(/drop constraint if exists device_tokens_user_id_token_key/i);
    expect(text).toMatch(/add constraint device_tokens_token_key unique \(token\)/i);
  });

  it("transfers token ownership on registration under a new user", () => {
    const text = sql();
    expect(text).toMatch(/on conflict \(token\) do update/i);
    expect(text).toMatch(/set user_id = excluded\.user_id/i);
    expect(text).toMatch(/grant execute on function public\.findback_register_device_token_client\(text, text\) to authenticated/i);
  });

  it("consumes the reply token and inserts the reply in one locked transaction", () => {
    const text = sql();
    expect(text).toMatch(/function public\.findback_consume_reply_token_and_add_comment\(/i);
    expect(text).toMatch(/for update/i);
    expect(text).toMatch(/insert into public\.comments/i);
    expect(text).toMatch(/update public\.push_reply_tokens set used_at/i);
    expect(text).toMatch(/returns table \(ok boolean, reason text, comment_id text\)/i);
    // Service-role only: the device presents a token, never a session.
    expect(text).toMatch(/revoke all on function public\.findback_consume_reply_token_and_add_comment\(text, text\)\s*from public, anon, authenticated/i);
    expect(text).toMatch(/grant execute on function public\.findback_consume_reply_token_and_add_comment\(text, text\) to service_role/i);
  });

  it("bounds push retries instead of retiring a transient failure", () => {
    const text = sql();
    expect(text).toMatch(/add column if not exists push_attempts integer not null default 0/i);
    expect(text).toMatch(/add column if not exists push_last_error text/i);
    expect(text).toMatch(/function public\.findback_record_push_failure\(/i);
    expect(text).toMatch(/grant execute on function public\.findback_record_push_failure\(text\[\], text, integer\) to service_role/i);
  });

  it("revokes direct grants on server/RPC-only tables", () => {
    const text = sql();
    for (const table of ["device_tokens", "notification_preferences", "push_reply_tokens"]) {
      expect(text).toMatch(new RegExp(`revoke select, insert, update, delete on public\\.${table} from anon, authenticated`, "i"));
    }
    expect(text).toMatch(/revoke select on public\.notifications from anon, authenticated/i);
  });
});
