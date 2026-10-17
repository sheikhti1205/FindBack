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

/**
 * First words Postgres reads as part of a multi-word type name.
 *
 * Used only to tell `p_limit integer` (a parameter NAME) from an unnamed
 * `double precision` (a type). Quoting defeats it — `"double" precision` is a
 * parameter named double — which no migration in this chain does; a declaration
 * that did would be reported by the EXECUTE invariant as soon as a statement
 * referenced it.
 */
const TYPE_LEAD_WORDS = new Set([
  "double",
  "precision",
  "character",
  "varying",
  "timestamp",
  "time",
  "interval",
  "bit",
  "national",
  "with",
  "without",
]);

/**
 * A function's identity: `name(type,type)`, in the two spellings the chain uses.
 *
 * Postgres overloads on the ARGUMENT TYPE LIST alone — parameter names and
 * defaults never distinguish two overloads — so a signature is the only correct
 * key for both the function model and its EXECUTE state
 * (REVIEW-M1-ACL-CLOSURE-R2 B4).
 *
 * `kind` is what makes the two spellings reducible to one key. A DECLARATION is
 * `name type` per parameter (or a bare type), so the parameter name is dropped;
 * a GRANT/REVOKE reference is TYPES ONLY, so `double precision` keeps both of
 * its words. Reading a reference as a declaration turned `double precision` into
 * `precision` and made a real statement look unresolvable
 * (REVIEW-M1-ACL-CLOSURE-R3 C2).
 *
 * A declaration is read per parameter: `name type`, unless the first word is one
 * Postgres parses as part of a multi-word type (`double precision`,
 * `character varying`, `timestamp with time zone`), which is how an UNNAMED
 * parameter is told apart from a named one. That keeps the two spellings of
 * `double precision` on one key instead of `precision`
 * (REVIEW-M1-ACL-CLOSURE-R3 C2). Quoting defeats the rule (`"double" precision`
 * is a parameter named double); nothing in this chain does that, and a GRANT or
 * REVOKE that then could not be resolved fails the gate instead of narrowing in
 * silence.
 */
function signatureKey(name, args, kind = "declaration") {
  const parts = splitTopLevel(args).map((part) =>
    part
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\s+default\s+.*$/i, "")
      .split(" ")
      .filter(Boolean),
  );
  const types = parts.map((raw) => {
    let words = raw;
    // `in|out|inout|variadic` is an argument mode, never a name or a type.
    while (words.length > 1 && /^(in|out|inout|variadic)$/i.test(words[0])) words = words.slice(1);
    if (kind === "reference" || words.length === 1) return words.join(" ").toLowerCase();
    // `name type` unless the first word is one Postgres reads as part of a
    // multi-word type name, which is how an UNNAMED `double precision` parameter
    // is told apart from `p_limit integer` (R3 C2).
    const head = words[0].toLowerCase();
    return (TYPE_LEAD_WORDS.has(head) ? words : words.slice(1)).join(" ").toLowerCase();
  });
  return `${name}(${types.join(",")})`;
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
//     walking every SECURITY INVOKER function the chain leaves client-callable
//     (EXECUTE membership, not the `_client` suffix) and asking what its body
//     reads. Readers, not tables, are what the grant model serves, and walking
//     readers is what found both R1 instances. `select *` in a reader counts as
//     "every column of that table", which is how the original F1/F2 defect
//     appears in this model without naming any table.
//
// MODELLED, and how (REVIEW-M1-ACL-CLOSURE, REVIEW-M1-ACL-CLOSURE-R2, -R3):
//   * function identity is the SIGNATURE - name plus argument type list, the
//     only thing Postgres overloads on - so a `grant/revoke execute on
//     function f(text, text)` cannot be read onto a sibling overload, and one
//     overload's body cannot hide behind another's (B4);
//   * `drop function [if exists]`, and `alter function … security
//     definer|invoker`, which changes a reader's security model without
//     redefining its body (B5);
//   * the schema/name spelling and the body delimiter: quoted identifiers,
//     whitespace around the dot, either case (R3 C1), dollar-quote tags of any
//     identifier (`$$`, `$body$`, `$BODY$`, `$v1$`, R2 B1) and single-quoted
//     literal bodies;
//   * a bare `*` after `distinct on (…)`, told apart from `*` multiplication
//     and from `count(*)` (B2);
//   * every column shape listed against findReaderGrantGaps below.
//
// NOT MODELLED - and neither silently trusted nor silently narrowing:
//   * SQL assembled at runtime (dynamic `execute`), whose column set no static
//     walk can know;
//   * an unqualified column name in a scope with more than one source table
//     (an attribution would be a guess);
//   * a declaration this walk cannot READ. Two invariants fail the gate
//     instead of letting it pass unread: every public function the DDL text
//     declares must be registered with a body, and every GRANT/REVOKE EXECUTE
//     statement must resolve to exactly one declared signature at its point in
//     the chain (with `rls_auto_enable` pinned as the platform function the
//     chain hardens but never creates);
//   * an argument type spelled outside `signatureKey`'s normalisation. The
//     direction is operation-dependent and must stay that way: a GRANT then
//     applies to every overload of the name (noisy - an extra reachable reader
//     can only add demands), a REVOKE to none of them (narrowing a sibling
//     Postgres never revoked would drop a real reader out of the walk in
//     silence, R3 C2). The second invariant above is what actually catches it.
//
// A `findback_*_client` function that is SECURITY DEFINER runs as its owner and
// needs no grant, so it is skipped - but the set is pinned by name below, so a
// reader turning definer (a security-model change) fails this file instead of
// quietly leaving the check.
// ---------------------------------------------------------------------------
const CLIENT_READ_MEDIA_TABLES = ["uploads", "attachments"];

/**
 * EXECUTE membership that makes a function client-callable
 * (REVIEW-M1-ACL-CLOSURE A2/A4).
 *
 * The reader walk used to select functions by NAME (`_client` suffix). That is a
 * convention, not a fact: `findback_create_post_client_multi` is a shipped
 * publish RPC the walk could not see, and an ungranted read added to its body
 * left the gate green while the same read added to a `_client` reader failed it.
 * Reachability is now modelled the way Postgres decides it:
 *
 *   * a function is created with EXECUTE granted to PUBLIC, so `authenticated`
 *     may call it until that grant is revoked;
 *   * `grant execute ... to authenticated` makes it reachable again;
 *   * a direct `revoke ... from authenticated` does NOT remove the PUBLIC path
 *     (the role still inherits it), so the two are tracked separately and ORed.
 */
const CLIENT_EXECUTE_ROLES = ["public", "authenticated"];

/**
 * Client-reachable SECURITY DEFINER functions, pinned.
 *
 * A definer function runs with its owner's privileges, so its reads legitimately
 * need no grant - which is exactly why the set must be frozen: a reader that
 * silently flips from INVOKER to DEFINER would leave the walk without anything
 * to complain about. The set is derived from reachability (EXECUTE membership),
 * not from the `_client` name suffix, so the nine client-reachable definers the
 * suffix filter used to miss are pinned too (REVIEW-M1-ACL-CLOSURE A4).
 * Any change here is a security-model change and should be deliberate.
 */
const CLIENT_REACHABLE_DEFINERS = [
  "complete_social_profile",
  "findback_add_comment_with_attachments",
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
  "is_username_available",
  "phone_change_eligibility",
  "public_profile_by_username",
  "request_phone_change",
  "update_my_avatar",
  "update_my_avatar_by_key",
  "update_my_profile",
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
/**
 * `public.<name>` as the chain may legally spell it.
 *
 * `public.f`, `public . f`, `"public"."f"`, `PUBLIC.F` are all the same
 * function to Postgres. A pattern that only read the bare spelling let a whole
 * reader sit outside the walk with nothing red
 * (REVIEW-M1-ACL-CLOSURE-R3 C1, same class as R2 B1).
 */
const PUBLIC_FN = String.raw`"?public"?\s*\.\s*"?([a-z0-9_]+)"?`;

/**
 * Functions the chain grants/revokes EXECUTE on but does not declare.
 *
 * Pinned, and by name only, so a typo or a renamed function cannot slip into
 * this class unnoticed (REVIEW-M1-ACL-CLOSURE-R3 C2). `rls_auto_enable` is the
 * Supabase-managed updater, installed by the platform in `public` and hardened
 * by `20260912170500_restrict_rls_auto_enable.sql`, which revokes its EXECUTE
 * without ever creating it.
 */
const PLATFORM_FUNCTIONS_WITHOUT_A_DECLARATION = ["rls_auto_enable"];

function createFunctionRegex() {
  return new RegExp(String.raw`create\s+(?:or\s+replace\s+)?function\s+${PUBLIC_FN}\s*\(`, "gi");
}

function dropFunctionRegex() {
  return new RegExp(String.raw`drop\s+function\s+(?:if\s+exists\s+)?${PUBLIC_FN}\s*\(`, "gi");
}

function alterFunctionRegex() {
  return new RegExp(String.raw`alter\s+function\s+${PUBLIC_FN}\s*\(`, "gi");
}

/** `GRANT|REVOKE … EXECUTE ON FUNCTION public.f(args) TO|FROM roles`. */
function executeStatementRegex() {
  return /(grant|revoke) ([a-z, ]*?) on function\s+(?:public|"public")\s*\.\s*"?([a-z0-9_]+)"?\s*(?:\(([^)]*)\))? (to|from) ([a-z_, ]+?)(?=[;)]|$)/gi;
}

/** The DDL body of a function, in the two spellings this chain can use. */
function functionBodyAt(tail) {
  // Both spellings are anchored to THIS statement. The dollar pattern used to be
  // searched across the rest of the file, so a declaration whose body is a
  // single-quoted literal silently absorbed the next `$$…$$` — another function,
  // a `do` block, even a comment — and the walk analysed the wrong body with
  // both invariants green (REVIEW-M1-ACL-CLOSURE-R4 D1). A `;` before the
  // opening delimiter means the quoted region belongs to a later statement.
  const firstSeparator = tail.indexOf(";");
  const dollar = tail.match(/\$([A-Za-z_][A-Za-z0-9_]*)?\$([\s\S]*?)\$\1\$/);
  if (dollar && (firstSeparator === -1 || tail.indexOf(dollar[0]) < firstSeparator)) {
    return { body: dollar[2], head: tail.slice(0, tail.indexOf(dollar[0])) };
  }
  // `language sql as 'select 1'`: a single-quoted literal body. It has to be the
  // statement's LAST token and to sit directly after `as` - every definition in
  // this chain carries `set search_path = ''`, and accepting any literal as the
  // body read an unreadable declaration as an empty function, which is a silent
  // hole exactly where the walk is supposed to shout
  // (REVIEW-M1-ACL-CLOSURE-R3 C1/C2).
  const statement = firstSeparator === -1 ? tail : tail.slice(0, firstSeparator + 1);
  const literals = [...statement.matchAll(/'((?:[^']|'')*)'/g)];
  const last = literals[literals.length - 1];
  if (!last) return null;
  const before = statement.slice(0, last.index);
  const after = statement.slice(last.index + last[0].length);
  if (!/\bas\s*$/i.test(before) || !/^\s*;?\s*$/.test(after)) return null;
  return { body: last[1].replace(/''/g, "'"), head: before };
}

/**
 * `readFunctionModel` — every public function the chain leaves declared.
 *
 * One entry per SIGNATURE (`name(type,type)`), carrying the body and whether it
 * runs as definer, in chain order: `create or replace` replaces, `drop function`
 * (with or without `if exists`) removes, and `alter function … security
 * definer|invoker` flips the flag on the live entry.
 */
function readFunctionModel(migrations) {
  const functions = new Map();
  for (const { sql } of migrations) {
    const marks = [];
    for (const m of sql.matchAll(createFunctionRegex())) {
      marks.push({ index: m.index, kind: "create", name: m[1].toLowerCase() });
    }
    for (const m of sql.matchAll(dropFunctionRegex())) {
      marks.push({ index: m.index, kind: "drop", name: m[1].toLowerCase() });
    }
    // `alter function … security definer|invoker` flips a reader's security
    // model without redefining its body, so it has to be modelled for the pin to
    // mean anything (REVIEW-M1-ACL-CLOSURE-R2 B5).
    for (const m of sql.matchAll(alterFunctionRegex())) {
      marks.push({ index: m.index, kind: "alter", name: m[1].toLowerCase() });
    }
    for (const mark of marks.sort((a, b) => a.index - b.index)) {
      // One identity for a function: name + argument TYPE list. Postgres overloads
      // on the types alone (parameter names and defaults never distinguish two
      // overloads), so keying by name let an older overload's body escape the
      // reader walk (REVIEW-M1-ACL-CLOSURE-R2 B4).
      const key = signatureKey(mark.name, parenBodyAt(sql, sql.indexOf("(", mark.index)));
      if (mark.kind === "drop") {
        functions.delete(key);
        continue;
      }
      const tail = sql.slice(mark.index);
      if (mark.kind === "alter") {
        const current = functions.get(key);
        if (!current) continue;
        const end = tail.indexOf(";");
        const statement = flattenSql(end === -1 ? tail : tail.slice(0, end + 1));
        if (/security\s+definer/i.test(statement)) current.definer = true;
        else if (/security\s+invoker/i.test(statement)) current.definer = false;
        continue;
      }
      const found = functionBodyAt(tail);
      if (!found) continue;
      functions.set(key, {
        name: mark.name,
        signature: key,
        body: found.body,
        definer: /security\s+definer/i.test(flattenSql(found.head)),
      });
    }
  }
  return functions;
}

/**
 * Declarations whose body this walk cannot read, one line per occurrence.
 *
 * A key-set comparison is not enough on its own: when a function is declared
 * twice, an unreadable SECOND declaration leaves the first body in the model and
 * the key is still present, so the walk would analyse a superseded body in
 * silence. This reports the occurrence itself, whatever the final key set looks
 * like (REVIEW-M1-ACL-CLOSURE-R3 C1).
 *
 * Quantifies over the declarations the DDL pattern MATCHES: a spelling the
 * pattern cannot see at all is outside the walk by construction (R4 D3).
 */
function unreadableDeclarations(migrations) {
  const unreadable = [];
  for (const { file, sql } of migrations) {
    for (const m of sql.matchAll(createFunctionRegex())) {
      if (!functionBodyAt(sql.slice(m.index))) unreadable.push(`${file}: ${m[1]}`);
    }
  }
  return unreadable;
}

/**
 * The keys the DDL text declares, read WITHOUT touching function bodies.
 *
 * Independent of `readFunctionModel`'s body step, so a declaration the walk
 * cannot read (an unmodelled spelling, a body with no delimiter it recognises)
 * shows up as a difference and fails the gate instead of disappearing
 * (REVIEW-M1-ACL-CLOSURE-R3 C1).
 */
function declaredFunctionKeys(migrations) {
  const keys = new Set();
  for (const { sql } of migrations) {
    const marks = [];
    for (const m of sql.matchAll(createFunctionRegex())) {
      marks.push({ index: m.index, kind: "create", name: m[1].toLowerCase() });
    }
    for (const m of sql.matchAll(dropFunctionRegex())) {
      marks.push({ index: m.index, kind: "drop", name: m[1].toLowerCase() });
    }
    for (const mark of marks.sort((a, b) => a.index - b.index)) {
      const key = signatureKey(mark.name, parenBodyAt(sql, sql.indexOf("(", mark.index)));
      if (mark.kind === "drop") keys.delete(key);
      else keys.add(key);
    }
  }
  return keys;
}

/** Words that can follow a table in FROM/JOIN but are not aliases. */
const ALIAS_STOP_WORDS = new Set([
  "all", "and", "as", "asc", "begin", "between", "by", "case", "conflict", "cross", "declare",
  "delete", "desc", "distinct", "do", "else", "end", "except", "execute", "exists", "fetch",
  "for", "from", "full", "group", "having", "if", "in", "inner", "insert", "into", "is", "join",
  "lateral", "left", "like", "limit", "loop", "not", "nothing", "null", "offset", "on", "open",
  "or", "order", "outer", "perform", "raise", "return", "returning", "right", "select", "set",
  "then", "union", "update", "using", "values", "when", "where", "while", "with",
]);

/** Bare words that are SQL syntax or built-ins, never a column reference. */
const SQL_WORDS = new Set([
  ...ALIAS_STOP_WORDS,
  "array", "auth", "authenticated", "bigint", "boolean", "cast", "coalesce", "count",
  "current_user", "definer", "elseif", "elsif", "exception", "extensions", "false", "found",
  "greatest", "immutable", "integer", "interval", "invoker", "json", "jsonb", "language",
  "least", "max", "min", "new", "notice", "now", "nullif", "numeric", "old", "others",
  "plpgsql", "primary", "public", "record", "returned_sqlstate", "row_count", "security",
  "service_role", "sql", "stable", "storage", "text", "timestamptz", "timestamp", "trigger",
  "true", "uuid", "void", "volatile",
]);

/**
 * One scanner that drops line comments, block comments and string literals, so
 * the walk reads code rather than prose or data (REVIEW-M1-ACL-CLOSURE A3).
 *
 * One pass on purpose: a `'` inside a `--` comment and a `--` inside a literal
 * both corrupt any sequential-regex approach, and this repo has both kinds of
 * text in function bodies.
 */
function stripSqlNoise(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "-" && next === "-") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (ch === "'") {
      i++;
      while (i < text.length) {
        if (text[i] === "'") {
          if (text[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      out += " '' ";
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Parenthesis depth at every character.
 *
 * Depth is the scope: `from public.comments c` inside a subquery binds `c` for
 * that subquery only, so one alias can legitimately name two tables in two
 * scopes of one statement (REVIEW-M1-ACL-CLOSURE A3).
 */
function scopeDepths(text) {
  const depths = new Array(text.length + 1).fill(0);
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    depths[i] = depth;
    if (text[i] === "(") depth++;
    else if (text[i] === ")") depth = Math.max(0, depth - 1);
  }
  depths[text.length] = depth;
  return depths;
}

/**
 * Table/alias bindings for ONE statement, with the scope each was bound in.
 *
 * Handles the forms the old walk missed: comma-joined FROM lists
 * (`from public.comments c, public.users u` - `u` used to be invisible), `into`,
 * `update` and `delete from` targets, and aliases written with `as`.
 */
function bindingsForStatement(statement, columns) {
  const depths = scopeDepths(statement);
  const binds = [];
  const reads = [];
  const targets = [];
  const stop = [...ALIAS_STOP_WORDS].join("|");
  const binding = new RegExp(
    `\\b(from|join|into|update|delete\\s+from)\\s+((?:public\\.)?[a-z0-9_]+(?:\\s+(?:as\\s+)?(?!(?:${stop})\\b)[a-z0-9_]+)?(?:\\s*,\\s*(?:public\\.)?[a-z0-9_]+(?:\\s+(?:as\\s+)?(?!(?:${stop})\\b)[a-z0-9_]+)?)*)`,
    "g",
  );
  for (const m of statement.matchAll(binding)) {
    const depth = depths[m.index];
    const fromSource = m[1].startsWith("from") || m[1].startsWith("join");
    for (const part of m[2].split(",")) {
      const parsed = part.trim().match(/^(?:public\.)?([a-z0-9_]+)(?:\s+(?:as\s+)?([a-z0-9_]+))?$/);
      if (!parsed) continue;
      const table = parsed[1];
      if (!columns.has(table)) continue; // a CTE, a set-returning function, a variable
      binds.push({ name: table, table, depth, source: fromSource });
      if (parsed[2] && !ALIAS_STOP_WORDS.has(parsed[2])) {
        binds.push({ name: parsed[2], table, depth, source: fromSource });
      }
      (fromSource ? reads : targets).push({ table, depth });
    }
  }
  return { binds, reads, targets };
}

/** Tables a name refers to in the innermost scope at or around `depth`. */
function resolveBinding(binds, name, depth) {
  for (let d = depth; d >= 0; d--) {
    const tables = new Set();
    for (const bind of binds) if (bind.depth === d && bind.name === name) tables.add(bind.table);
    if (tables.size > 0) return tables;
  }
  return null;
}

/** Source tables of the innermost scope at or around `depth` that has any. */
function nearestScopeTables(entries, depth) {
  for (let d = depth; d >= 0; d--) {
    const tables = new Set();
    for (const entry of entries) if (entry.depth === d) tables.add(entry.table);
    if (tables.size > 0) return tables;
  }
  return new Set();
}

/**
 * Bare column names the statement reads from `table` in `scopeDepth`.
 *
 * Reserved for scopes with exactly one source table: with two tables in scope an
 * unqualified name is ambiguous and would be a guess. The written-but-not-read
 * positions are blanked before scanning - an INSERT target list and the SET
 * targets of an UPDATE need no SELECT privilege - and the blanking is
 * length-preserving so the depth map still lines up.
 */
function unqualifiedColumnRefs(statement, table, columns, scopeDepth, boundNames) {
  const colSet = columns.get(table) ?? new Set();
  const text = statement
    .replace(/\binsert\s+into\s+(?:public\.)?[a-z0-9_]+\s*\([^)]*\)/g, (m) => " ".repeat(m.length))
    .replace(/\bset\s+([\s\S]*?)(?=\bwhere\b|\breturning\b|$)/g, (whole) =>
      whole.replace(/[a-z_][a-z0-9_]*\s*=/g, (pair) => " ".repeat(pair.length)),
    );
  const depths = scopeDepths(text);
  const found = new Set();
  for (const m of text.matchAll(/[a-z_][a-z0-9_]*/g)) {
    const token = m[0];
    if (!colSet.has(token) || SQL_WORDS.has(token) || boundNames.has(token)) continue;
    if (depths[m.index] !== scopeDepth) continue;
    if (text[m.index - 1] === ".") continue; // qualified, handled as a reference
    if (/^\s*\(/.test(text.slice(m.index + token.length))) continue; // a function call
    found.add(token);
  }
  return found;
}

/**
 * EXECUTE membership per function (REVIEW-M1-ACL-CLOSURE A2).
 *
 * A freshly created function is PUBLIC-executable, so the model starts there and
 * applies grant/revoke in source order. PUBLIC and the role are tracked
 * separately: `revoke ... from authenticated` does not take away what the role
 * inherits from PUBLIC, so reachability is the OR of the two.
 */
function readExecuteModel(migrations, functions) {
  const state = new Map();
  const stateOf = (key) => {
    if (!state.has(key)) {
      state.set(key, { public: true, authenticated: false, anon: false, service_role: false });
    }
    return state.get(key);
  };
  for (const { sql } of migrations) {
    const text = flattenSql(stripSqlNoise(sql));
    for (const m of text.matchAll(executeStatementRegex())) {
      if (m[1].toLowerCase() === "grant" && !/execute|all/.test(m[2])) continue;
      const roles = m[6].split(",").map((r) => r.trim());
      for (const key of executeTargetKeys(m[1].toLowerCase(), m[3].toLowerCase(), m[4] ?? null, functions)) {
        const target = stateOf(key);
        for (const role of CLIENT_EXECUTE_ROLES.concat("anon", "service_role")) {
          if (!roles.includes(role)) continue;
          target[role] = m[1].toLowerCase() === "grant";
        }
      }
    }
  }
  return state;
}

/**
 * Which signatures a `GRANT|REVOKE EXECUTE ON FUNCTION public.f(args)` lands on.
 *
 * `GRANT … ON FUNCTION f(text)` is SIGNATURE-scoped: it never touches a sibling
 * overload of the same name. When the statement's argument list resolves to a
 * declared signature, that is the only target. When it does not resolve (a type
 * spelled differently, a name this walk never declares), the two operations must
 * fail in OPPOSITE directions:
 *
 * - a GRANT is applied to every overload — noisy, which is safe: an extra
 *   reachable reader can only add demands, never remove one;
 * - a REVOKE is applied to none of them — narrowing a sibling Postgres never
 *   revoked would drop a real reader out of the walk in silence
 *   (REVIEW-M1-ACL-CLOSURE-R3 C2). `unresolvedExecuteStatements` fails the gate
 *   for either case, so this direction is a backstop, not the only defence.
 */
function executeTargetKeys(op, name, argList, functions) {
  const overloads = [...functions.keys()].filter((key) => key.startsWith(`${name}(`));
  if (overloads.length === 0) return op === "revoke" ? [] : [name];
  // No argument list at all: Postgres accepts that only for a unique name, and
  // what the statement reaches is exactly what this walk cannot pin down — so a
  // revoke still narrows nothing (REVIEW-M1-ACL-CLOSURE-R4 D4).
  if (argList === null) return op === "revoke" ? [] : overloads;
  const key = signatureKey(name, argList, "reference");
  if (functions.has(key)) return [key];
  return op === "grant" ? overloads : [];
}

/**
 * EXECUTE statements whose signature resolves to nothing declared (R3 C2).
 *
 * An unresolved statement is a hole in the model, not a fact about the chain, so
 * it is reported rather than absorbed: the gate fails and the author either
 * spells the signature the way the walk reads it or extends `signatureKey`.
 *
 * Quantifies over the statements the DDL patterns MATCH (R4 D3).
 */
function unresolvedExecuteStatements(migrations) {
  const unresolved = [];
  // Point in time, not against the final map: the chain grants and revokes
  // `findback_login_email(text)` and then drops it in a LATER file, which is
  // correct SQL and must not be reported (REVIEW-M1-ACL-CLOSURE-R3 C2). File
  // order is the chain order, so each file's declarations (raw text, where the
  // bodies still exist) are applied before that file's statements (noise
  // stripped, where comments cannot be mistaken for SQL).
  const declaredNow = new Set();
  for (const { sql } of migrations) {
    const marks = [];
    for (const m of sql.matchAll(createFunctionRegex())) {
      marks.push({ index: m.index, kind: "create", name: m[1].toLowerCase() });
    }
    for (const m of sql.matchAll(dropFunctionRegex())) {
      marks.push({ index: m.index, kind: "drop", name: m[1].toLowerCase() });
    }
    for (const mark of marks.sort((a, b) => a.index - b.index)) {
      const key = signatureKey(mark.name, parenBodyAt(sql, sql.indexOf("(", mark.index)));
      if (mark.kind === "create") declaredNow.add(key);
      else declaredNow.delete(key);
    }
    const statements = [];
    for (const m of flattenSql(stripSqlNoise(sql)).matchAll(executeStatementRegex())) {
      if (m[1].toLowerCase() === "grant" && !/execute|all/.test(m[2])) continue;
      statements.push({
        index: m.index,
        kind: m[1].toLowerCase(),
        name: m[3].toLowerCase(),
        argList: m[4] === undefined ? null : m[4],
      });
    }
    for (const statement of statements.sort((a, b) => a.index - b.index)) {
      if (PLATFORM_FUNCTIONS_WITHOUT_A_DECLARATION.includes(statement.name)) continue;
      const overloads = [...declaredNow].filter((key) => key.startsWith(`${statement.name}(`));
      if (overloads.length === 0) {
        unresolved.push(
          `${statement.kind} ${statement.name}: no public function of that name is declared at this point in the chain`,
        );
        continue;
      }
      if (statement.argList === null) {
        unresolved.push(
          `${statement.kind} ${statement.name}: no argument list, so the statement names every overload`,
        );
        continue;
      }
      if (!declaredNow.has(signatureKey(statement.name, statement.argList, "reference"))) {
        unresolved.push(
          `${statement.kind} ${statement.name}(${statement.argList.trim().replace(/\s+/g, " ")}): no declared signature of that name has this argument type list`,
        );
      }
    }
  }
  return unresolved;
}

/** Functions `authenticated` can call: explicit grant, or an unrevoked PUBLIC grant. */
function clientReachableFunctions(functions, execute) {
  const reachable = new Set();
  for (const [key, fn] of functions) {
    const state =
      execute.get(key) ??
      execute.get(fn.name) ??
      { public: true, authenticated: false, anon: false };
    if (state.public || state.authenticated) reachable.add(key);
  }
  return reachable;
}

/**
 * Columns a client-reachable reader asks for that `authenticated` cannot read.
 *
 * The question is asked of READERS: every client-reachable SECURITY INVOKER
 * function runs with the caller's privileges, so every column its body reads is a
 * column the grant model must cover. Readers are selected by EXECUTE membership
 * rather than by the `_client` name suffix (REVIEW-M1-ACL-CLOSURE A2), each one
 * identified by its signature rather than by its name alone (R2 B4), and every
 * shape Postgres expands into a column read is modelled: `*` (including after
 * `distinct on (…)`), `alias.*`, schema-qualified names, comma-joined FROM lists,
 * RETURNING lists, and the unqualified names of a single-table scope
 * (REVIEW-M1-ACL-CLOSURE A1).
 *
 * What it deliberately does not model: dynamic SQL assembled at runtime, and an
 * unqualified name in a scope that has more than one source table (which would
 * be a guess, not an attribution). Both are reported by the guard's own
 * limitations note in the migration's header rather than silently trusted.
 *
 * Three residual classes the reviewer named at R4, all of which need a spelling
 * this chain does not use, and none of which is silently trusted:
 *
 * - statement text inside a dollar-quoted region (`do $$ … $$`, or a comment
 *   holding one) is read as a statement, because a text scan cannot tell a `do`
 *   block from a string. Dynamic SQL belongs to the not-modelled class above;
 *   REVIEW-M1-ACL-CLOSURE-R4 D2.
 * - a quoted identifier is matched case-insensitively, so `"FINDBACK_X"(text)`
 *   folds onto `findback_x(text)` and could replace its body. Nothing in this
 *   chain quotes an identifier's case for a function; D3.
 * - the two invariants below quantify over every declaration and every EXECUTE
 *   statement the DDL PATTERNS MATCH. A spelling the patterns cannot capture at
 *   all (a comment between `function` and the name, `"my fn"`, `fo$o`, another
 *   schema) is outside the walk by construction — D3.
 */
function findReaderGrantGaps(migrations) {
  const { columns, tableSelect, columnSelect } = readGrantModel(migrations);
  const functions = readFunctionModel(migrations);
  const reachable = clientReachableFunctions(functions, readExecuteModel(migrations, functions));
  const required = new Map();
  const requireColumn = (table, column) => {
    if (!required.has(table)) required.set(table, new Set());
    required.get(table).add(column);
  };
  const requireAll = (table) => {
    for (const column of columns.get(table) ?? []) requireColumn(table, column);
  };

  for (const [key, fn] of functions) {
    if (fn.definer || !reachable.has(key)) continue;
    const body = flattenSql(stripSqlNoise(fn.body));
    for (const statement of body.split(";")) {
      if (!statement.trim()) continue;
      const { binds, reads, targets } = bindingsForStatement(statement, columns);
      if (binds.length === 0) continue;
      const depths = scopeDepths(statement);

      // `alias.*` / `table.*` / `public.table.*`: Postgres expands the star into
      // every column of that table, so the star IS a demand for all of them.
      for (const m of statement.matchAll(/([a-z0-9_]+)\s*\.\s*\*/g)) {
        const owner = m[1];
        const viaBinding = resolveBinding(binds, owner, depths[m.index]);
        if (viaBinding) for (const table of viaBinding) requireAll(table);
        else if (columns.has(owner)) requireAll(owner);
      }

      // A bare star reads every column of its scope's tables; `count(*)` reads
      // none, a qualified star is handled above, and `*` as multiplication is
      // told apart by the token on either side (an operand, not SELECT/RETURNING
      // or FROM/INTO). The look-ahead matters for `select distinct on (id) *`
      // (REVIEW-M1-ACL-CLOSURE-R2 B2), where the preceding word is `)`.
      for (const m of statement.matchAll(/\*/g)) {
        const before = statement.slice(0, m.index).trimEnd();
        if (before.endsWith("(") || before.endsWith(".")) continue;
        const operator = /([a-z_][a-z0-9_]*)$/.exec(before)?.[1];
        const after = statement.slice(m.index + 1).trimStart();
        const isStar =
          before.endsWith(",") ||
          ["select", "distinct", "all", "returning"].includes(operator) ||
          /^(,|\)|;|from\b|into\b|$)/i.test(after);
        if (!isStar) continue;
        const depth = depths[m.index];
        const sources = nearestScopeTables(reads, depth);
        for (const table of sources.size > 0 ? sources : nearestScopeTables(targets, depth)) {
          requireAll(table);
        }
      }

      // Qualified references in every form that names a table: alias.col,
      // table.col, public.table.col, and the second table of a comma join.
      const refs = /([a-z0-9_]+)\.([a-z0-9_]+)/g;
      let ref;
      while ((ref = refs.exec(statement)) !== null) {
        const owner = ref[1];
        const column = ref[2];
        const viaBinding = resolveBinding(binds, owner, depths[ref.index]);
        if (viaBinding) for (const table of viaBinding) requireColumn(table, column);
        else if (columns.has(owner)) requireColumn(owner, column);
        refs.lastIndex = ref.index + 1; // overlapping: public.t.col has two pairs
      }

      // Unqualified references, per single-table scope.
      const sourcesByDepth = new Map();
      for (const read of reads) {
        if (!sourcesByDepth.has(read.depth)) sourcesByDepth.set(read.depth, new Set());
        sourcesByDepth.get(read.depth).add(read.table);
      }
      for (const [depth, tables] of sourcesByDepth) {
        if (tables.size !== 1) continue;
        const table = [...tables][0];
        const boundNames = new Set(
          binds.filter((bind) => bind.depth === depth).map((bind) => bind.name),
        );
        for (const column of unqualifiedColumnRefs(statement, table, columns, depth, boundNames)) {
          requireColumn(table, column);
        }
      }
      // A statement that reads nothing still reads through its target: an
      // `insert ... returning col` and an `update ... where col` both need
      // SELECT on the columns they name.
      if (reads.length === 0) {
        for (const target of new Set(targets.map((t) => t.table))) {
          const boundNames = new Set(
            binds.filter((bind) => bind.table === target).map((bind) => bind.name),
          );
          for (const column of unqualifiedColumnRefs(
            statement,
            target,
            columns,
            targets.find((t) => t.table === target).depth,
            boundNames,
          )) {
            requireColumn(target, column);
          }
        }
      }
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

  it("ignores an invoker function whose EXECUTE was revoked from every client role", () => {
    const internal = [
      {
        file: "a.sql",
        sql: "create table public.uploads (id text, width integer); revoke all on public.uploads from authenticated;",
      },
      {
        file: "b.sql",
        sql: "create or replace function public.findback_cleanup_tick() returns void language sql security invoker as $$ select width from public.uploads; $$; revoke all on function public.findback_cleanup_tick() from public, anon, authenticated;",
      },
    ];
    assert.deepEqual(findReaderGrantGaps(internal), []);
  });

  it("walks a client-reachable reader that does not use the `_client` name (A2)", () => {
    // REVIEW-M1-ACL-CLOSURE A2 in miniature: the same ungranted read, in a
    // function whose name does not follow the convention. Reachability is an
    // EXECUTE fact, so the read is a gap here too.
    const unmarked = [
      {
        file: "a.sql",
        sql: "create table public.reactions (id text, created_at timestamptz); grant select (id) on public.reactions to authenticated;",
      },
      {
        file: "b.sql",
        sql: "create or replace function public.findback_create_post_client_multi() returns void language plpgsql security invoker as $$ begin if exists (select 1 from public.reactions rx where rx.created_at = now()) then null; end if; end; $$; grant execute on function public.findback_create_post_client_multi() to authenticated;",
      },
    ];
    assert.deepEqual(findReaderGrantGaps(unmarked), [{ table: "reactions", missing: ["created_at"] }]);
  });

  it("walks a reader reachable only through the default PUBLIC grant (A2)", () => {
    // `create function` grants EXECUTE to PUBLIC, so a function nobody granted
    // explicitly is still callable by `authenticated`.
    const implicit = [
      {
        file: "a.sql",
        sql: "create table public.uploads (id text, width integer); grant select (id) on public.uploads to authenticated;",
      },
      {
        file: "b.sql",
        sql: "create or replace function public.findback_scan_tick() returns void language sql security invoker as $$ select width from public.uploads; $$;",
      },
    ];
    assert.deepEqual(findReaderGrantGaps(implicit), [{ table: "uploads", missing: ["width"] }]);
  });

  it("treats `alias.*` as a demand for every column of the bound table (A1)", () => {
    const star = [
      {
        file: "a.sql",
        sql: "create table public.item_posts (id text, title text); grant select (id) on public.item_posts to authenticated;",
      },
      {
        file: "b.sql",
        sql: "create or replace function public.findback_feed_client() returns void language sql security invoker as $$ select p.* from public.item_posts p; $$;",
      },
    ];
    assert.deepEqual(findReaderGrantGaps(star), [{ table: "item_posts", missing: ["title"] }]);
  });

  it("reads unqualified and schema-qualified columns of a single-table scope (A1)", () => {
    const shapes = [
      {
        file: "a.sql",
        sql: "create table public.comments (id text, depth integer); grant select (id) on public.comments to authenticated;",
      },
      {
        file: "b.sql",
        sql: "create or replace function public.findback_reply_client() returns void language sql security invoker as $$ select depth from public.comments where id = 'x'; $$;",
      },
      {
        file: "c.sql",
        sql: "create or replace function public.findback_depth_client() returns void language sql security invoker as $$ select public.comments.depth from public.comments; $$;",
      },
    ];
    assert.deepEqual(findReaderGrantGaps(shapes), [{ table: "comments", missing: ["depth"] }]);
  });

  it("binds the second table of a comma join, which the alias map could not see (A1)", () => {
    const joined = [
      {
        file: "a.sql",
        sql: "create table public.comments (id text, body text); create table public.users (id text, email text); grant select (id, body) on public.comments to authenticated; grant select (id) on public.users to authenticated;",
      },
      {
        file: "b.sql",
        sql: "create or replace function public.findback_join_client() returns void language sql security invoker as $$ select c.id, u.email from public.comments c, public.users u where u.id = c.id; $$;",
      },
    ];
    assert.deepEqual(findReaderGrantGaps(joined), [{ table: "users", missing: ["email"] }]);
  });

  it("reads through an INSERT ... RETURNING and an UPDATE ... WHERE (A1)", () => {
    const written = [
      {
        file: "a.sql",
        sql: "create table public.item_posts (id text, title text, status text); grant select (id) on public.item_posts to authenticated; grant insert, update on public.item_posts to authenticated;",
      },
      {
        file: "b.sql",
        sql: "create or replace function public.findback_publish_client() returns void language plpgsql security invoker as $$ declare v_id text; begin insert into public.item_posts (id, title) values (v_id, 'x') returning title into v_id; update public.item_posts set status = 'y' where title = v_id; end; $$;",
      },
    ];
    // `title` is read (RETURNING, then WHERE); `status` is only written.
    assert.deepEqual(findReaderGrantGaps(written), [{ table: "item_posts", missing: ["title"] }]);
  });

  it("scans code, not prose: a table named in a literal or a comment is not a read (A3)", () => {
    const noisy = [
      {
        file: "a.sql",
        sql: "create table public.reactions (id text, created_at timestamptz); grant select (id) on public.reactions to authenticated;",
      },
      {
        file: "b.sql",
        sql: "create or replace function public.findback_noisy_client() returns void language plpgsql security invoker as $$ begin raise notice 'from public.reactions r where r.created_at is not null'; /* select created_at from public.reactions */ end; $$;",
      },
    ];
    assert.deepEqual(findReaderGrantGaps(noisy), []);
  });

  it("resolves one alias reused in two scopes to the table of each scope (A3)", () => {
    const scoped = [
      {
        file: "a.sql",
        sql: "create table public.comments (id text, depth integer); create table public.reactions (id text, created_at timestamptz); grant select (id) on public.comments to authenticated; grant select (id) on public.reactions to authenticated;",
      },
      {
        file: "b.sql",
        sql: "create or replace function public.findback_pair_client() returns void language sql security invoker as $$ select c.depth from public.comments c where exists (select 1 from public.reactions c where c.id is not null); $$;",
      },
    ];
    // `c.depth` is the outer comments scope; the inner `c` is reactions and only
    // its id is read, so reactions must not be charged for depth/created_at.
    assert.deepEqual(findReaderGrantGaps(scoped), [{ table: "comments", missing: ["depth"] }]);
  });

  it("registers a reader whose body uses a tagged, mixed-case dollar quote (B1)", () => {
    // `$BODY$` — and an uppercase CREATE — used to skip the whole function, so a
    // reader could leave the walk with nothing red.
    const tagged = [
      {
        file: "a.sql",
        sql: "create table public.uploads (id text, width integer); grant select (id) on public.uploads to authenticated;",
      },
      {
        file: "b.sql",
        sql: "CREATE OR REPLACE FUNCTION public.findback_tagged_client() RETURNS void LANGUAGE sql SECURITY INVOKER AS $BODY$ select width from public.uploads; $BODY$;",
      },
    ];
    assert.deepEqual(findReaderGrantGaps(tagged), [{ table: "uploads", missing: ["width"] }]);
  });

  it("reads a bare `*` after `distinct on (...)` as every column (B2)", () => {
    const distinct = [
      {
        file: "a.sql",
        sql: "create table public.item_posts (id text, title text); grant select (id) on public.item_posts to authenticated;",
      },
      {
        file: "b.sql",
        sql: "create or replace function public.findback_distinct_client() returns void language sql security invoker as $$ select distinct on (id) * from public.item_posts; $$;",
      },
    ];
    assert.deepEqual(findReaderGrantGaps(distinct), [{ table: "item_posts", missing: ["title"] }]);
  });

  it("never mistakes arithmetic for a star (A3/B2)", () => {
    const arithmetic = [
      {
        file: "a.sql",
        sql: "create table public.uploads (id text, width integer); grant select (id, width) on public.uploads to authenticated;",
      },
      {
        file: "b.sql",
        sql: "create or replace function public.findback_math_client() returns void language sql security invoker as $$ select count(*) as n, 2 * cos(width) as m from public.uploads; $$;",
      },
    ];
    assert.deepEqual(findReaderGrantGaps(arithmetic), []);
  });

  it("keys a reader by signature, so an older overload cannot hide its body (B4)", () => {
    // The chain really does hold overloads (findback_list_notifications_client
    // among them), and a name-keyed model kept only the newest body, so an older
    // overload that is still granted EXECUTE could read an ungranted column with
    // nothing going red. Here the OLDER overload is the one with the ungranted
    // read, which is exactly the shape a name-keyed walk misses.
    const overloaded = [
      {
        file: "a.sql",
        sql: "create table public.uploads (id text, width integer); grant select (id) on public.uploads to authenticated;",
      },
      {
        file: "b.sql",
        sql: "create function public.findback_publish_client(p_id text) returns void language sql security invoker as $$ select width from public.uploads where id = p_id; $$;",
      },
      {
        file: "c.sql",
        sql: "create function public.findback_publish_client(p_id text, p_note text) returns void language sql security invoker as $$ select id from public.uploads where id = p_id; $$; revoke all on function public.findback_publish_client(text, text) from public, anon; grant execute on function public.findback_publish_client(text, text) to authenticated;",
      },
    ];
    assert.deepEqual(
      [...readFunctionModel(overloaded).keys()].sort(),
      ["findback_publish_client(text)", "findback_publish_client(text,text)"],
      "one key per overload",
    );
    assert.deepEqual(findReaderGrantGaps(overloaded), [{ table: "uploads", missing: ["width"] }]);
  });

  it("honours a signature-scoped revoke as exactly that (B4)", () => {
    // Revoking the two-argument overload must not revoke its one-argument
    // sibling, and the still-granted sibling's reads are still checked.
    const scoped = [
      {
        file: "a.sql",
        sql: "create table public.uploads (id text, width integer); grant select (id) on public.uploads to authenticated;",
      },
      {
        file: "b.sql",
        sql: "create function public.findback_publish_client(p_id text) returns void language sql security invoker as $$ select width from public.uploads where id = p_id; $$;",
      },
      {
        file: "c.sql",
        sql: "create function public.findback_publish_client(p_id text, p_note text) returns void language sql security invoker as $$ select id from public.uploads where id = p_id; $$; revoke all on function public.findback_publish_client(text, text) from public, anon, authenticated;",
      },
    ];
    assert.deepEqual(findReaderGrantGaps(scoped), [{ table: "uploads", missing: ["width"] }]);
  });

  it("walks a reader however the chain spells the schema, the name or the body (R3 C1)", () => {
    // Every spelling here is legal Postgres and was invisible to the walk
    // before: a quoted schema, a quoted name, whitespace around the dot, and a
    // single-quoted literal body instead of a dollar-quoted one.
    const spellings = [
      "create function \"public\".\"findback_publish_client\"() returns void language sql security invoker as 'select width from public.uploads';",
      "create function public . findback_publish_client() returns void language sql security invoker as $$ select width from public.uploads; $$;",
      "CREATE OR REPLACE FUNCTION PUBLIC.FINDBACK_PUBLISH_CLIENT() RETURNS void LANGUAGE sql SECURITY INVOKER AS $BODY$ select width from public.uploads; $BODY$;",
    ];
    for (const statement of spellings) {
      const table = {
        file: "a.sql",
        sql: "create table public.uploads (id text, width integer); grant select (id) on public.uploads to authenticated;",
      };
      assert.deepEqual(
        findReaderGrantGaps([table, { file: "b.sql", sql: statement }]),
        [{ table: "uploads", missing: ["width"] }],
        `the walk reads: ${statement.slice(0, 60)}…`,
      );
    }
  });

  it("does not narrow a sibling overload when a revoke's spelling does not resolve (R3 C2)", () => {
    // The revoke names `character varying`, which is the same type as text but
    // not the spelling `signatureKey` produces. Postgres would revoke only that
    // signature; a walk that applied it to every overload would drop the
    // still-granted sibling out of the walk in silence, so it must not narrow.
    const unresolved = [
      {
        file: "a.sql",
        sql: "create table public.uploads (id text, width integer); grant select (id) on public.uploads to authenticated;",
      },
      {
        file: "b.sql",
        sql: "create function public.findback_publish_client(p_id text) returns void language sql security invoker as $$ select width from public.uploads where id = p_id; $$;",
      },
      {
        file: "c.sql",
        sql: "create function public.findback_publish_client(p_id text, p_note text) returns void language sql security invoker as $$ select id from public.uploads where id = p_id; $$; revoke all on function public.findback_publish_client(character varying, character varying) from public, anon, authenticated;",
      },
    ];
    // The sibling stays walkable (the read is still reported), and the
    // unresolved statement is reported as a modelling hole rather than absorbed.
    assert.deepEqual(findReaderGrantGaps(unresolved), [{ table: "uploads", missing: ["width"] }]);
    assert.deepEqual(unresolvedExecuteStatements(unresolved), [
      "revoke findback_publish_client(character varying, character varying): no declared signature of that name has this argument type list",
    ]);
  });

  it("does not read a later function's body as an earlier single-quoted one (R4 D1)", () => {
    const chain = [
      {
        file: "a.sql",
        sql: "create table public.uploads (id text, width integer); grant select (id) on public.uploads to authenticated;",
      },
      {
        file: "b.sql",
        sql: "create function public.findback_probe_client() returns void language sql security invoker as 'select width from public.uploads'; create function public.findback_probe_helper() returns void language sql security invoker as $$ select id from public.uploads; $$;",
      },
    ];
    assert.deepEqual(unreadableDeclarations(chain), []);
    // The first declaration's body is the literal, not the second function's
    // dollar-quoted tail: its ungranted read is reported. Searching the rest of
    // the file made this test green with the demand gone.
    assert.deepEqual(findReaderGrantGaps(chain), [{ table: "uploads", missing: ["width"] }]);
  });

  it("does not narrow on a bare-name revoke either (R4 D4)", () => {
    const chain = [
      {
        file: "a.sql",
        sql: "create table public.uploads (id text, width integer); grant select (id) on public.uploads to authenticated;",
      },
      {
        file: "b.sql",
        sql: "create function public.findback_probe_client(p_id text) returns void language sql security invoker as $$ select width from public.uploads where id = p_id; $$;",
      },
      {
        file: "c.sql",
        sql: "revoke execute on function public.findback_probe_client from public, anon, authenticated;",
      },
    ];
    assert.deepEqual(findReaderGrantGaps(chain), [{ table: "uploads", missing: ["width"] }]);
    assert.deepEqual(unresolvedExecuteStatements(chain), [
      "revoke findback_probe_client: no argument list, so the statement names every overload",
    ]);
  });

  it("keys an unnamed multi-word parameter by its type (R3 C2)", () => {
    // `create function f(double precision)` is an UNNAMED parameter; reading the
    // first word as the parameter name would key it `f(precision)` and make the
    // matching grant unresolvable.
    const chain = [
      {
        file: "a.sql",
        sql: "create table public.uploads (id text, width integer); grant select (id) on public.uploads to authenticated;",
      },
      {
        file: "b.sql",
        sql: "create function public.findback_probe_client(double precision) returns void language sql security invoker as $$ select width from public.uploads; $$; grant execute on function public.findback_probe_client(double precision) to authenticated;",
      },
    ];
    assert.deepEqual(unresolvedExecuteStatements(chain), []);
    assert.deepEqual(findReaderGrantGaps(chain), [{ table: "uploads", missing: ["width"] }]);
  });

  it("reads a body for every function the chain declares (R3 C1)", () => {
    // One report per declaration, not per final key: a superseded-but-unreadable
    // body must fail here too, or the walk would analyse the wrong body in
    // silence while the key set still looked complete.
    assert.deepEqual(unreadableDeclarations(CHAIN()), []);
  });

  it("reads every public function the chain declares, so none sits out the walk (R3 C1)", () => {
    // The declaration scan never looks at a function body, so if the walk could
    // not read one (an unmodelled spelling, a body with no delimiter it knows)
    // the two key sets would differ and this fails.
    const declared = [...declaredFunctionKeys(CHAIN())].sort();
    const walked = [...readFunctionModel(CHAIN()).keys()].sort();
    assert.deepEqual(walked, declared, "every declared public function is registered with a body");
  });

  it("resolves every EXECUTE statement to exactly one declared signature (R3 C2)", () => {
    assert.deepEqual(unresolvedExecuteStatements(CHAIN()), []);
  });

  it("follows `alter function … security definer|invoker` (B5)", () => {
    const tables = {
      file: "a.sql",
      sql: "create table public.uploads (id text, width integer); grant select (id) on public.uploads to authenticated;",
    };
    const body = "create or replace function public.findback_publish_client() returns void language sql security invoker as $$ select id, width from public.uploads; $$;";
    // Flipping to definer makes its reads run as the owner, so they stop being
    // the client's problem; flipping back makes them the client's problem again.
    assert.deepEqual(
      findReaderGrantGaps([tables, { file: "b.sql", sql: `${body} alter function public.findback_publish_client() security definer;` }]),
      [],
    );
    assert.deepEqual(
      findReaderGrantGaps([tables, { file: "b.sql", sql: `${body} alter function public.findback_publish_client() security invoker;` }]),
      [{ table: "uploads", missing: ["width"] }],
    );
  });

  it("pins the client-reachable definer set, so a reader turning definer cannot leave the check (A4)", () => {
    const functions = readFunctionModel(CHAIN());
    const reachable = clientReachableFunctions(functions, readExecuteModel(CHAIN(), functions));
    const definers = [
      ...new Set(
        [...functions]
          .filter(([key, fn]) => fn.definer && reachable.has(key))
          .map(([, fn]) => fn.name),
      ),
    ].sort();
    assert.deepEqual(definers, CLIENT_REACHABLE_DEFINERS);
    const invokers = [...functions].filter(([key, fn]) => !fn.definer && reachable.has(key));
    assert.ok(invokers.length > 0, "the chain has client-reachable invoker readers too");
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

describe("dims bound parity with the client mirror (REVIEW-M1-REPAIR R5, A5, A8)", () => {
  const DIMS_SQL = "20261015163718_media_read_grants_and_dims_bound.sql";
  const COMMENT_PARITY = "20261012020000_comment_attachments_parity.sql";

  it("binds every SQL dims floor and ceiling to the app mirror", () => {
    const source = read(DIMS_MIRROR);
    const ceiling = source.match(/MAX_DISPLAY_DIMENSION\s*=\s*(\d+)/)?.[1];
    const floor = source.match(/MIN_DISPLAY_DIMENSION\s*=\s*(\d+)/)?.[1];
    assert.ok(ceiling, "client mirror ceiling found");
    assert.ok(floor, "client mirror floor found");

    const text = flattenSql(mig(DIMS_SQL));
    for (const name of ["uploads_dims_check", "attachments_dims_check"]) {
      const at = text.indexOf(name);
      assert.ok(at >= 0, `${name} present`);
      const body = parenBodyAt(text, text.indexOf("(", at));
      // `< N` and `> N` are the same bounds written the other way round, so both
      // spellings are normalised before comparing. The count is not asserted -
      // the BINDING is (A8): a rewrite that keeps the same bound must pass, and a
      // bound that stops mirroring the app must fail.
      const ceilings = [
        ...[...body.matchAll(/<=\s*(\d+)/g)].map((m) => m[1]),
        ...[...body.matchAll(/<\s*(\d+)/g)].map((m) => String(Number(m[1]) - 1)),
      ];
      const floors = [
        ...[...body.matchAll(/>=\s*(\d+)/g)].map((m) => m[1]),
        ...[...body.matchAll(/>\s*(\d+)/g)].map((m) => String(Number(m[1]) + 1)),
      ];
      assert.ok(ceilings.length >= 2, `${name} carries a ceiling for both dimensions`);
      assert.ok(floors.length >= 2, `${name} carries a floor for both dimensions`);
      for (const value of ceilings) assert.equal(value, ceiling, `${name} ceiling mirrors the app`);
      for (const value of floors) assert.equal(value, floor, `${name} floor mirrors the app`);
    }
  });

  it("keeps the comment-attachment bound on its own contract, not the media mirror (A5)", () => {
    // `comment_attachments_dims_check` is a tighter, server-only bound that the
    // comment RPC enforces itself; `displayDimensions.ts` binds the post-media
    // checks and deliberately not this one. So instead of leaving the third dims
    // check unbound (three mutations there used to stay green), assert its own
    // two-sided contract: the constraint's ceiling is the ceiling both RPC guards
    // enforce, and it is NOT the media mirror — if anyone widens it to the media
    // ceiling, this fails and the exclusion has to be re-decided rather than rot.
    const source = read(DIMS_MIRROR);
    const mirrorCeiling = source.match(/MAX_DISPLAY_DIMENSION\s*=\s*(\d+)/)?.[1];
    assert.ok(mirrorCeiling, "client mirror ceiling found");

    const sql = flattenSql(mig(COMMENT_PARITY)).toLowerCase().replace(/--[^\n]*/g, " ");
    const at = sql.indexOf("comment_attachments_dims_check");
    assert.ok(at >= 0, "the comment-attachment dims check exists");
    const body = parenBodyAt(sql, sql.indexOf("(", at));
    const bounds = [...new Set([...body.matchAll(/(?:<=|>=|<|>)\s*(\d+)/g)].map((m) => m[1]))].sort();
    assert.deepEqual(bounds, ["1", "8192"], "one floor and one ceiling, both axes");
    const ceiling = bounds[1];
    assert.notEqual(ceiling, mirrorCeiling, "a different contract from the post-media mirror");

    for (const axis of ["v_width", "v_height"]) {
      const guard = new RegExp(
        `${axis}\\s+is\\s+not\\s+null\\s+and\\s+\\(${axis}\\s*<\\s*(\\d+)\\s+or\\s+${axis}\\s*>\\s*(\\d+)\\)`,
        "g",
      );
      assert.deepEqual(
        [...sql.matchAll(guard)].map((m) => m[2]),
        [ceiling],
        `${axis}: the RPC guard enforces the constraint's ceiling`,
      );
    }
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
    // Structural only, and per check: two dims constraints, each carrying a bound
    // in any spelling. The VALUE binding to the client mirror belongs to "dims
    // bound parity with the client mirror" below, so a semantically equal rewrite
    // (`<= 100000` written `< 100001`) must not fail here (A8).
    for (const name of ["uploads_dims_check", "attachments_dims_check"]) {
      const at = sql.indexOf(name);
      assert.ok(at >= 0, `${name} present`);
      const body = parenBodyAt(sql, sql.indexOf("(", at));
      assert.match(body, /(?:<=|>=|<|>)\s*\d+/, `${name} carries a bound`);
    }
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

describe("typed report reference on comments (20261017052000)", () => {
  const M2 = "20261017052000_comment_report_reference.sql";
  // Statements, not prose: comments are what the file says about itself.
  const stmt = () => mig(M2).toLowerCase().replace(/--[^\n]*/g, " ");
  // Whitespace-collapsed, comment-free, lower-cased source text. Exact
  // comparisons below run on this, because a substring match cannot see a
  // widened expression: `... or kind = 'report'` is satisfied by a qual that
  // also carries `or true`, and `user_id = ...` by one that dropped the owner
  // bind. An added clause always changes the collapsed text, so equality is the
  // only assertion that fails when the author's expression is widened.
  const norm = (s) => s.replace(/\s+/g, " ").trim();
  const code = () => norm(mig(M2).toLowerCase().replace(/--[^\n]*/g, " "));
  const statementWith = (needle) => {
    const hits = stmt()
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.includes(needle));
    assert.equal(hits.length, 1, `exactly one statement mentions ${needle}`);
    return hits[0];
  };
  // Exactly one statement mentions the needle AND it is byte-for-byte (after
  // normalisation) the authored statement — nothing appended, nothing removed.
  const exactStatement = (needle, expected) => {
    const hits = code()
      .split(";")
      .map(norm)
      .filter((s) => s.includes(needle));
    assert.equal(hits.length, 1, `exactly one statement mentions ${needle}`);
    assert.equal(
      hits[0],
      norm(expected).toLowerCase(),
      `${needle} is exactly the authored statement — no clause may be added to it`,
    );
  };

  it("follows the migration hygiene contract", () => {
    const sql = mig(M2);
    assert.ok(sql.includes("LIVE-PENDING"), "LIVE-PENDING note");
    assert.ok(
      sql.includes("supabase/tests/verify_20261017052000_comment_report_reference.sql"),
      "verify pointer",
    );
    assert.ok(sql.includes("ADDITIVE ONLY"), "additive header");
  });

  it("is additive only: nothing removed, no row touched, and no check left NOT VALID", () => {
    const sql = stmt();
    assert.ok(!sql.includes("drop table"), "no table dropped");
    assert.ok(!sql.includes("drop column"), "no column dropped");
    assert.ok(!sql.includes("truncate"), "no table truncated");
    assert.ok(!/delete\s+from/.test(sql), "no row deleted");
    assert.ok(!/update\s+public\./.test(sql), "no row rewritten");
    assert.ok(!/alter table public\.item_posts/.test(sql), "the referenced table is untouched");
    // Both re-added checks are VALID: every existing row satisfies the new
    // expression (no row has kind = 'report' yet), so nothing is rescanned to
    // a failure and nothing is deferred.
    assert.equal((sql.match(/not valid/g) ?? []).length, 0, "no NOT VALID check is added");
    assert.equal((sql.match(/add constraint/g) ?? []).length, 3, "the two re-adds plus the pointer's FK");
  });

  it("admits the report kind and lets a URL-less row exist", () => {
    const sql = stmt();
    assert.match(
      sql,
      /check\s*\(\s*kind in \('photo', 'video', 'gif', 'sticker', 'report'\)\s*\)/,
      "the vocabulary covers a report reference",
    );
    assert.match(
      sql,
      /alter table public\.comment_attachments\s+alter column remote_url drop not null/,
      "a report row has no URL",
    );
    exactStatement(
      "remote_url drop not null",
      "alter table public.comment_attachments alter column remote_url drop not null",
    );
    assert.ok(!/remote_url text not null/.test(sql), "the old NOT NULL is not restated");
    assert.ok(
      !/remote_url\s+set\s+not\s+null/.test(code()),
      "nullability is never re-imposed afterwards — a report row would become impossible to insert",
    );
  });

  it("makes source exclusivity kind-aware instead of exactly-one for every row", () => {
    exactStatement(
      "add constraint comment_attachments_source_xor",
      `alter table public.comment_attachments
         add constraint comment_attachments_source_xor
         check (
           case
             when kind = 'report' then storage_path is null and klipy_slug is null
             else ((case when storage_path is not null then 1 else 0 end) +
                   (case when klipy_slug is not null then 1 else 0 end)) = 1
           end
         )`,
    );
    const body = statementWith("add constraint comment_attachments_source_xor");
    assert.match(body, /when kind = 'report' then storage_path is null and klipy_slug is null/, "a report row keeps neither source");
    assert.match(body, /else \(\(case when storage_path is not null then 1 else 0 end\)/, "every other kind still keeps exactly one");
  });

  it("adds the pointer with ON DELETE SET NULL and an index, and never forces it non-null", () => {
    const sql = stmt();
    assert.match(sql, /add column if not exists report_post_id text/, "the column is added additively");
    assert.match(
      sql,
      /foreign key \(report_post_id\) references public\.item_posts \(id\) on delete set null/,
      "deleting a referenced report must not fail and leaves a tombstone",
    );
    assert.match(
      sql,
      /create index if not exists idx_comment_attachments_report_post\s+on public\.comment_attachments \(report_post_id\)/,
      "the pointer is indexed",
    );
    assert.ok(
      !/report_post_id is not null/.test(sql),
      "no CHECK forces the pointer non-null — it would make SET NULL fail and block report deletion",
    );
    assert.ok(
      !/report_post_id\s+set\s+not\s+null/.test(code()),
      "the pointer is never made NOT NULL after the ADD COLUMN — SET NULL would fail and deleting a referenced report would error",
    );
  });

  it("lets a viewer read the content-free pointer and refuses every client write of a report row", () => {
    // The full expression, not a substring: this is the only assertion that
    // fails when the select policy is widened (e.g. `or true`, which would make
    // every attachment row — including every media row — world-readable).
    exactStatement(
      "create policy comment_attachments_select_own",
      `create policy comment_attachments_select_own
         on public.comment_attachments for select to authenticated
         using (
           user_id = (select auth.uid())::text
           or kind = 'report'
         )`,
    );
    exactStatement(
      "create policy comment_attachments_insert_own",
      `create policy comment_attachments_insert_own
         on public.comment_attachments for insert to authenticated
         with check (
           kind <> 'report'
           and user_id = (select auth.uid())::text
           and exists (select 1 from public.comments c where c.id = comment_attachments.comment_id and c.user_id = (select auth.uid())::text)
         )`,
    );
    exactStatement(
      "create policy comment_attachments_update_own",
      `create policy comment_attachments_update_own
         on public.comment_attachments for update to authenticated
         using (
           kind <> 'report'
           and user_id = (select auth.uid())::text
           and exists (select 1 from public.comments c where c.id = comment_attachments.comment_id and c.user_id = (select auth.uid())::text)
         )
         with check (
           kind <> 'report'
           and user_id = (select auth.uid())::text
           and exists (select 1 from public.comments c where c.id = comment_attachments.comment_id and c.user_id = (select auth.uid())::text)
         )`,
    );

    const select = statementWith("create policy comment_attachments_select_own");
    assert.match(select, /or kind = 'report'/, "the pointer row is readable to a viewer of the comment");
    assert.match(select, /user_id = \(select auth\.uid\(\)\)::text/, "the owner branch is preserved");
    assert.equal(
      (select.match(/\bor\b/g) ?? []).length,
      1,
      "the qual is the owner branch OR the report branch — no third disjunct",
    );

    const insert = statementWith("create policy comment_attachments_insert_own");
    assert.match(insert, /kind <> 'report'/, "a client cannot insert a report row");
    assert.match(
      insert,
      /exists \(select 1 from public\.comments c where c\.id = comment_attachments\.comment_id and c\.user_id = \(select auth\.uid\(\)\)::text\)/,
      "the comment-ownership bind is preserved",
    );

    const update = statementWith("create policy comment_attachments_update_own");
    assert.equal((update.match(/kind <> 'report'/g) ?? []).length, 2, "both USING and WITH CHECK refuse report rows");
    assert.equal(
      (update.match(/exists \(select 1 from public\.comments c where c\.id = comment_attachments\.comment_id and c\.user_id = \(select auth\.uid\(\)\)::text\)/g) ?? []).length,
      2,
      "both clauses keep the ownership bind",
    );

    assert.ok(!stmt().includes("create policy comment_attachments_delete_own"), "the delete policy is untouched");
  });

  it("branches the atomic create RPC on a report descriptor and validates its target", () => {
    const sql = mig(M2);
    assert.match(sql, /if v_kind = 'report' then/, "the report descriptor has its own branch");
    assert.match(sql, /raise exception 'report reference needs a report id'/, "the pointer is mandatory");
    assert.match(sql, /v_storage_key is not null or v_slug is not null/, "no storage key rides along");
    assert.match(sql, /or v_remote is not null or v_preview is not null/, "no URL rides along");
    assert.match(sql, /if not exists \(select 1 from public\.item_posts p where p\.id = v_report\) then/, "the target must exist");
    assert.match(sql, /raise exception 'Report not found' using errcode = 'P0002'/, "an unknown report is a not-found, not a silent accept");
    assert.match(sql, /v_kind not in \('photo', 'video', 'gif', 'sticker', 'report'\)/, "the descriptor vocabulary matches the check");
    assert.match(sql, /continue;/, "the report branch returns to the loop without running media validation");

    // The whole branch, exactly: its guard list, its target check, its insert
    // column list and its early exit. The substring matches above cannot see a
    // guard that silently dropped three media columns, a branch moved below
    // media validation, or a commented-out `continue;`.
    const src = code();
    const branchStart = src.indexOf("if v_kind = 'report' then");
    assert.ok(branchStart > 0, "the report branch is present");
    const continued = src.indexOf("continue;", branchStart);
    assert.ok(continued > branchStart, "the report branch exits its loop iteration (continue;)");
    const branchEnd = src.indexOf("end if;", continued) + "end if;".length;
    assert.equal(
      src.slice(branchStart, branchEnd),
      norm(`if v_kind = 'report' then
        if v_report is null then
          raise exception 'report reference needs a report id' using errcode = '22023';
        end if;
        if v_storage_key is not null or v_slug is not null
           or v_remote is not null or v_preview is not null
           or v_mime is not null or v_fname is not null
           or v_fsize is not null or v_width is not null or v_height is not null then
          raise exception 'report reference carries no media fields' using errcode = '22023';
        end if;
        if not exists (select 1 from public.item_posts p where p.id = v_report) then
          raise exception 'Report not found' using errcode = 'P0002';
        end if;
        insert into public.comment_attachments
          (id, comment_id, user_id, kind, display_order, report_post_id, created_at)
        values
          (gen_random_uuid()::text, v_id, v_uid, 'report', v_order, v_report, v_now);
        continue;
      end if;`).toLowerCase(),
      "the report branch is exactly the authored text — no guard column dropped, no media field admitted, and it still exits early",
    );
    // Order is contract: the report branch must run before media validation, or
    // a report descriptor meets rules written for media rows.
    assert.ok(
      branchStart < src.indexOf("raise exception 'attachment must be storage or klipy, not both'"),
      "the report branch precedes media validation",
    );

    const insertColumns = [...sql.matchAll(/insert into public\.comment_attachments\n\s*\(([^)]*)\)/g)].map((m) => m[1]);
    assert.equal(insertColumns.length, 2, "two attachment insert paths");
    assert.equal(
      insertColumns.filter((cols) => cols.includes("report_post_id")).length,
      1,
      "only the report path writes the pointer",
    );
    assert.ok(
      insertColumns.some((cols) => cols.includes("storage_path") && !cols.includes("report_post_id")),
      "the media path never writes the pointer",
    );
  });

  it("relaxes the content rule exactly as far as a descriptor justifies", () => {
    const sql = mig(M2);
    assert.match(sql, /if p_body is null then/, "a NULL body stays refused");
    assert.match(sql, /if char_length\(btrim\(p_body\)\) > 1000 then/, "the ceiling is unchanged");
    assert.match(sql, /if char_length\(btrim\(p_body\)\) < 1 and v_count = 0 then/, "a blank body needs a descriptor");
  });

  it("projects the pointer from the invoker reader and keeps every security attribute as applied", () => {
    const sql = mig(M2);
    const code = stmt();
    assert.match(sql, /'report_post_id', a\.report_post_id,/, "the projection carries the pointer");
    assert.ok(!code.includes("drop function"), "no function is dropped, so no grant is silently lost");
    const readerAt = code.indexOf("create or replace function public.findback_list_comments_client");
    const writerAt = code.indexOf("create or replace function public.findback_add_comment_with_attachments");
    assert.ok(readerAt > 0, "the list reader is re-created in place");
    assert.ok(writerAt > readerAt, "the atomic create RPC is re-created after it");
    const readerBody = code.slice(readerAt, writerAt);
    const writerBody = code.slice(writerAt);
    assert.ok(readerBody.includes("security invoker"), "the list reader stays an invoker");
    assert.ok(!readerBody.includes("security definer"), "the list reader is never converted to a definer");
    assert.ok(writerBody.includes("security definer"), "the atomic create RPC stays the definer writer");
    assert.ok(!writerBody.includes("security invoker"), "and stays a definer");
    assert.equal(
      (code.match(/set search_path = public, pg_temp/g) ?? []).length,
      2,
      "both re-created functions lock search_path",
    );
    assert.match(sql, /comment on function public\.findback_list_comments_client\(text\)/, "the reader's contract comment is updated");
  });

  it("re-creates both RPCs with their applied signatures", () => {
    const sql = mig(M2);
    assert.match(sql, /create or replace function public\.findback_list_comments_client\(p_post_id text\)/);
    assert.match(
      sql,
      /create or replace function public\.findback_add_comment_with_attachments\(\n\s*p_post_id text,\n\s*p_body text,\n\s*p_parent_id text default null,\n\s*p_attachments jsonb default '\[\]'::jsonb\n\)/,
      "the atomic create signature is untouched (packet §4)",
    );
  });

  it("adds no grant and no revoke beyond re-asserting the two existing RPC grants", () => {
    const sql = stmt();
    assert.ok(!/on public\.comment_attachments to /.test(sql), "no table or column grant is added or removed");
    assert.equal((sql.match(/grant execute on function/g) ?? []).length, 2, "both RPC grants re-asserted");
    assert.equal((sql.match(/revoke all on function/g) ?? []).length, 2, "and both RPC revokes");
    assert.ok(!/to anon/.test(sql), "nothing is granted to anon");
    assert.ok(!/\bcreate table\b/.test(sql), "no second relation is introduced");
  });

  it("is re-runnable, adds exactly one column, and names no role but authenticated", () => {
    const src = code();

    // Idempotency: every drop is guarded, so a retried apply is a no-op rather
    // than an abort. (A failed apply is re-run from the ledger; an unguarded
    // drop would make the retry fail on the object it already removed.)
    const drops = src.match(/drop (constraint|policy|function|index)[^;]*/g) ?? [];
    assert.equal(
      drops.length,
      6,
      "exactly its own three constraints and three policies are dropped before re-creation",
    );
    drops.forEach((s) =>
      assert.match(s, /^drop (constraint|policy|function|index) if exists /, `guarded drop: ${s}`),
    );

    // Exactly one column is added: nothing may ride along with the pointer.
    const added = [...src.matchAll(/add column (?:if not exists )?([a-z_]+)/g)].map((m) => m[1]);
    assert.deepEqual(added, ["report_post_id"], "exactly the pointer column is added");

    // Exactly the two re-asserted RPC executes, exactly to authenticated.
    const grants = (src.match(/grant execute on function[^;]*/g) ?? []).map((s) => s.trim());
    assert.deepEqual(
      grants,
      [
        "grant execute on function public.findback_list_comments_client(text) to authenticated",
        "grant execute on function public.findback_add_comment_with_attachments(text, text, text, jsonb) to authenticated",
      ],
      "no role beyond authenticated gains execute, on either RPC",
    );
    assert.ok(!/service_role/.test(src), "no service-role grant is introduced");
  });

  // ---------------------------------------------------------------------------
  // Review R2 (REVIEW-CF060-M2-TRANCHE-R2.md, MAJOR-R2-1). The re-created
  // function bodies are pinned as *whole bodies* against the applied text, not
  // as the substrings an author happened to think of. R2 measured two live leaks
  // that passed every layer-1 substring assertion:
  //   * `... where a.comment_id = c.id or a.kind = 'report'` — a pointer from
  //     another comment appeared inside this comment's card; and
  //   * `... where c.post_id = p_post_id or true` — the whole comment list
  //     leaked across posts.
  // Both are single added lines, and a substring assertion cannot see an added
  // line. This is the same defect class as MAJOR-2 (a SELECT policy widened with
  // `or true` survived 103/103), so the instrument has to be equality, not
  // containment.
  // ---------------------------------------------------------------------------
  const APPLIED = NEW_ATTACH; // the applied text M2 re-creates both RPCs from

  // Body lines: comment-free, lower-cased, whitespace-collapsed, blanks dropped.
  const normalizedBodyLines = (source, name) => {
    const at = source.indexOf(`create or replace function public.${name}(`);
    assert.ok(at > 0, `${name} is created or replaced in the file under test`);
    const open = source.indexOf("$$", source.indexOf(")", at));
    const close = source.indexOf("$$", open + 2);
    assert.ok(open > 0 && close > open, `${name} has a dollar-quoted body`);
    return source
      .slice(open + 2, close)
      .toLowerCase()
      .replace(/--[^\n]*/g, " ")
      .split("\n")
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter((line) => line.length > 0);
  };

  const multisetDelta = (from, to) => {
    const count = (lines) => {
      const m = new Map();
      for (const line of lines) m.set(line, (m.get(line) ?? 0) + 1);
      return m;
    };
    const a = count(from);
    const b = count(to);
    const only = (x, y) => {
      const out = [];
      for (const [line, n] of x) for (let i = y.get(line) ?? 0; i < n; i += 1) out.push(line);
      return out.sort();
    };
    return { removed: only(a, b), added: only(b, a) };
  };

  it("re-creates the list reader as the applied text plus exactly the pointer projection", () => {
    const applied = normalizedBodyLines(mig(APPLIED), "findback_list_comments_client");
    const authored = normalizedBodyLines(mig(M2), "findback_list_comments_client");
    const POINTER = "'report_post_id', a.report_post_id,";

    // The baseline is the applied body, so the properties the app depends on are
    // asserted *in it* rather than assumed: the attachment bind, the
    // deterministic attachment order, the comment order and the cap.
    for (const invariant of [
      "where a.comment_id = c.id",
      "order by a.display_order asc, a.created_at asc, a.id asc",
      "order by c.created_at asc",
      "limit 500;",
    ]) {
      assert.ok(
        applied.some((line) => line.includes(invariant)),
        `the applied reader still binds: ${invariant}`,
      );
    }

    assert.equal(
      authored.filter((line) => line === POINTER).length,
      1,
      "the pointer is projected exactly once",
    );
    // Positional equality after removing that one line: every other line of the
    // reader an ordinary user calls must be identical (whitespace-collapsed,
    // comments stripped) to the applied text, in the applied order. A dropped
    // guard, a widened WHERE, a changed limit, a changed attachment bind and a
    // reordered projection all fail here.
    assert.deepEqual(
      authored.filter((line) => line !== POINTER),
      applied,
      "the reader body is the applied body plus exactly the pointer projection",
    );

    // The rev-1-era no-leak guards (migration_parity.test.mjs, NEW_ATTACH) scan
    // the file M2 supersedes and so no longer describe the function that lands.
    // Re-targeted at the newest definer:
    const readerText = authored.join("\n");
    assert.ok(
      !readerText.includes("'storage_path', a.storage_path"),
      "the read never projects storage_path",
    );
    assert.ok(
      !readerText.includes("'user_id', a.user_id"),
      "the read never projects the attachment owner",
    );
    assert.ok(!readerText.includes("'klipy_slug'"), "nor the provider slug");
  });

  it("re-creates the writer as the applied text plus exactly the authored report delta", () => {
    const applied = normalizedBodyLines(mig(APPLIED), "findback_add_comment_with_attachments");
    const authored = normalizedBodyLines(mig(M2), "findback_add_comment_with_attachments");
    const { removed, added } = multisetDelta(applied, authored);

    // Generated from the authored file and frozen. A multiset (not positional)
    // assertion is the right shape here: the report branch necessarily moves
    // lines around, and its *position* relative to media validation is pinned
    // separately above. What this kills is drift in the delta itself — a guard
    // column dropped, a vocabulary widened, an error code or message edited, an
    // insert column added, or `continue;` removed so the report row falls
    // through into media validation.
    assert.deepEqual(
      removed,
      [
        "if p_body is null or char_length(btrim(p_body)) < 1",
        "or char_length(btrim(p_body)) > 1000 then",
        "if v_kind not in ('photo', 'video', 'gif', 'sticker') then",
      ].sort(),
      "only the three superseded lines were replaced",
    );
    assert.deepEqual(
      added,
      [
        "v_report text;",
        "end if;",
        "end if;",
        "end if;",
        "end if;",
        "end if;",
        "end if;",
        "if p_body is null then",
        "raise exception 'comment must be 1-1000 characters' using errcode = '22023';",
        "if char_length(btrim(p_body)) > 1000 then",
        "raise exception 'comment must be 0-1000 characters' using errcode = '22023';",
        "if char_length(btrim(p_body)) < 1 and v_count = 0 then",
        "v_report := nullif(btrim(coalesce(d ->> 'report_post_id', '')), '');",
        "if v_kind not in ('photo', 'video', 'gif', 'sticker', 'report') then",
        "if v_kind = 'report' then",
        "if v_report is null then",
        "raise exception 'report reference needs a report id' using errcode = '22023';",
        "if v_storage_key is not null or v_slug is not null",
        "or v_remote is not null or v_preview is not null",
        "or v_mime is not null or v_fname is not null",
        "or v_fsize is not null or v_width is not null or v_height is not null then",
        "raise exception 'report reference carries no media fields' using errcode = '22023';",
        "if not exists (select 1 from public.item_posts p where p.id = v_report) then",
        "raise exception 'report not found' using errcode = 'p0002';",
        "insert into public.comment_attachments",
        "(id, comment_id, user_id, kind, display_order, report_post_id, created_at)",
        "values",
        "(gen_random_uuid()::text, v_id, v_uid, 'report', v_order, v_report, v_now);",
        "continue;",
      ].sort(),
      "the writer's whole delta is the authored report branch and the D7 body rule",
    );

    // The positional complement to the delta above (review R3 MAJOR-R3-1). A
    // pure *permutation* of the body leaves the multiset delta identical, so it
    // passed every assertion in revision 3. The measured survivor moved the
    // media insert above the provider-selection block: `v_provider` is then
    // still NULL at insert time and every RPC-created media row is stored with
    // `provider = NULL` — silently, because `provider_check` is written
    // `provider is null or …` and no probe binds `provider`. These anchors must
    // therefore appear in this order; crossing any pair fails.
    const anchors = [
      "for d in select * from jsonb_array_elements(coalesce(p_attachments, '[]'::jsonb)) loop",
      "v_report := nullif(btrim(coalesce(d ->> 'report_post_id', '')), '');",
      "if v_kind = 'report' then",
      "(id, comment_id, user_id, kind, display_order, report_post_id, created_at)",
      "continue;",
      "raise exception 'attachment must be storage or klipy, not both'",
      "raise exception 'attachment needs a storage key or provider slug'",
      "v_provider := 'storage';",
      "v_provider := 'klipy';",
      "provider, mime_type, file_name, file_size, width, height, created_at)",
      "end loop;",
    ];
    const joined = authored.join("\n");
    let cursor = -1;
    for (const anchor of anchors) {
      const at = joined.indexOf(anchor, cursor + 1);
      assert.ok(
        at > cursor,
        `the writer's \`${anchor}\` must follow the anchor before it — a permutation is a semantic change here`,
      );
      cursor = at;
    }
  });

  it("contains exactly the authored statement inventory, and nothing rides along", () => {
    const src = code();
    const inventory = [
      ...src.matchAll(
        /(alter column [a-z_]+ (?:drop not null|set not null|set default [^;,]*)|add column if not exists [a-z_]+|drop constraint if exists [a-z_]+|add constraint [a-z_]+|drop policy if exists [a-z_]+|create policy [a-z_]+|create index if not exists [a-z_]+|create or replace function public\.[a-z_]+|grant execute on function public\.[a-z_]+|revoke all on function public\.[a-z_]+|comment on function public\.[a-z_]+)/g,
      ),
    ].map((m) => m[1]);

    // Review R2 MINOR-R2-1: the file's *inventory* is pinned, so an unauthored
    // statement cannot ride along. `alter column report_post_id set default 'x'`
    // would break every media-attachment insert (the RPC's media path does not
    // name the column) and was invisible to every previous assertion.
    assert.deepEqual(
      inventory,
      [
        "drop constraint if exists comment_attachments_kind_check",
        "add constraint comment_attachments_kind_check",
        "alter column remote_url drop not null",
        "drop constraint if exists comment_attachments_source_xor",
        "add constraint comment_attachments_source_xor",
        "add column if not exists report_post_id",
        "drop constraint if exists comment_attachments_report_post_id_fkey",
        "add constraint comment_attachments_report_post_id_fkey",
        "create index if not exists idx_comment_attachments_report_post",
        "drop policy if exists comment_attachments_select_own",
        "create policy comment_attachments_select_own",
        "drop policy if exists comment_attachments_insert_own",
        "create policy comment_attachments_insert_own",
        "drop policy if exists comment_attachments_update_own",
        "create policy comment_attachments_update_own",
        "create or replace function public.findback_list_comments_client",
        "revoke all on function public.findback_list_comments_client",
        "grant execute on function public.findback_list_comments_client",
        "comment on function public.findback_list_comments_client",
        "create or replace function public.findback_add_comment_with_attachments",
        "revoke all on function public.findback_add_comment_with_attachments",
        "grant execute on function public.findback_add_comment_with_attachments",
        "comment on function public.findback_add_comment_with_attachments",
      ],
      "exactly the authored statements, in the authored order",
    );

    // Readable invariants that the inventory cannot name for themselves.
    assert.ok(!/\bset\s+default\b/.test(src), "no column default is introduced");
    assert.ok(!/\bdeferrable\b/.test(src), "the pointer FK stays immediate");
    assert.ok(!/\bset\s+not\s+null\b/.test(src), "no column is forced non-null (SET NULL must survive)");
    assert.equal((src.match(/create policy/g) ?? []).length, 3, "three policies re-created, not four");

    // A scalar length pin: any added or removed character changes it. It is a
    // backstop for an addition this file's patterns do not anticipate (the
    // deltas above catch any *substitution* of equal length).
    assert.equal(src.length, 12809, "the normalised file text is exactly the authored length");
  });
});
