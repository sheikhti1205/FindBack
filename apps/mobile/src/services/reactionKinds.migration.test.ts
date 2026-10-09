import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(process.cwd(), "../..");
const MIGRATION = resolve(REPO_ROOT, "supabase/migrations/20261009030000_reaction_kinds.sql");

function sql(): string {
  return readFileSync(MIGRATION, "utf8");
}

describe("reaction kinds migration (W3.3)", () => {
  it("is additive/non-destructive", () => {
    const text = sql();
    expect(text).not.toMatch(/drop table/i);
    expect(text).not.toMatch(/drop column/i);
    expect(text).not.toMatch(/truncate table/i);
  });

  it("widens reactions.type while retaining LIKE/DISLIKE", () => {
    const text = sql();
    expect(text).toMatch(/add constraint reactions_type_check/i);
    expect(text).toMatch(/'LIKE', 'DISLIKE', 'LOVE', 'HELPFUL', 'SUPPORT', 'WOW'/);
    expect(text).toMatch(/drop constraint %I/i);
  });

  it("creates comment_reactions with cascade FKs, a unique pair and RLS", () => {
    const text = sql();
    expect(text).toMatch(/create table if not exists public\.comment_reactions/i);
    expect(text).toMatch(/comment_id text not null references public\.comments\(id\) on delete cascade/i);
    expect(text).toMatch(/user_id text not null references public\.users\(id\) on delete cascade/i);
    expect(text).toMatch(/unique \(comment_id, user_id\)/i);
    expect(text).toMatch(/alter table public\.comment_reactions enable row level security/i);
  });

  it("grants the narrow client surface and revokes anon", () => {
    const text = sql();
    expect(text).toMatch(/revoke all on public\.comment_reactions from anon, authenticated/i);
    expect(text).toMatch(/grant select \(id, comment_id, type\) on public\.comment_reactions to authenticated/i);
    expect(text).toMatch(/grant insert on public\.comment_reactions to authenticated/i);
    expect(text).toMatch(/grant delete on public\.comment_reactions to authenticated/i);
  });

  it("ships owner-only insert/delete plus a read policy mirroring reactions", () => {
    const text = sql();
    expect(text).toMatch(
      /create policy comment_reactions_insert_own[\s\S]*?user_id = \(select auth\.uid\(\)\)::text/i,
    );
    expect(text).toMatch(
      /create policy comment_reactions_delete_own[\s\S]*?using \(user_id = \(select auth\.uid\(\)\)::text\)/i,
    );
    expect(text).toMatch(/create policy comment_reactions_select_authenticated/i);
  });

  it("returns per-kind counts from findback_react_client and keeps legacy columns", () => {
    const text = sql();
    expect(text).toMatch(/drop function if exists public\.findback_react_client\(text, text\)/i);
    expect(text).toMatch(/like_count bigint,/);
    expect(text).toMatch(/dislike_count bigint,/);
    expect(text).toMatch(/reaction_counts jsonb/);
    expect(text).toMatch(/case when r\.type = 'LIKE' then 'LOVE' else r\.type end/i);
  });

  it("adds a SECURITY DEFINER comment react RPC with search_path and anon revoke", () => {
    const text = sql();
    expect(text).toMatch(
      /create or replace function public\.findback_react_comment_client\(p_comment_id text, p_type text\)/i,
    );
    expect(text).toMatch(/language plpgsql\s+security definer\s+set search_path = public, pg_temp/i);
    expect(text).toMatch(
      /revoke all on function public\.findback_react_comment_client\(text, text\) from public, anon/i,
    );
    expect(text).toMatch(
      /grant execute on function public\.findback_react_comment_client\(text, text\) to authenticated/i,
    );
    expect(text).toMatch(/cr\.user_id = v_uid/);
  });

  it("extends the comment list RPC, preserving every existing column", () => {
    const text = sql();
    expect(text).toMatch(/drop function if exists public\.findback_list_comments_client\(text\)/i);
    expect(text).toMatch(/parent_id text,/);
    expect(text).toMatch(/depth integer,/);
    expect(text).toMatch(/author_created_at text,\s+reaction_counts jsonb,\s+my_reaction text/i);
    expect(text).toMatch(
      /md5\('comment_reaction\|' \|\| c\.id \|\| '\|' \|\| \(select auth\.uid\(\)\)::text\)/i,
    );
  });

  it("broadcasts comment reaction changes on the post topic with commentId", () => {
    const text = sql();
    expect(text).toMatch(
      /create or replace function public\.findback_broadcast_comment_reaction_change\(\)/i,
    );
    expect(text).toMatch(/'reaction:changed', 'post:' \|\| v_post, true/i);
    expect(text).toMatch(/'commentId', v_comment/);
    expect(text).toMatch(
      /create trigger trg_findback_broadcast_comment_reaction[\s\S]*?on public\.comment_reactions/i,
    );
  });

  it("keeps the post reaction broadcast keys and adds reactionCounts", () => {
    const text = sql();
    expect(text).toMatch(/'likeCount', v_like/);
    expect(text).toMatch(/'dislikeCount', v_dislike/);
    expect(text).toMatch(/'reactionCounts', v_counts/);
  });

  it("uses the deterministic comment reaction id for writes", () => {
    const text = sql();
    expect(text).toMatch(/md5\('comment_reaction\|' \|\| p_comment_id \|\| '\|' \|\| v_uid\)/i);
  });
});
