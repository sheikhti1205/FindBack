import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(process.cwd(), "../..");
const MIGRATION = resolve(REPO_ROOT, "supabase/migrations/20261002040000_push_reply_tokens.sql");

function sql(): string {
  return readFileSync(MIGRATION, "utf8");
}

describe("push reply tokens migration", () => {
  it("stores only hashed, scoped, expiring tokens", () => {
    const text = sql();
    expect(text).toMatch(/create table if not exists public\.push_reply_tokens/i);
    expect(text).toMatch(/token_hash text not null unique/i);
    expect(text).toMatch(/user_id text not null references public\.users\(id\)/i);
    expect(text).toMatch(/parent_comment_id text not null references public\.comments\(id\)/i);
    expect(text).toMatch(/expires_at text not null/i);
    expect(text).toMatch(/used_at text/i);
  });

  it("is service-role only: RLS on, no policies, no client grants", () => {
    const text = sql();
    expect(text).toMatch(/alter table public\.push_reply_tokens enable row level security/i);
    expect(text).not.toMatch(/create policy/i);
    expect(text).not.toMatch(/grant .* to authenticated/i);
  });
});
