/**
 * Static migration/parity checks for the L-BACKEND completion pass.
 *
 * No database, no network, no secrets: parses the migration SQL text and the
 * delete-account source and asserts the spec-25/26/27 + D-section invariants
 * that must hold statically. Live behavior stays LIVE-PENDING (see
 * supabase/tests/verify_*.sql and supabase/tests/run-live.sh).
 *
 * Run: node --test supabase/tests/migration_parity.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIG = join(ROOT, "migrations");
const read = (p) => readFileSync(p, "utf8");
const mig = (name) => read(join(MIG, name));
const ls = () => readdirSync(MIG).filter((f) => f.endsWith(".sql")).sort();

const NEW_PHONE = "20261012010000_phone_cooldown_hardening.sql";
const NEW_ATTACH = "20261012020000_comment_attachments_parity.sql";

describe("migration hygiene (additive, live-pending)", () => {
  it("new files follow the 20261012*_*.sql grant window", () => {
    const names = ls();
    assert.ok(names.includes(NEW_PHONE), "phone hardening migration present");
    assert.ok(names.includes(NEW_ATTACH), "comment parity migration present");
    assert.ok(names.indexOf(NEW_PHONE) > names.indexOf("20261012000000_phone_cooldown_avatar_key.sql"));
  });

  it("new migrations carry a LIVE-PENDING header + verification pointer", () => {
    for (const name of [NEW_PHONE, NEW_ATTACH]) {
      const sql = mig(name);
      assert.ok(sql.includes("LIVE-PENDING"), `${name}: LIVE-PENDING note`);
      assert.ok(sql.includes("supabase/tests/verify_"), `${name}: verification SQL pointer`);
      assert.ok(sql.includes("ADDITIVE ONLY"), `${name}: additive header`);
    }
  });

  it("new migrations never drop tables/columns, delete rows, or edit applied files", () => {
    for (const name of [NEW_PHONE, NEW_ATTACH]) {
      const sql = mig(name).toLowerCase();
      assert.ok(!sql.includes("drop table"), `${name}: no DROP TABLE`);
      assert.ok(!sql.includes("drop column"), `${name}: no DROP COLUMN`);
      assert.ok(!/^(\s|.*\(.*)?delete\s+from\s/m.test(sql), `${name}: no DELETE FROM`);
      assert.ok(!sql.includes("truncate"), `${name}: no TRUNCATE`);
    }
  });

  it("every new SECURITY DEFINER function locks search_path", () => {
    for (const name of [NEW_PHONE, NEW_ATTACH]) {
      const sql = mig(name);
      const definers = (sql.match(/security definer/gi) ?? []).length;
      const paths = (sql.match(/set search_path = public, pg_temp/gi) ?? []).length;
      assert.ok(definers > 0, `${name}: has definer functions`);
      assert.equal(paths, definers, `${name}: every definer locks search_path`);
    }
  });
});

describe("spec-25 phone cooldown (full machine)", () => {
  const base = () => mig("20261012000000_phone_cooldown_avatar_key.sql");
  const hard = () => mig(NEW_PHONE);

  it("base records verified/change/eligible state; first + same-phone never wait", () => {
    assert.ok(base().includes("phone_verified_at"), "first-verification stamp column");
    assert.ok(base().includes("phone_last_changed_at"), "last-replacement stamp column");
    assert.ok(base().includes("phone_change_eligible_at"), "eligible-at column");
    assert.ok(base().includes("PHONE_CHANGE_COOLDOWN"), "stable reject code");
    assert.ok(base().includes("now()"), "server clock (no client clock)");
  });

  it("hardening parses eligible_at safely (corrupt value reads eligible, never 500)", () => {
    assert.ok(hard().includes("findback_safe_eligible_at"), "safe-parse helper");
    assert.ok(hard().includes("exception when others"), "catches every cast failure");
    assert.match(hard(), /phone_change_eligibility[\s\S]*findback_safe_eligible_at/, "eligibility uses helper");
    assert.match(hard(), /request_phone_change[\s\S]*findback_safe_eligible_at/, "gate uses helper");
    const code = hard().replace(/--[^\n]*/g, "");
    const casts = (code.match(/::timestamptz/g) ?? []).length;
    assert.equal(casts, 1, `only the guarded helper casts (found ${casts})`);
  });

  it("hardening serializes concurrent gate evaluations per account", () => {
    assert.ok(hard().includes("pg_advisory_xact_lock"), "advisory xact lock");
    assert.ok(hard().includes("fb-phone-change:"), "per-account lock key");
  });

  it("client grants preserved: authenticated EXECUTE, anon revoked, helper ungranted", () => {
    for (const sql of [base(), hard()]) {
      assert.ok(sql.includes("grant execute on function public.request_phone_change(text) to authenticated"));
      assert.ok(sql.includes("revoke execute on function public.request_phone_change(text) from anon"));
      assert.ok(sql.includes("grant execute on function public.phone_change_eligibility() to authenticated"));
    }
    assert.ok(hard().includes("revoke all on function public.findback_safe_eligible_at(text)"));
  });
});

describe("spec-26 comment attachments (parity)", () => {
  const sql = () => mig(NEW_ATTACH);

  it("kind vocabulary covers the spec picks including sticker", () => {
    assert.ok(sql().includes("'photo', 'video', 'gif', 'sticker'"), "widened kind check");
  });

  it("provenance columns exist for provider, size, dims, preview", () => {
    for (const col of ["provider", "mime_type", "file_name", "file_size", "width", "height", "preview_url"]) {
      assert.ok(sql().includes(`add column if not exists ${col}`), `column ${col}`);
    }
  });

  it("coherence is DB-enforced, NOT VALID (no live scan on apply)", () => {
    for (const con of [
      "comment_attachments_provider_check",
      "comment_attachments_provider_source_check",
      "comment_attachments_owned_key_check",
      "comment_attachments_slug_shape_check",
      "comment_attachments_url_https_check",
      "comment_attachments_size_check",
      "comment_attachments_dims_check",
    ]) {
      assert.ok(sql().includes(con), `constraint ${con}`);
    }
    const notValid = (sql().match(/not valid/gi) ?? []).length;
    assert.ok(notValid >= 7, `all coherence checks NOT VALID (found ${notValid})`);
    assert.ok(sql().includes("user_id || '/'"), "local key pinned under owner directory");
    assert.ok(sql().includes("position('..' in storage_path) = 0"), "traversal rejected");
    assert.ok(sql().includes("25000000"), "size ceiling agrees with bucket cap");
  });

  it("comment list returns display_order-ranked public-safe attachment JSON", () => {
    assert.ok(sql().includes("order by a.display_order asc, a.created_at asc, a.id asc"), "deterministic order");
    assert.ok(!sql().includes("'storage_path', a.storage_path"), "no storage_path leak");
    assert.ok(!sql().includes("'user_id', a.user_id"), "no user_id leak");
    assert.ok(sql().includes("grant execute on function public.findback_list_comments_client(text) to authenticated"));
  });

  it("atomic create RPC validates staged descriptors and persists nothing on reject", () => {
    assert.ok(sql().includes("findback_add_comment_with_attachments"), "atomic RPC");
    assert.ok(sql().includes("At most 4 attachments"), "4-descriptor cap");
    assert.ok(sql().includes("foreign storage key"), "foreign staged key reject");
    assert.ok(sql().includes("attachment needs an https url"), "arbitrary URL reject");
    assert.ok(sql().includes("invalid attachment order"), "duplicate/out-of-range order reject");
  });

  it("orphan-byte cleanup queue + service-role-only claim exist", () => {
    assert.ok(sql().includes("comment_media_cleanup_queue"), "queue table");
    assert.ok(sql().includes("comment_attachments_cleanup_enqueue"), "delete trigger");
    assert.ok(sql().includes("grant execute on function public.claim_comment_media_cleanup(integer) to service_role"));
    assert.ok(sql().includes("revoke all on public.comment_media_cleanup_queue from anon, authenticated"));
  });
});

describe("D-section: prior migrations already closed (guarded against regress)", () => {
  it("both feed RPCs order attachments by display_order with deterministic ties", () => {
    const feed = mig("20261011000000_reaction_notification_feed.sql");
    const ordered = (feed.match(/order by a\.display_order asc, a\.created_at asc, a\.id asc/g) ?? []).length;
    assert.equal(ordered, 2, `normal + nearby feed RPCs (found ${ordered})`);
    assert.ok(feed.includes("'display_order', a.display_order"), "display_order exposed");
  });

  it("avatar-key binding: owned-key writer + cross-uid/traversal rejects", () => {
    const av = mig("20261012000000_phone_cooldown_avatar_key.sql");
    assert.ok(av.includes("update_my_avatar_by_key"), "key writer");
    assert.ok(av.includes("position('..' in v_key) > 0"), "traversal reject");
    assert.ok(av.includes("avatar object not found"), "existence check");
  });

  it("least-privilege revokes never touch reads or RPC EXECUTE", () => {
    const lp = mig("20261011040000_least_privilege_grants.sql");
    const code = lp.replace(/--[^\n]*/g, ""); // prose mentions revokes; check code only
    assert.ok(!/revoke[^\n]*execute/i.test(code), "no EXECUTE revoke");
    assert.ok(!/revoke\s+select\b/i.test(code), "no SELECT revoke (only full-table revokes)");
    for (const t of ["notifications", "device_tokens", "notification_preferences", "push_reply_tokens"]) {
      assert.ok(lp.includes(`revoke all on public.${t} from anon, authenticated`), `revoke ${t}`);
    }
  });

  it("reaction vocabulary + REACTION notification type widened, history preserved", () => {
    const kinds = mig("20261009030000_reaction_kinds.sql");
    assert.ok(kinds.includes("LOVE', 'HELPFUL', 'SUPPORT', 'WOW"), "canonical kinds");
    const feed = mig("20261011000000_reaction_notification_feed.sql");
    assert.ok(feed.includes("'LIKE', 'DISLIKE', 'COMMENT', 'MENTION', 'STATUS', 'REACTION'"), "type widen keeps history");
  });
});

describe("delete-account namespace registry + pagination", () => {
  const src = () => read(join(ROOT, "functions", "delete-account", "index.ts"));

  it("registry covers report photos, avatars, comment media", () => {
    assert.ok(src().includes("findback-comment-media"), "comment namespace registered");
    assert.ok(src().includes("avatars/${uid}/"), "avatar prefix registered");
    assert.ok(src().includes("COVERAGE RULE"), "bucket/prefix coverage rule documented in-file");
  });

  it("sweep lists at offset 0 until empty (never offset-walks)", () => {
    assert.ok(src().includes("offset: 0"), "offset-0 listing");
    assert.ok(!/offset\s*\+|offset\s*\+=/.test(src()), "no offset arithmetic");
  });
});

describe("FBX-022 server mirror: avatar URL host bind (20261012030000)", () => {
  const sql = () => mig("20261012030000_avatar_url_host_bind.sql");

  it("exact host+path predicate exists with locked grants", () => {
    assert.ok(sql().includes("is_own_avatar_public_url"), "predicate");
    assert.ok(sql().includes("^[a-z0-9-]+\\.supabase\\.co$"), "single-label host bind");
    assert.ok(sql().includes("/storage/v1/object/public/findback-images/avatars/"), "exact path prefix");
    assert.ok(sql().includes("grant execute on function public.is_own_avatar_public_url(text, text) to authenticated"), "grants");
  });

  it("both avatar RPCs re-replaced through the predicate (no marker-substring check left)", () => {
    assert.ok(sql().includes("create or replace function public.update_my_avatar("), "legacy RPC re-replaced");
    assert.ok(sql().includes("create or replace function public.update_my_avatar_by_key("), "key RPC re-replaced");
    assert.ok(!sql().includes("position('/findback-images/'"), "old marker check gone");
    assert.ok(!sql().includes("position(v_marker in v_avatar)"), "old marker check gone (legacy)");
  });
});

describe("comment-media cleanup lease/ack redesign (20261013020000)", () => {
  const NEW_LEASE = "20261013020000_comment_media_cleanup_lease.sql";
  const sql = () => mig(NEW_LEASE);
  const consumer = () => read(join(ROOT, "functions", "cleanup-comment-media", "index.ts"));

  it("new migration present, additive, live-pending with verification pointer", () => {
    assert.ok(ls().includes(NEW_LEASE), "lease migration present");
    assert.ok(ls().indexOf(NEW_LEASE) > ls().indexOf(NEW_ATTACH), "lease lands after the queue migration");
    assert.ok(sql().includes("LIVE-PENDING"), "live-pending note");
    assert.ok(sql().includes("supabase/tests/verify_20261013020000_cleanup_lease.sql"), "verification pointer");
    assert.ok(sql().includes("ADDITIVE ONLY"), "additive header");
    const lower = sql().toLowerCase();
    assert.ok(!lower.includes("drop table"), "no DROP TABLE");
    assert.ok(!lower.includes("drop column"), "no DROP COLUMN");
    assert.ok(!lower.includes("truncate"), "no TRUNCATE");
  });

  it("claim uses lease columns (marks-not-deletes, stale reclaim, skip locked)", () => {
    assert.ok(sql().includes("add column if not exists leased_at"), "leased_at column");
    assert.ok(sql().includes("add column if not exists attempts"), "attempts column");
    assert.ok(sql().includes("leased_at = now()"), "claim stamps the lease");
    assert.ok(sql().includes("attempts = q.attempts + 1"), "claim counts the attempt");
    assert.ok(sql().includes("interval '15 minutes'"), "15-minute stale window");
    assert.ok(sql().toLowerCase().includes("skip locked"), "concurrent sweepers skip locked rows");
    const claimDef = sql().slice(
      sql().indexOf("create or replace function public.claim_comment_media_cleanup"),
      sql().indexOf("comment on function public.claim_comment_media_cleanup"),
    );
    assert.ok(!/delete\s+from/i.test(claimDef), "claim body holds no DELETE (old hole closed)");
  });

  it("ack companion exists (deletes only listed keys, capped, no-op on empty)", () => {
    assert.ok(sql().includes("create or replace function public.ack_comment_media_cleanup(p_keys text[])"), "ack function");
    assert.ok(sql().toLowerCase().includes("storage_key = any"), "ack deletes only listed keys");
    assert.ok(sql().includes("max 1000 keys"), "ack batch cap");
  });

  it("no grants to anon/authenticated on new objects; definer functions lock search_path", () => {
    const code = sql().replace(/--[^\n]*/g, "");
    assert.ok(!/grant[^\n;]*to\s+(anon|authenticated)/i.test(code), "no client grants in code");
    assert.ok(sql().includes("grant execute on function public.claim_comment_media_cleanup(integer) to service_role"), "claim service-role-only");
    assert.ok(sql().includes("grant execute on function public.ack_comment_media_cleanup(text[]) to service_role"), "ack service-role-only");
    assert.ok(sql().includes("revoke all on public.comment_media_cleanup_queue from anon, authenticated"), "queue stays client-denied");
    const definers = (sql().match(/security definer/gi) ?? []).length;
    const paths = (sql().match(/set search_path = public, pg_temp/gi) ?? []).length;
    assert.equal(paths, definers, "every definer locks search_path");
  });

  it("enqueue trigger path untouched (same trigger, same conflict-tolerant insert)", () => {
    assert.ok(!/drop\s+trigger/i.test(sql().replace(/--[^\n]*/g, "")), "no trigger drop");
    assert.ok(!sql().toLowerCase().includes("create trigger"), "no trigger recreate");
    assert.ok(!sql().includes("enqueue_comment_media_cleanup()"), "no enqueue helper re-replace");
  });

  it("consumer exists: lease drain with per-key isolation, ack-only-success, internal-only gate", () => {
    assert.ok(consumer().includes("claim_comment_media_cleanup"), "consumer claims");
    assert.ok(consumer().includes("ack_comment_media_cleanup"), "consumer acks");
    assert.ok(consumer().includes("CLEANUP_BUCKET"), "bucket constant");
    assert.ok(consumer().includes("findback-comment-media"), "sweeps the comment-media bucket");
    assert.ok(consumer().includes("remove([key])"), "per-key remove (bad-key isolation)");
    assert.ok(consumer().includes("x-cleanup-secret"), "cron-secret header gate");
    assert.ok(!consumer().includes("getUser"), "never resolves a user session (internal only)");
  });

  it("stale window agrees between SQL and consumer (15 minutes)", () => {
    assert.ok(sql().includes("interval '15 minutes'"), "SQL stale window");
    assert.ok(consumer().includes("STALE_LEASE_MINUTES = 15"), "consumer documents the same window");
  });
});

describe("FB-AUD-03 attachment UPDATE bind (20261013010000)", () => {
  const NEW_BIND = "20261013010000_comment_attachments_update_bind.sql";
  const sql = () => mig(NEW_BIND);
  const OWN_EXISTS =
    "exists (select 1 from public.comments c where c.id = comment_attachments.comment_id and c.user_id = (select auth.uid())::text)";

  it("update policy requires comment ownership in both USING and WITH CHECK (no reassignment hole)", () => {
    const text = sql();
    assert.ok(text.includes("comment_attachments_update_own"), "recreates the UPDATE policy");
    const usingIdx = text.indexOf("for update");
    assert.ok(usingIdx >= 0, "UPDATE policy clause present");
    const usingClause = text.slice(usingIdx, text.indexOf("with check", usingIdx));
    const checkClause = text.slice(text.indexOf("with check", usingIdx));
    for (const [name, clause] of [["USING", usingClause], ["WITH CHECK", checkClause]]) {
      assert.ok(clause.includes("user_id = (select auth.uid())::text"), `${name} keeps the owner check`);
      assert.ok(clause.includes(OWN_EXISTS), `${name} carries the comment-ownership EXISTS (INSERT pattern)`);
    }
  });

  it("supersede header documents FB-AUD-03; sibling policies and grants untouched", () => {
    const text = sql();
    assert.ok(text.includes("FB-AUD-03"), "audit id recorded");
    assert.ok(text.includes("20261011020000"), "superseded migration named");
    assert.ok(!text.toLowerCase().includes("comment_attachments_select_own"), "select policy untouched");
    assert.ok(!text.toLowerCase().includes("comment_attachments_insert_own"), "insert policy untouched");
    assert.ok(!text.toLowerCase().includes("comment_attachments_delete_own"), "delete policy untouched");
    assert.ok(!/grant\s+/i.test(text.replace(/--[^\n]*/g, "")), "no grants touched");
  });

  it("BACKEND_SCHEMA_VERSION bumped by coordinator to the new migration (appCapabilities parity)", () => {
    assert.ok(!sql().includes("BACKEND_SCHEMA_VERSION"), "migration carries no version constant");
    const caps = read(join(ROOT, "..", "apps", "mobile", "src", "services", "appCapabilities.ts"));
    assert.ok(caps.includes('BACKEND_SCHEMA_VERSION = "20261013010000"'), "coordinator bumped the advertised version to 20261013010000");
  });
});
