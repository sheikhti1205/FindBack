import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(process.cwd(), "../..");
const MIGRATION = resolve(REPO_ROOT, "supabase/migrations/20261002010000_notifications_realtime_broadcast.sql");

function sql(): string {
  return readFileSync(MIGRATION, "utf8");
}

describe("notifications realtime migration", () => {
  it("broadcasts a data-free signal on the recipient's private topic", () => {
    const text = sql();
    expect(text).toMatch(/function public\.findback_broadcast_notification/);
    expect(text).toMatch(/'notification:' \|\| new\.user_id/);
    expect(text).toMatch(/'notification:added'/);
    expect(text).toMatch(/'op', 'insert'/);
    // Private channel, and the payload deliberately carries no report data.
    expect(text).toMatch(/\btrue\s*\)\s*;/);
    const payload = text.match(/jsonb_build_object\(([^)]*)\)/)?.[1] ?? "";
    expect(payload).toMatch(/'op', 'insert'/);
    expect(payload).not.toMatch(/preview|actor|post|comment/);
  });

  it("fires after insert on notifications and is locked down", () => {
    const text = sql();
    expect(text).toMatch(/create trigger trg_findback_broadcast_notification/i);
    expect(text).toMatch(/after insert on public\.notifications/i);
    expect(text).toMatch(/revoke all on function public\.findback_broadcast_notification\(\) from public, anon, authenticated/i);
    expect(text).toMatch(/security definer/i);
  });
});
