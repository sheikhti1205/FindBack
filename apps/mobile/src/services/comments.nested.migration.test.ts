import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(process.cwd(), "../..");
const MIGRATION = resolve(REPO_ROOT, "supabase/migrations/20261002030000_nested_comments.sql");

function sql(): string {
  return readFileSync(MIGRATION, "utf8");
}

describe("nested comments migration", () => {
  it("adds a self-referential parent and a bounded depth", () => {
    const text = sql();
    expect(text).toMatch(/add column if not exists parent_id text references public\.comments\(id\) on delete cascade/i);
    expect(text).toMatch(/add column if not exists depth integer not null default 0/i);
    expect(text).toMatch(/create index if not exists idx_comments_parent/i);
  });

  it("replaces both comment RPCs so PostgREST resolves one signature", () => {
    const text = sql();
    expect(text).toMatch(/drop function if exists public\.findback_list_comments_client\(text\)/i);
    expect(text).toMatch(/drop function if exists public\.findback_add_comment_client\(text, text\)/i);
    expect(text).toMatch(/p_parent_id text default null/i);
  });

  it("validates the parent belongs to the same report and caps depth at 5", () => {
    const text = sql();
    expect(text).toMatch(/Parent comment belongs to another report/i);
    expect(text).toMatch(/if v_parent_depth >= 5 then/i);
    expect(text).toMatch(/Reply depth exceeded/i);
  });

  it("notifies the parent author and skips duplicate/self notifications", () => {
    const text = sql();
    expect(text).toMatch(/v_parent_author is distinct from v_owner/i);
    expect(text).toMatch(/v_mentioned_id is not distinct from v_parent_author/i);
  });

  it("is superseded by the content-free comment:invalidate emission", () => {
    // 20261002030000 is an immutable historical file, so this test used to keep
    // asserting a public `comment:added` broadcast that no longer runs. The
    // comment-isolation wave replaced that emission with a content-free
    // invalidation; this now pins the current contract and records that the old
    // one is gone, rather than leaving misleading green coverage behind.
    const current = readFileSync(
      resolve(REPO_ROOT, "supabase/migrations/20261024010000_comment_isolation.sql"),
      "utf8",
    );
    expect(current).not.toMatch(/'comment:added'/);
    expect(current).toMatch(/'comment:invalidate','post:'\|\|v_post,true/);
    expect(current).toMatch(/'postId',v_post,'entity','comment','invalidate',true,'op',tg_op/);
    const start = current.indexOf("create or replace function public.findback_broadcast_comment_change");
    expect(start).toBeGreaterThan(-1);
    const triggerBody = current.slice(
      start,
      current.indexOf("revoke all on function public.findback_broadcast_comment_change", start),
    );
    // A shared room may carry no body, author, child id or reaction counts.
    expect(triggerBody).not.toMatch(/body|user_id|author|reaction/);
  });
});
