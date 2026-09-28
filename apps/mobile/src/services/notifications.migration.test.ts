import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(process.cwd(), "../..");
const MIGRATION = resolve(REPO_ROOT, "supabase/migrations/20260928000000_notifications.sql");

function sql(): string {
  return readFileSync(MIGRATION, "utf8");
}

describe("notifications migration sanity", () => {
  it("creates the notifications table with the inbox columns", () => {
    const text = sql();
    expect(text).toMatch(/create table if not exists public\.notifications/i);
    for (const column of [
      "user_id",
      "actor_id",
      "post_id",
      "comment_id",
      "preview",
      "created_at",
    ]) {
      expect(text, `column ${column} present`).toMatch(new RegExp(`\\b${column}\\b`));
    }
    expect(text).toMatch(/type in \('LIKE', 'DISLIKE', 'COMMENT', 'MENTION', 'STATUS'\)/);
    expect(text).toMatch(/read integer not null default 0/);
  });

  it("enables RLS with no policies on notifications", () => {
    const text = sql();
    expect(text).toMatch(/alter table public\.notifications enable row level security/i);
    expect(text).not.toMatch(/create policy/i);
  });

  it("notifies on reaction insert and skips self-notify", () => {
    const text = sql();
    expect(text).toMatch(/create trigger trg_findback_notify_reaction/i);
    expect(text).toMatch(/after insert on public\.reactions/i);
    expect(text).toMatch(/security definer/i);
    expect(text).toMatch(/v_owner = new\.user_id/);
  });

  it("keeps reaction switches to one current row", () => {
    const text = sql();
    // The reaction trigger deletes the actor's superseded UNREAD
    // LIKE/DISLIKE row on the same post before inserting the new one.
    expect(text).toMatch(/n\.type in \('LIKE', 'DISLIKE'\)/);
    expect(text).toMatch(/n\.read = 0/);
  });

  it("notifies the post owner on status change with a null-actor STATUS row", () => {
    const text = sql();
    expect(text).toMatch(/function public\.findback_notify_status/);
    expect(text).toMatch(/create trigger trg_findback_notify_status/i);
    expect(text).toMatch(/after update of status on public\.item_posts/i);
    expect(text).toMatch(/'MATCHED', 'RECOVERED', 'CLOSED'/);
    expect(text).toMatch(/Your report status changed to /);
    // STATUS rows carry no actor: the column is nullable and the inbox
    // join keeps actor-less rows.
    expect(text).toMatch(/alter column actor_id drop not null/i);
    expect(text).toMatch(/left join public\.users u on u\.id = n\.actor_id/i);
  });

  it("notifies the post owner on comment insert and fans out @mentions", () => {
    const text = sql();
    expect(text).toMatch(/create trigger trg_findback_notify_comment/i);
    expect(text).toMatch(/after insert on public\.comments/i);
    expect(text).toMatch(/'COMMENT'/);
    expect(text).toMatch(/'MENTION'/);
    expect(text).toMatch(/regexp_matches/);
    expect(text).toMatch(/lower\(u\.username\) = lower\(v_handle\)/);
  });

  it("exposes the three client RPCs to authenticated only", () => {
    const text = sql();
    for (const rpc of [
      "findback_list_notifications_client",
      "findback_notification_count_client",
      "findback_mark_notifications_read_client",
    ]) {
      expect(text, `${rpc} defined`).toMatch(new RegExp(`function public\\.${rpc}`));
      expect(text, `${rpc} granted to authenticated`).toMatch(
        new RegExp(`grant execute on function public\\.${rpc}[\\s\\S]*? to authenticated`),
      );
      expect(text, `${rpc} revoked from anon`).toMatch(
        new RegExp(`revoke all on function public\\.${rpc}[\\s\\S]*?from public, anon`),
      );
    }
    expect(text).toMatch(/actor_username/);
    expect(text).toMatch(/post_title/);
  });
});
