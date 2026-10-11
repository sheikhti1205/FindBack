import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// File-relative (not process.cwd()): the suite also passes when invoked
// from the repo root or another cwd.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const MIGRATION = resolve(
  REPO_ROOT,
  "supabase/migrations/20261011000000_reaction_notification_feed.sql",
);
const FIX_MIGRATION = resolve(
  REPO_ROOT,
  "supabase/migrations/20261011010000_reaction_notification_fix.sql",
);

function sql(): string {
  return readFileSync(MIGRATION, "utf8");
}

function fixSql(): string {
  return readFileSync(FIX_MIGRATION, "utf8");
}

describe("reaction/notification/feed migration (W1-A: FBX-009/010/011)", () => {
  it("is additive/non-destructive and never edits an applied migration", () => {
    const text = sql();
    expect(text).not.toMatch(/drop table/i);
    expect(text).not.toMatch(/drop column/i);
    expect(text).not.toMatch(/truncate table/i);
    // The only row delete is the reaction-switch supersede inside the
    // trigger (same as the pre-existing trigger); no data wipe anywhere.
    const deletes = text.match(/delete from public\.\w+/gi) ?? [];
    expect(deletes).toEqual(["delete from public.notifications"]);
  });

  it("widens the notification CHECK with REACTION while keeping LIKE/DISLIKE compat", () => {
    const text = sql();
    expect(text).toMatch(/'LIKE', 'DISLIKE', 'COMMENT', 'MENTION', 'STATUS', 'REACTION'/);
  });

  it("adds a nullable reaction_kind column to notifications", () => {
    const text = sql();
    expect(text).toMatch(/add column if not exists reaction_kind/i);
  });

  it("forwards canonical kinds as REACTION with reaction_kind and keeps LIKE/DISLIKE verbatim", () => {
    const text = sql();
    expect(text).toMatch(/findback_notify_reaction/);
    expect(text).toMatch(/'REACTION'/);
    expect(text).toMatch(/reaction_kind/);
    // Legacy kinds still forward verbatim (compat).
    expect(text).toMatch(/p_type in \('LIKE', 'DISLIKE'\)|new\.type in \('LIKE', 'DISLIKE'\)/i);
  });

  it("dedupes reaction switches across LIKE/DISLIKE/REACTION on active unread rows", () => {
    const text = sql();
    expect(text).toMatch(/n\.type in \('LIKE', 'DISLIKE', 'REACTION'\)/);
    expect(text).toMatch(/n\.read = 0/);
    expect(text).toMatch(/n\.deleted_at is null/);
  });

  it("returns reaction_kind from the inbox RPC", () => {
    const text = sql();
    expect(text).toMatch(/findback_list_notifications_client/);
    expect(text).toMatch(/reaction_kind/);
  });

  it("returns canonical reaction_counts + total + my_reaction from both feed RPCs", () => {
    const text = sql();
    expect(text).toMatch(/findback_query_posts_client/);
    expect(text).toMatch(/findback_query_posts_nearby_client/);
    expect(text).toMatch(/reaction_counts jsonb/);
    expect(text).toMatch(/reaction_total bigint/);
    expect(text).toMatch(/my_reaction text/);
    // Single canonical LIKE->LOVE fold in the feed aggregates.
    expect(text).toMatch(/case when r\.type = 'LIKE' then 'LOVE' else r\.type end/i);
    // Legacy like/dislike columns stay as compat.
    expect(text).toMatch(/like_count bigint/);
    expect(text).toMatch(/dislike_count bigint/);
  });

  it("carries display_order in attachment JSON and orders by it with deterministic ties", () => {
    const text = sql();
    expect(text).toMatch(/'display_order', a\.display_order/);
    expect(text).toMatch(/order by a\.display_order asc/i);
  });

  it("keeps SECURITY INVOKER + authenticated-only grants on the rebuilt feed RPCs", () => {
    const text = sql();
    expect(text).toMatch(/security invoker/i);
    expect(text).toMatch(
      /grant execute on function public\.findback_query_posts_client\([\s\S]*?to authenticated/i,
    );
    expect(text).toMatch(
      /grant execute on function public\.findback_query_posts_nearby_client\([\s\S]*?to authenticated/i,
    );
    expect(text).toMatch(/set search_path = public, pg_temp/i);
  });
});

describe("reaction notification fix migration (W1-A-FIX: kind-switch-after-read)", () => {
  it("never edits the pushed base migration and stays additive/non-destructive", () => {
    const text = fixSql();
    expect(text).not.toMatch(/drop table/i);
    expect(text).not.toMatch(/drop column/i);
    expect(text).not.toMatch(/truncate table/i);
    expect(text).not.toMatch(/delete from public\.\w+/i);
    expect(text).toMatch(/create or replace function public\.findback_insert_notification/);
  });

  it("keeps the 7-argument signature, defaults, guards, and grants unchanged", () => {
    const text = fixSql();
    expect(text).toMatch(/p_reaction_kind text default null/);
    expect(text).toMatch(/p_user_id is null or p_user_id = p_actor_id/);
    expect(text).toMatch(/p_actor_id is null and p_type <> 'STATUS'/);
    expect(text).toMatch(/revoke all on function\s+public\.findback_insert_notification/);
  });

  it("keys the REACTION dedupe on kind so a switch after read notifies (decision a)", () => {
    const text = fixSql();
    // Different kind after read inserts (LOVE history never blocks WOW);
    // same-kind re-reacts stay suppressed; other types dedupe as before.
    expect(text).toMatch(/p_type <> 'REACTION'/);
    expect(text).toMatch(/n\.reaction_kind is not distinct from p_reaction_kind/);
  });

  it("no longer claims read rows block re-notify exactly like LIKE/DISLIKE", () => {
    const text = fixSql();
    expect(text).not.toMatch(/exactly like LIKE\/DISLIKE/);
  });
});
