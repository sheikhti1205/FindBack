import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(process.cwd(), "../..");
const MIGRATION = resolve(REPO_ROOT, "supabase/migrations/20261011040000_least_privilege_grants.sql");

function sql(): string {
  return readFileSync(MIGRATION, "utf8");
}

/**
 * FBX-034 — the push/notification tables are server-only (SECURITY DEFINER
 * RPCs + service-role push dispatch). `20261002050000_push_hardening.sql`
 * revoked DML on the three push tables and only SELECT on `notifications`,
 * leaving INSERT/UPDATE/DELETE grants on `notifications` open to
 * anon/authenticated and TRUNCATE/TRIGGER/REFERENCES open everywhere. This
 * migration closes that retroactively.
 */
describe("least-privilege grants migration (FBX-034)", () => {
  it("strips every anon/authenticated grant on the four server-only tables", () => {
    const text = sql();
    for (const table of ["notifications", "device_tokens", "notification_preferences", "push_reply_tokens"]) {
      expect(text).toMatch(new RegExp(`revoke all on public\\.${table} from anon, authenticated`, "i"));
    }
  });

  it("closes the notifications INSERT/UPDATE/DELETE hole that push_hardening left open", () => {
    const text = sql();
    // push_hardening only did `revoke select on public.notifications`; the
    // default Supabase ACL still granted anon/authenticated INSERT, UPDATE
    // and DELETE. `revoke all` is the only statement that closes all of them.
    expect(text).toMatch(/revoke all on public\.notifications from anon, authenticated/i);
    expect(text).not.toMatch(/grant (select|insert|update|delete|all)[^\n]* to (anon|authenticated)/i);
  });

  it("touches no client-reachable table or function grant", () => {
    const text = sql();
    // Over-reach guard: client tables keep their own narrow grants, and this
    // migration must not rewrite any function EXECUTE surface (RPC grants are
    // function-level and were already correct in their source migrations).
    for (const table of ["item_posts", "comments", "users", "comment_attachments", "comment_reactions"]) {
      expect(text).not.toMatch(new RegExp(`revoke[^\\n]*\\bpublic\\.${table}\\b`, "i"));
      expect(text).not.toMatch(new RegExp(`grant[^\\n]*\\bpublic\\.${table}\\b`, "i"));
    }
    expect(text).not.toMatch(/grant execute/i);
    expect(text).not.toMatch(/revoke[^ ]* execute/i);
  });
});
