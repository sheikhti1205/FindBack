import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(process.cwd(), "../..");
const MIGRATION = resolve(REPO_ROOT, "supabase/migrations/20261002060000_reply_mention_and_read.sql");

function sql(): string {
  return readFileSync(MIGRATION, "utf8");
}

describe("reply mention and read migration", () => {
  it("carries the source notification id on the reply token", () => {
    expect(sql()).toMatch(
      /alter table public\.push_reply_tokens\s+add column if not exists notification_id text/i,
    );
  });

  it("prefixes the reply with the parent comment actor's @username", () => {
    const text = sql();
    expect(text).toMatch(/join public\.users u on u\.id = c\.user_id/i);
    expect(text).toMatch(/v_body := '@' \|\| btrim\(v_actor\) \|\| ' ' \|\| v_body/i);
  });

  it("marks only the token owner's source notification read", () => {
    expect(sql()).toMatch(
      /update public\.notifications\s+set read = 1\s+where id = v_token\.notification_id and user_id = v_token\.user_id/i,
    );
  });

  it("keeps the consume RPC service-role only", () => {
    const text = sql();
    expect(text).toMatch(
      /revoke all on function public\.findback_consume_reply_token_and_add_comment\(text, text\)\s*from public, anon, authenticated/i,
    );
    expect(text).toMatch(
      /grant execute on function public\.findback_consume_reply_token_and_add_comment\(text, text\) to service_role/i,
    );
  });
});
