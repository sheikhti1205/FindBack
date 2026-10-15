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

describe("account-deletion storage fence (20261014010000)", () => {
  const FENCE = "20261014010000_account_deletion_storage_fence.sql";
  const sql = () => mig(FENCE);
  const consumer = () => read(join(ROOT, "functions", "delete-account", "index.ts"));
  const code = () => sql().replace(/--[^\n]*/g, "");

  it("additive, live-pending, verification pointer, and never destructive", () => {
    assert.ok(ls().includes(FENCE), "fence migration present");
    assert.ok(ls().indexOf(FENCE) > ls().indexOf("20261013020000_comment_media_cleanup_lease.sql"), "lands last");
    assert.ok(sql().includes("LIVE-PENDING"), "live-pending note");
    assert.ok(sql().includes("supabase/tests/verify_20261014010000_deletion_fence.sql"), "verification pointer");
    assert.ok(sql().includes("ADDITIVE ONLY"), "additive header");
    const lower = code().toLowerCase();
    assert.ok(!lower.includes("drop table"), "no DROP TABLE");
    assert.ok(!lower.includes("drop column"), "no DROP COLUMN");
    assert.ok(!lower.includes("truncate"), "no TRUNCATE");
    assert.ok(!/\bdelete\s+from\b/.test(lower), "no DELETE FROM");
    assert.ok(!/^begin;/m.test(sql()), "no explicit BEGIN (matches the CLI's own transaction)");
    assert.ok(!/^commit;/m.test(sql()), "no explicit COMMIT");
    assert.ok(!/alter table storage\.objects/i.test(code()), "never alters the storage table itself");
  });

  it("enforces at the privileged final-write boundary, not only via RLS", () => {
    const text = code();
    assert.ok(text.includes("create trigger findback_guard_storage_account_write"), "trigger created");
    assert.ok(/before insert or update on storage\.objects/.test(text), "fires on storage.objects insert/update");
    assert.ok(/for each row execute function public\.findback_guard_storage_account_write/.test(text), "row-level");
    assert.ok(!/tgisinternal/.test(text), "sanity: no internal-trigger trickery");
    assert.ok(text.includes("raise exception 'account deletion prevents storage writes'"), "refuses fenced writes");
    assert.ok(text.includes("raise exception 'account required for storage write'"), "fail-closed on unknown owner");
  });

  it("serializes through one shared advisory lock, and tolerates versioning removals", () => {
    const text = code();
    const locks = (text.match(/pg_advisory_xact_lock/g) ?? []).length;
    assert.ok(locks >= 2, "begin + trigger both take the lock");
    assert.ok(text.includes("hashtextextended(p_user_id, 714)"), "begin locks the account");
    assert.ok(text.includes("hashtextextended(account_id, 714)"), "trigger locks the same namespace");
    assert.ok(/order by id/.test(text), "trigger walks accounts in a fixed order");
    assert.ok(text.includes("is_delete_marker"), "delete markers pass while fenced (sweep cannot wedge)");
    assert.ok(text.includes("archived_at"), "archived rows pass while fenced");
    assert.ok(/to_jsonb\(new\)/.test(text), "versioning columns read defensively (schema-version safe)");
  });

  it("owner mapping matches delete-account OWNED_STORAGE_NAMESPACES", () => {
    const text = code();
    assert.ok(text.includes("'findback-images'") && text.includes("'findback-comment-media'"), "both buckets mapped");
    assert.ok(text.includes("'avatars'"), "avatar prefix handled distinctly");
    for (const ns of ["${uid}/", "avatars/${uid}/"]) {
      assert.ok(consumer().includes(ns), `consumer registers ${ns}`);
    }
    assert.ok(consumer().includes("findback-comment-media"), "consumer registers comment media");
  });

  it("fence survives the cascade and stays client-denied", () => {
    const text = code();
    assert.ok(text.includes("create table public.account_deletion_fences"), "fence table");
    assert.ok(text.includes("enable row level security"), "RLS on");
    assert.ok(text.includes("revoke all on public.account_deletion_fences from public, anon, authenticated"), "clients revoked");
    assert.ok(text.includes("grant select, insert on public.account_deletion_fences to service_role"), "service-role only");
    assert.ok(!/references\s+public\.users/i.test(text), "no cascading FK to users");
  });

  it("fences via a trigger, never a policy that could wedge the deletion sweep", () => {
    const text = code();
    assert.ok(!/create policy/i.test(text), "no RESTRICTIVE policy (versioning marker writes would be refused)");
    assert.ok(/before insert or update on storage\.objects/.test(text), "trigger is the single enforcement point");
    assert.ok(text.includes("raise exception 'account deletion prevents storage writes'"), "refuses fenced writes");
    assert.ok(text.includes("raise exception 'account required for storage write'"), "fail-closed on malformed keys");
    assert.ok(/p_name like '%\/%'/.test(text), "a bare filename in a gated bucket is refused, not treated as an owner");
  });

  it("every SECURITY DEFINER function pins an empty search_path", () => {
    const text = sql();
    const definers = (text.match(/security definer/gi) ?? []).length;
    const paths = (text.match(/set search_path = ''/g) ?? []).length;
    assert.ok(definers > 0, "has definer functions");
    assert.ok(paths >= definers, "every definer pins search_path");
  });

  it("delete-account calls the fence BEFORE it sweeps storage", () => {
    const src = consumer();
    assert.ok(src.includes("findback_begin_account_deletion"), "calls the fence RPC");
    const fence = src.indexOf("beginDeletion(uid)");
    const sweep = src.indexOf("purgeUserData(clients, uid)");
    assert.ok(fence > 0 && sweep > fence, "fence is acquired before the sweep");
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
    const newest = ls()
      .map((name) => name.match(/^(\d{14})_/)?.[1])
      .filter((prefix) => prefix !== undefined)
      .sort()
      .at(-1);
    assert.ok(newest, "at least one 14-digit migration prefix exists");
    assert.ok(
      caps.includes(`BACKEND_SCHEMA_VERSION = "${newest}"`),
      `coordinator bumped the advertised version to ${newest}`,
    );
  });
});

// ---------------------------------------------------------------------------
// CREATE OR REPLACE FUNCTION signature-drift guard.
//
// A live `supabase db push` failed on 20261012030000 with
//   ERROR: cannot change name of input parameter "p_avatar_url" (SQLSTATE 42P13)
// because the file re-declared `update_my_avatar_by_key` with `p_public_url`
// while 20261012000000 (and the client named-arg call) used `p_avatar_url`.
// Such a chain is unbootable on ANY database. This guard walks the ordered
// migration chain and fails when a later CREATE OR REPLACE renames the input
// parameters of an already-declared function with the same argument types.
// ---------------------------------------------------------------------------
function splitTopLevel(s) {
  const parts = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

function parseParams(args) {
  return splitTopLevel(args).map((p) => {
    const cleaned = p.replace(/\s+/g, " ").trim();
    const tokens = cleaned.split(" ");
    const name = tokens[0].toLowerCase();
    let type = tokens.slice(1).join(" ");
    type = type.replace(/\s+default\s+.*$/i, "").trim().toLowerCase();
    return { name, type };
  });
}

function extractFunctionDecls(text) {
  const decls = [];
  const re = /create\s+(?:or\s+replace\s+)?function\s+([a-z0-9_."]+)\s*\(/gi;
  let m;
  while ((m = re.exec(text))) {
    const start = re.lastIndex;
    let depth = 1;
    let i = start;
    for (; i < text.length && depth > 0; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")") depth--;
    }
    decls.push({ name: m[1].toLowerCase(), args: text.slice(start, i - 1) });
  }
  const drops = [];
  const dre = /drop\s+function\s+(?:if\s+exists\s+)?([a-z0-9_."]+)/gi;
  let d;
  while ((d = dre.exec(text))) drops.push(d[1].toLowerCase());
  return { decls, drops };
}

/** Returns drift failures for an ordered list of {file, sql} migrations. */
function findSignatureDrift(migrations) {
  const seen = new Map(); // key -> {name, params, file}
  const failures = [];
  for (const { file, sql } of migrations) {
    const { decls, drops } = extractFunctionDecls(sql.replace(/--[^\n]*/g, ""));
    for (const dropName of drops) {
      for (const key of [...seen.keys()]) {
        if (key.startsWith(`${dropName}(`)) seen.delete(key);
      }
    }
    for (const { name, args } of decls) {
      const params = parseParams(args);
      const key = `${name}(${params.map((p) => p.type).join(",")})`;
      const prev = seen.get(key);
      const names = params.map((p) => p.name).join(",");
      if (prev && prev.names !== names) {
        failures.push(
          `${file}: ${name}(${params.map((p) => p.type).join(",")}) renames params ` +
            `[${prev.names}] -> [${names}] (first seen in ${prev.file}) — SQLSTATE 42P13`,
        );
      }
      seen.set(key, { names, file });
    }
  }
  return failures;
}

describe("CREATE OR REPLACE signature-drift guard", () => {
  it("the real migration chain never renames a same-type function's parameters", () => {
    const migrations = ls().map((f) => ({ file: f, sql: mig(f) }));
    assert.deepEqual(findSignatureDrift(migrations), []);
  });

  it("detects the exact 20261012030000 p_public_url/p_avatar_url defect", () => {
    const buggy = [
      { file: "a.sql", sql: "create or replace function public.f(p_object_key text, p_avatar_url text) returns void as $$ $$ language sql;" },
      { file: "b.sql", sql: "create or replace function public.f(p_object_key text, p_public_url text) returns void as $$ $$ language sql;" },
    ];
    const found = findSignatureDrift(buggy);
    assert.equal(found.length, 1);
    assert.match(found[0], /p_avatar_url/);
    assert.match(found[0], /p_public_url/);
  });

  it("allows a drop-then-recreate with new parameter names", () => {
    const ok = [
      { file: "a.sql", sql: "create or replace function public.f(p_old text) returns void as $$ $$ language sql;" },
      { file: "b.sql", sql: "drop function if exists public.f(text); create or replace function public.f(p_new text) returns void as $$ $$ language sql;" },
    ];
    assert.deepEqual(findSignatureDrift(ok), []);
  });

  it("tolerates type-only overloads and default-value differences", () => {
    const ok = [
      { file: "a.sql", sql: "create or replace function public.g(p_limit integer default 100) returns void as $$ $$ language sql;" },
      { file: "b.sql", sql: "create or replace function public.g(p_limit integer default 50) returns void as $$ $$ language sql;" },
    ];
    assert.deepEqual(findSignatureDrift(ok), []);
  });
});

// ---------------------------------------------------------------------------
// Column-grant coverage for the tables the client reads directly
// (REVIEW-M1 F1/F2, 2026-10-15)
//
// 20261015154642 added width/height to public.uploads and public.attachments,
// two tables whose `authenticated` SELECT is granted column-by-column (both were
// `revoke all`-ed and re-granted by name in 20260914180000_client_post_reads.sql,
// 20260914190000_post_mutations.sql and 20260914120000_direct_auth_profiles.sql).
// A column list does not cover a column added later, so in an environment built
// from this repo:
//   * `select * into v_upload` in BOTH publish RPCs meets 9 columns against 7
//     granted and raises 42501 - every photo report fails to publish;
//   * both consumer readers fail on width/height, so the dimensions that change
//     exists to carry can never reach the feed.
// The verify file shipped with that migration could not see it: every probe was
// catalog-only. This guard makes the class statically visible with no database.
//
// That guard was scoped to the two media tables by declaration, and
// REVIEW-M1-REPAIR showed what a declared scope costs: the same class was live
// on `comments` - an invoker reader asking for parent_id/depth against a grant
// that stopped at body - and the check could not see it, because the table was
// never named. A separate repo-wide enumeration (trust-backend
// CLIENT-ACL-ANALYSIS) then found the second instance: `reactions.user_id`, read
// by both feed readers and granted to nobody.
//
// TWO CHECKS, ONE CLASS.
//
//   * findColumnGrantGaps(tables) is the coarse question for a DECLARED list of
//     tables - "can `authenticated` read every column of these?" - and catches
//     the next width/height on the tables the media pipeline writes. A declared
//     table with NO read grant at all is a gap, not a deliberate state
//     (REVIEW-M1-REPAIR R2): for a table the client is known to read, "nobody
//     may read it" IS the defect, and the previous escape let `revoke all ...
//     from authenticated` pass in silence.
//
//   * findReaderGrantGaps() is the precise question for the WHOLE class - "is
//     every column a client-reachable reader asks for readable?" - answered by
//     parsing the latest body of every SECURITY INVOKER `findback_*_client`
//     function in the chain. Readers, not tables, are what the grant model
//     serves, and walking readers is what found both R1 instances. `select *`
//     in a reader counts as "every column of that table", which is how the
//     original F1/F2 defect appears in this model without naming any table.
//
// A `findback_*_client` function that is SECURITY DEFINER runs as its owner and
// needs no grant, so it is skipped - but the set is pinned by name below, so a
// reader turning definer (a security-model change) fails this file instead of
// quietly leaving the check.
// ---------------------------------------------------------------------------
const CLIENT_READ_MEDIA_TABLES = ["uploads", "attachments"];

/** The repo's naming convention for entry points that `authenticated` may call. */
const CLIENT_FUNCTION_SUFFIX = "_client";

/**
 * Client entry points that run SECURITY DEFINER, so their reads need no grant.
 * Any change here is a security-model change and should be deliberate.
 */
const DEFINER_CLIENT_FUNCTIONS = [
  "findback_delete_notifications_client",
  "findback_get_notification_preferences_client",
  "findback_list_notifications_client",
  "findback_mark_notifications_read_client",
  "findback_mark_notifications_unread_client",
  "findback_notification_count_client",
  "findback_react_comment_client",
  "findback_register_device_token_client",
  "findback_restore_notifications_client",
  "findback_search_profiles_client",
  "findback_set_notification_preferences_client",
  "findback_unregister_device_token_client",
];

/** Source of the client-side constant the SQL dims bound must agree with. */
const DIMS_MIRROR = join(
  ROOT,
  "..",
  "apps",
  "mobile",
  "src",
  "services",
  "media",
  "displayDimensions.ts",
);

/** Body lines that are not column definitions. */
const TABLE_BODY_KEYWORDS = new Set([
  "constraint",
  "primary",
  "unique",
  "check",
  "foreign",
  "exclude",
  "like",
]);

/** Collapse a migration to one comment-free, whitespace-normalised lowercase line. */
function flattenSql(sql) {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/** The text between the "(" at openIdx and its matching ")". */
function parenBodyAt(text, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") {
      depth--;
      if (depth === 0) return text.slice(openIdx + 1, i);
    }
  }
  return "";
}

/** Top-level (depth-zero) comma-separated parts. */
function topLevelParts(body) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const ch of body) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/**
 * Walk the chain in order and model how `authenticated` may read each table.
 *
 * Order matters: this repo revokes the Supabase default ACL and then grants a
 * column list in the same file, so `revoke` must undo earlier grants.
 */
function readGrantModel(migrations) {
  const columns = new Map();
  const tableSelect = new Set();
  const columnSelect = new Map();
  const columnsOf = (table) => {
    if (!columns.has(table)) columns.set(table, new Set());
    return columns.get(table);
  };
  const grantedColumns = (table) => {
    if (!columnSelect.has(table)) columnSelect.set(table, new Set());
    return columnSelect.get(table);
  };
  const targets = (list) => list.split(",").map((r) => r.trim());

  for (const { sql } of migrations) {
    const text = flattenSql(sql);

    for (const m of text.matchAll(/create table (?:if not exists )?(?:public\.)?([a-z0-9_]+)\s*\(/g)) {
      const body = parenBodyAt(text, m.index + m[0].length - 1);
      for (const part of topLevelParts(body)) {
        const token = part.split(/[\s(]+/)[0];
        if (/^[a-z_][a-z0-9_]*$/.test(token) && !TABLE_BODY_KEYWORDS.has(token)) {
          columnsOf(m[1]).add(token);
        }
      }
    }

    // `add width integer` and `add column width integer` are the same statement
    // and the keyword is not always written (REVIEW-M1-REPAIR R3); `add
    // constraint` / `add primary key` must not be read as a column either.
    for (const m of text.matchAll(
      /alter table (?:if exists )?(?:only )?public\.([a-z0-9_]+) add (?:column )?(?:if not exists )?([a-z0-9_]+)/g,
    )) {
      if (!TABLE_BODY_KEYWORDS.has(m[2])) columnsOf(m[1]).add(m[2]);
    }

    // Grants and revokes are applied in SOURCE ORDER, because this repo's pattern
    // is `revoke all ... ; grant select (cols) ...` inside one migration - a
    // two-pass model would read that as "granted, then fully revoked".
    const events = [];
    for (const m of text.matchAll(
      /grant ([a-z, ]*?) on (?:table )?public\.([a-z0-9_]+) to ([a-z_, ]+?)(?=[;)]|$)/g,
    )) {
      events.push({ index: m.index, kind: "grant", privs: m[1], table: m[2], roles: m[3], cols: null });
    }
    for (const m of text.matchAll(
      /grant select \(([^)]*)\) on public\.([a-z0-9_]+) to ([a-z_, ]+?)(?=[;)]|$)/g,
    )) {
      events.push({ index: m.index, kind: "grant", privs: "select", table: m[2], roles: m[3], cols: m[1] });
    }
    for (const m of text.matchAll(
      /revoke ([a-z, ]*?) on (?:table )?public\.([a-z0-9_]+) from ([a-z_, ]+?)(?=[;)]|$)/g,
    )) {
      events.push({ index: m.index, kind: "revoke", privs: m[1], table: m[2], roles: m[3], cols: null });
    }
    // `revoke select (col) ...` is a narrowing, not a blanket revoke
    // (REVIEW-M1-REPAIR R3).
    for (const m of text.matchAll(
      /revoke ([a-z, ]*?) \(([^)]*)\) on (?:table )?public\.([a-z0-9_]+) from ([a-z_, ]+?)(?=[;)]|$)/g,
    )) {
      events.push({ index: m.index, kind: "revoke", privs: m[1], table: m[3], roles: m[4], cols: m[2] });
    }

    for (const event of events.sort((a, b) => a.index - b.index)) {
      if (!targets(event.roles).includes("authenticated")) continue;
      // The DML surface is not modelled: this guard exists for the read path.
      const touchesSelect = event.privs.includes("select") || event.privs.includes("all");
      if (!touchesSelect) continue;
      if (event.kind === "grant") {
        if (event.cols === null) {
          tableSelect.add(event.table);
        } else {
          for (const col of event.cols.split(",").map((c) => c.trim()).filter(Boolean)) {
            grantedColumns(event.table).add(col);
          }
        }
        continue;
      }
      tableSelect.delete(event.table);
      if (event.cols === null) {
        columnSelect.delete(event.table);
      } else {
        // A column revoke narrows a table-level grant too: Postgres layers the
        // column restriction on top of it.
        if (tableSelect.has(event.table)) {
          tableSelect.delete(event.table);
          const revoked = event.cols.split(",").map((c) => c.trim()).filter(Boolean);
          for (const col of columns.get(event.table) ?? []) {
            if (!revoked.includes(col)) grantedColumns(event.table).add(col);
          }
        }
        for (const col of event.cols.split(",").map((c) => c.trim()).filter(Boolean)) {
          columnSelect.get(event.table)?.delete(col);
        }
      }
    }
  }

  return { columns, tableSelect, columnSelect };
}

/**
 * Columns of `tables` that no grant lets `authenticated` read.
 *
 * A declared table with NO grant at all is a gap covering every column: the
 * caller passed it in because the client is known to read it, so "nobody may
 * read this" is the defect this check exists to catch rather than a deliberate
 * state that exempts it (REVIEW-M1-REPAIR R2 - the previous escape meant
 * `revoke all ... from authenticated` produced zero findings).
 */
function findColumnGrantGaps(migrations, tables = CLIENT_READ_MEDIA_TABLES) {
  const { columns, tableSelect, columnSelect } = readGrantModel(migrations);
  const gaps = [];
  for (const table of tables) {
    if (tableSelect.has(table)) continue;
    const granted = columnSelect.get(table) ?? new Set();
    const missing = [...(columns.get(table) ?? [])].filter((c) => !granted.has(c)).sort();
    if (missing.length > 0) gaps.push({ table, missing });
  }
  return gaps;
}

/**
 * Latest definition of every `public` function in the chain.
 *
 * Definitions and `drop function` are applied in source order because this repo
 * drops and recreates a function whenever its signature changes, and the body is
 * the dollar-quoted literal following the declaration.
 */
function readFunctionModel(migrations) {
  const functions = new Map();
  for (const { sql } of migrations) {
    const marks = [];
    for (const m of sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+public\.([a-z0-9_]+)\s*\(/gi)) {
      marks.push({ index: m.index, kind: "create", name: m[1] });
    }
    for (const m of sql.matchAll(/drop function if exists public\.([a-z0-9_]+)\s*\(/gi)) {
      marks.push({ index: m.index, kind: "drop", name: m[1] });
    }
    for (const mark of marks.sort((a, b) => a.index - b.index)) {
      if (mark.kind === "drop") {
        functions.delete(mark.name);
        continue;
      }
      const tail = sql.slice(mark.index);
      const dollar = tail.match(/\$([a-z_]*)\$([\s\S]*?)\$\1\$/);
      if (!dollar) continue;
      const head = flattenSql(tail.slice(0, tail.indexOf(dollar[0])));
      functions.set(mark.name, { body: dollar[2], definer: /security\s+definer/.test(head) });
    }
  }
  return functions;
}

/** Words that can follow a table in FROM/JOIN but are not aliases. */
const ALIAS_STOP_WORDS = new Set([
  "and", "as", "asc", "between", "cross", "desc", "else", "end", "except", "exists", "for",
  "full", "group", "having", "in", "inner", "is", "join", "left", "like", "limit", "not",
  "null", "offset", "on", "or", "order", "outer", "returning", "right", "select", "set",
  "then", "union", "using", "values", "when", "where", "with",
]);

/**
 * Columns a client-reachable reader asks for that `authenticated` cannot read.
 *
 * The question is asked of READERS, not of a table list: every SECURITY INVOKER
 * `findback_*_client` function runs with the caller's privileges, so every column
 * its body reads is a column the grant model must cover. Column references are
 * attributed through the alias bound to each `public.<table>` in a FROM/JOIN
 * clause, and a `select *` from such a table demands all of its columns - which
 * is exactly how the 20261015154642 defect (`select * into v_upload`) appears
 * here without naming uploads anywhere.
 */
function findReaderGrantGaps(migrations) {
  const { columns, tableSelect, columnSelect } = readGrantModel(migrations);
  const functions = readFunctionModel(migrations);
  const required = new Map();
  const requireColumn = (table, column) => {
    if (!required.has(table)) required.set(table, new Set());
    required.get(table).add(column);
  };

  for (const [name, fn] of functions) {
    if (!name.endsWith(CLIENT_FUNCTION_SUFFIX) || fn.definer) continue;
    const body = flattenSql(fn.body);
    const aliases = new Map();
    for (const m of body.matchAll(/\b(?:from|join)\s+(?:public\.)?([a-z0-9_]+)(?:\s+(?:as\s+)?([a-z0-9_]+))?/g)) {
      const table = m[1];
      const alias = m[2];
      if (!columns.has(table)) continue; // a CTE, a set-returning function, a variable
      if (alias && !ALIAS_STOP_WORDS.has(alias)) aliases.set(alias, table);
    }
    for (const [alias, table] of aliases) {
      for (const m of body.matchAll(new RegExp(`\\b${alias}\\.([a-z0-9_]+)`, "g"))) {
        requireColumn(table, m[1]);
      }
    }
    for (const m of body.matchAll(/select\s+(?:distinct\s+)?\*\s*(?:into\s+[a-z0-9_]+\s*)?from\s+(?:public\.)?([a-z0-9_]+)/g)) {
      if (!columns.has(m[1])) continue;
      for (const column of columns.get(m[1])) requireColumn(m[1], column);
    }
  }

  const gaps = [];
  for (const [table, wanted] of required) {
    if (tableSelect.has(table)) continue;
    const granted = columnSelect.get(table) ?? new Set();
    const missing = [...wanted]
      .filter((c) => columns.get(table)?.has(c) && !granted.has(c))
      .sort();
    if (missing.length > 0) gaps.push({ table, missing });
  }
  return gaps.sort((a, b) => a.table.localeCompare(b.table));
}

describe("column-grant coverage (client-read media tables)", () => {
  it("the real chain lets authenticated read every column of the media tables", () => {
    const chain = ls().map((file) => ({ file, sql: mig(file) }));
    assert.deepEqual(findColumnGrantGaps(chain), []);
  });

  it("detects the exact 20261015154642 defect (REVIEW-M1 F1/F2)", () => {
    const buggy = [
      {
        file: "a.sql",
        sql: "create table if not exists uploads (id text, file_url text); grant select (id, file_url) on public.uploads to authenticated;",
      },
      {
        file: "b.sql",
        sql: "alter table public.uploads add column if not exists width integer; alter table public.uploads add column if not exists height integer;",
      },
    ];
    assert.deepEqual(findColumnGrantGaps(buggy), [{ table: "uploads", missing: ["height", "width"] }]);
  });

  it("treats a table-level SELECT as covering every column", () => {
    const ok = [
      {
        file: "a.sql",
        sql: "create table public.uploads (id text, width integer); grant select, insert on public.uploads to authenticated;",
      },
    ];
    assert.deepEqual(findColumnGrantGaps(ok), []);
  });

  it("honours revoke-then-grant ordering, the repo's least-privilege pattern", () => {
    const revoked = [
      {
        file: "a.sql",
        sql: "create table public.uploads (id text, width integer); grant select on public.uploads to authenticated; revoke all on public.uploads from anon, authenticated; grant select (id) on public.uploads to authenticated;",
      },
    ];
    assert.deepEqual(findColumnGrantGaps(revoked), [{ table: "uploads", missing: ["width"] }]);
  });

  it("does not accept a grant that targets another role as a read for `authenticated`", () => {
    const mixed = [
      {
        file: "a.sql",
        sql: "create table public.comments (id text, body text); grant select (id, body) on public.comments to anon; grant select (id) on public.comments to authenticated;",
      },
    ];
    assert.deepEqual(findColumnGrantGaps(mixed, ["comments"]), [
      { table: "comments", missing: ["body"] },
    ]);
  });

  it("only inspects the declared tables, so an unrelated gap cannot fail the build", () => {
    const others = [
      {
        file: "a.sql",
        sql: "create table public.comments (id text, body text); grant select (id) on public.comments to authenticated;",
      },
    ];
    assert.deepEqual(findColumnGrantGaps(others), []);
    assert.deepEqual(findColumnGrantGaps(others, ["comments"]), [{ table: "comments", missing: ["body"] }]);
  });
});

describe("reader-driven grant coverage (the whole client-read surface)", () => {
  const CHAIN = () => ls().map((file) => ({ file, sql: mig(file) }));
  const GRANTS = "20261015174749_client_read_grants_invoker_paths.sql";

  it("every column a client-reachable reader asks for is readable", () => {
    assert.deepEqual(findReaderGrantGaps(CHAIN()), []);
  });

  it("detects the exact REVIEW-M1-REPAIR R1 break when the repair is absent", () => {
    // This is the finding that failed the media-only guard: two invoker readers
    // ask for comments.parent_id/depth against a grant that stops at body, and
    // both feed readers ask for reactions.user_id against a grant that never
    // had it. Remove the migration that closed them and both come back.
    const without = CHAIN().filter(({ file }) => file !== GRANTS);
    assert.deepEqual(findReaderGrantGaps(without), [
      { table: "comments", missing: ["depth", "parent_id"] },
      { table: "reactions", missing: ["user_id"] },
    ]);
  });

  it("reads `select *` in a reader as a demand for every column (the F1/F2 class)", () => {
    const buggy = [
      {
        file: "a.sql",
        sql: "create table public.uploads (id text, width integer); grant select (id) on public.uploads to authenticated;",
      },
      {
        file: "b.sql",
        sql: "create or replace function public.findback_publish_client() returns void language plpgsql security invoker as $$ begin select * into v_upload from public.uploads where id = 'x'; end; $$;",
      },
    ];
    assert.deepEqual(findReaderGrantGaps(buggy), [{ table: "uploads", missing: ["width"] }]);
  });

  it("attributes a column through the alias bound to the table", () => {
    // The comments defect in miniature: only `depth`, which the alias reads, is
    // demanded - not every column of the table.
    const aliased = [
      {
        file: "a.sql",
        sql: "create table public.comments (id text, body text, depth integer); grant select (id, body) on public.comments to authenticated;",
      },
      {
        file: "b.sql",
        sql: "create or replace function public.findback_list_comments_client(p text) returns void language sql stable security invoker as $$ select c.id, c.body, c.depth from public.comments c where c.id = p; $$;",
      },
    ];
    assert.deepEqual(findReaderGrantGaps(aliased), [{ table: "comments", missing: ["depth"] }]);
  });

  it("skips a SECURITY DEFINER reader, whose reads run as its owner", () => {
    const definer = [
      {
        file: "a.sql",
        sql: "create table public.uploads (id text, width integer); revoke all on public.uploads from authenticated;",
      },
      {
        file: "b.sql",
        sql: "create or replace function public.findback_publish_client() returns void language sql security definer set search_path = public, pg_temp as $$ select id, width from public.uploads; $$;",
      },
    ];
    assert.deepEqual(findReaderGrantGaps(definer), []);
  });

  it("ignores an invoker function that is not a client entry point", () => {
    const internal = [
      {
        file: "a.sql",
        sql: "create table public.uploads (id text, width integer); revoke all on public.uploads from authenticated;",
      },
      {
        file: "b.sql",
        sql: "create or replace function public.findback_cleanup_tick() returns void language sql security invoker as $$ select width from public.uploads; $$;",
      },
    ];
    assert.deepEqual(findReaderGrantGaps(internal), []);
  });

  it("pins the definer set, so a reader turning definer cannot leave the check", () => {
    const clients = [...readFunctionModel(CHAIN())].filter(([n]) => n.endsWith(CLIENT_FUNCTION_SUFFIX));
    const definers = clients.filter(([, fn]) => fn.definer).map(([n]) => n).sort();
    assert.deepEqual(definers, DEFINER_CLIENT_FUNCTIONS);
    assert.ok(clients.length > definers.length, "the chain has invoker readers too");
  });

  it("models `add` without the optional COLUMN keyword (R3)", () => {
    const noKeyword = [
      {
        file: "a.sql",
        sql: "create table public.uploads (id text); grant select (id) on public.uploads to authenticated; alter table public.uploads add width integer;",
      },
    ];
    assert.deepEqual(findColumnGrantGaps(noKeyword, ["uploads"]), [{ table: "uploads", missing: ["width"] }]);
  });

  it("models a column-scoped revoke as a narrowing, not a blanket revoke (R3)", () => {
    const scoped = [
      {
        file: "a.sql",
        sql: "create table public.uploads (id text, width integer); grant select (id, width) on public.uploads to authenticated; revoke select (width) on public.uploads from authenticated;",
      },
    ];
    assert.deepEqual(findColumnGrantGaps(scoped, ["uploads"]), [{ table: "uploads", missing: ["width"] }]);
  });

  it("reports a declared client-read table whose read was revoked outright (R2)", () => {
    const revoked = [
      {
        file: "a.sql",
        sql: "create table public.uploads (id text, width integer); grant select on public.uploads to authenticated; revoke all on public.uploads from anon, authenticated;",
      },
    ];
    assert.deepEqual(findColumnGrantGaps(revoked, ["uploads"]), [
      { table: "uploads", missing: ["id", "width"] },
    ]);
  });
});

describe("dims bound parity with the client mirror (REVIEW-M1-REPAIR R5)", () => {
  it("binds every SQL ceiling to MAX_DISPLAY_DIMENSION in the app source", () => {
    const mirror = read(DIMS_MIRROR).match(/MAX_DISPLAY_DIMENSION\s*=\s*(\d+)/)?.[1];
    assert.ok(mirror, "client mirror constant found");
    const ceilings = [...mig("20261015163718_media_read_grants_and_dims_bound.sql").matchAll(/<=\s*(\d+)/g)].map(
      (m) => m[1],
    );
    assert.equal(ceilings.length, 4, "both dims of both checks carry the ceiling");
    for (const ceiling of ceilings) assert.equal(ceiling, mirror, "SQL bound equals the client mirror");
  });
});

describe("media read grants + dims bound repair (20261015163718)", () => {
  const REPAIR = "20261015163718_media_read_grants_and_dims_bound.sql";

  it("follows the migration hygiene contract", () => {
    const sql = mig(REPAIR);
    assert.ok(sql.includes("LIVE-PENDING"), "LIVE-PENDING note");
    assert.ok(sql.includes("supabase/tests/verify_20261015163718_media_read_grants.sql"), "verify pointer");
    assert.ok(sql.includes("ADDITIVE ONLY"), "additive header");
  });

  it("is additive only: no function, policy, column or row change", () => {
    const sql = mig(REPAIR).toLowerCase().replace(/--[^\n]*/g, " ");
    assert.ok(!sql.includes("create or replace function"), "no function body rewritten");
    assert.ok(!sql.includes("drop function"), "no function dropped");
    assert.ok(!sql.includes("add column"), "no column added");
    assert.ok(!sql.includes("drop column"), "no column dropped");
    assert.ok(!sql.includes("alter column"), "no column retyped");
    assert.ok(!sql.includes("create policy"), "no policy created");
    assert.ok(!sql.includes("drop policy"), "no policy dropped or altered");
    assert.ok(!/delete\s+from\s+public\./.test(sql), "no row deleted");
    assert.ok(!/update\s+public\./.test(sql), "no row rewritten");
  });

  it("grants the exact column set of each table, and nothing else", () => {
    // Read the columns from the whole chain (a migration that only grants does not
    // declare them), then assert this file's grant is exhaustive for each table.
    const chain = ls().map((file) => ({ file, sql: mig(file) }));
    const { columns } = readGrantModel(chain);
    const repairOnly = readGrantModel([{ file: REPAIR, sql: mig(REPAIR) }]);
    for (const table of CLIENT_READ_MEDIA_TABLES) {
      assert.ok(repairOnly.columnSelect.has(table), `${table}: column grant present`);
      assert.deepEqual(
        [...repairOnly.columnSelect.get(table)].sort(),
        [...columns.get(table)].sort(),
        `${table}: exhaustive`,
      );
    }
    assert.equal(repairOnly.columnSelect.size, 2, "no third table touched");
  });

  it("keeps the dims checks NOT VALID so no existing row is rescanned", () => {
    const sql = mig(REPAIR).toLowerCase().replace(/--[^\n]*/g, " ");
    assert.equal((sql.match(/not valid/g) ?? []).length, 2, "both dims checks stay NOT VALID");
    // The ceiling's VALUE is bound to the client mirror numerically in "dims
    // bound parity with the client mirror" (REVIEW-M1-REPAIR R5); here all that
    // is asserted is that every dimension still carries one.
    assert.equal((sql.match(/<= \d+/g) ?? []).length, 4, "every dim carries a ceiling");
  });
});

describe("client-read grant closure (20261015174749)", () => {
  const CLOSURE = "20261015174749_client_read_grants_invoker_paths.sql";

  it("follows the migration hygiene contract", () => {
    const sql = mig(CLOSURE);
    assert.ok(sql.includes("LIVE-PENDING"), "LIVE-PENDING note");
    assert.ok(sql.includes("supabase/tests/verify_20261015174055_client_read_grants.sql"), "verify pointer");
    assert.ok(sql.includes("ADDITIVE ONLY"), "additive header");
  });

  it("is additive only: two column-scoped grants, nothing created, dropped or altered", () => {
    const sql = mig(CLOSURE).toLowerCase().replace(/--[^\n]*/g, " ");
    const statements = sql.split(";").map((s) => s.trim()).filter(Boolean);
    assert.equal(statements.length, 2, "exactly two statements");
    for (const statement of statements) {
      assert.match(
        statement,
        /^grant select \([a-z_, ]+\) on public\.[a-z0-9_]+ to authenticated$/,
        "a column-scoped grant, to the consumer role only",
      );
    }
    assert.ok(!sql.includes("revoke"), "nothing is taken away from any role");
    assert.ok(!sql.includes("create "), "no object created");
    assert.ok(!sql.includes("drop "), "no object dropped");
    assert.ok(!sql.includes("alter "), "no object altered");
    assert.ok(!/delete\s+from/.test(sql), "no row deleted");
    assert.ok(!/update\s+/.test(sql), "no row rewritten");
  });

  it("grants exactly the columns the readers ask for, and nothing else", () => {
    const model = readGrantModel([{ file: CLOSURE, sql: mig(CLOSURE) }]);
    assert.deepEqual([...model.columnSelect.keys()].sort(), ["comments", "reactions"]);
    assert.deepEqual([...model.columnSelect.get("comments")].sort(), ["depth", "parent_id"]);
    assert.deepEqual([...model.columnSelect.get("reactions")], ["user_id"]);
    assert.deepEqual([...model.tableSelect], [], "no table-level grant");
  });

  it("states the doctrine conflict instead of hiding it, and routes the decision to the owner", () => {
    const sql = mig(CLOSURE);
    assert.ok(sql.includes("DOCTRINE"), "the conflict with the md5-digest pattern is named");
    assert.ok(/owner question/i.test(sql), "the choice is recorded as an owner question");
    assert.ok(/changes nothing in production/i.test(sql), "the live evidence is in the file");
  });
});
