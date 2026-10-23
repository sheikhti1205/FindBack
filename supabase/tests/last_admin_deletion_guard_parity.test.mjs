/**
 * Static checks for the last-admin deletion guard migration
 * (20261023030000_last_admin_deletion_guard.sql).
 *
 * No database, no network, no secrets: the migration text is parsed and the
 * properties that make it safe are asserted. The BEHAVIOURAL proof lives in
 * supabase/tests/verify_20261023030000_last_admin_deletion_guard.sql and runs
 * against a disposable PostgreSQL; this file is the guard that runs everywhere,
 * including where no engine exists.
 *
 * It asserts EXECUTABLE shape, not prose: that the trigger is BEFORE DELETE on
 * public.users, that the function is a SECURITY DEFINER with a pinned
 * search_path, that the ADMIN count excludes the row being deleted, that the
 * refusal (42501) happens before the function returns the row, that the
 * advisory lock is taken BEFORE the rule is evaluated, and that the rule
 * exists in exactly ONE place shared with atomic admission.
 * A version that counted the row itself, returned old before checking, took no
 * lock, or restated the rule in the trigger would pass a word-matching guard
 * and fail this one.
 *
 * Run: node --test supabase/tests/last_admin_deletion_guard_parity.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const migrationPath = join(
  repoRoot,
  "supabase",
  "migrations",
  "20261023030000_last_admin_deletion_guard.sql",
);
const edgeFunctionPath = join(
  repoRoot,
  "supabase",
  "functions",
  "delete-account",
  "index.ts",
);

const sql = readFileSync(migrationPath, "utf8");
const edgeFunction = readFileSync(edgeFunctionPath, "utf8");

/** The body of the guard function, between its `as $$` and the closing `$$;`. */
function guardBody() {
  const start = sql.indexOf("create or replace function public.findback_guard_last_admin_deletion()");
  assert.notEqual(start, -1, "the guard function is missing");
  const open = sql.indexOf("as $$", start);
  assert.notEqual(open, -1, "the guard function has no body");
  const close = sql.indexOf("$$;", open);
  assert.notEqual(close, -1, "the guard function body is not terminated");
  return sql.slice(open, close);
}

/** The full definition of the shared rule function, header included. */
function ruleDefinition() {
  const start = sql.indexOf("create or replace function public.findback_is_last_admin(");
  assert.notEqual(start, -1, "the shared rule function is missing");
  const close = sql.indexOf("$$;", start);
  assert.notEqual(close, -1, "the shared rule function body is not terminated");
  return sql.slice(start, close);
}

/** The body of the shared rule function, between its `as $$` and `$$;`. */
function ruleBody() {
  const definition = ruleDefinition();
  const open = definition.indexOf("as $$");
  assert.notEqual(open, -1, "the shared rule function has no body");
  return definition.slice(open);
}

describe("last-admin deletion guard — shape", () => {
  it("is one transactional migration", () => {
    assert.equal((sql.match(/^begin;$/gm) ?? []).length, 1);
    assert.equal((sql.match(/^commit;$/gm) ?? []).length, 1);
    assert.ok(sql.indexOf("begin;") < sql.indexOf("commit;"));
  });

  it("creates a BEFORE DELETE trigger on public.users, not on a role table", () => {
    assert.match(sql, /create trigger users_guard_last_admin_deletion/);
    assert.match(sql, /before delete on public\.users/);
    assert.match(sql, /for each row execute function public\.findback_guard_last_admin_deletion\(\)/);
    // The road we are closing is auth.users -> public.users -> user_roles; the
    // guard has to sit on public.users to catch it before the cascade.
    assert.doesNotMatch(sql, /before delete on public\.user_roles/);
  });

  it("is SECURITY DEFINER with a pinned search_path", () => {
    const fn = sql.slice(sql.indexOf("create or replace function public.findback_guard_last_admin_deletion()"));
    assert.match(fn, /security definer/);
    assert.match(fn, /set search_path = public, pg_temp/);
  });

  it("counts the OTHER admins, excluding the row being deleted", () => {
    const body = ruleBody();
    const count = body.indexOf("select count(*)");
    assert.notEqual(count, -1, "there is no admin count");
    const countBlock = body.slice(count, count + 400);
    assert.match(countBlock, /role = 'ADMIN'/);
    // Without this the function counts the row that is about to disappear and
    // never sees a last admin.
    assert.match(countBlock, /user_id <> p_user_id/);
  });

  it("refuses with 42501 before it returns the row", () => {
    const body = guardBody();
    const refusal = body.indexOf("raise exception");
    const finalReturn = body.lastIndexOf("return old;");
    assert.notEqual(refusal, -1, "the guard never refuses");
    assert.notEqual(finalReturn, -1, "the guard never returns the row");
    assert.ok(refusal < finalReturn, "the refusal must come before the return");
    const refusalBlock = body.slice(refusal, refusal + 300);
    assert.match(refusalBlock, /42501/);
    assert.match(refusalBlock, /only admin account/i);
  });

  it("keeps ordinary deletions unchanged", () => {
    const body = ruleBody();
    // A row without ADMIN must pass straight through: the early return sits
    // before any count.
    const earlyReturn = body.indexOf("return false;");
    const count = body.indexOf("select count(*)");
    assert.notEqual(earlyReturn, -1, "the rule has no early exit for non-admins");
    assert.ok(earlyReturn < count, "non-admin rows must return before counting admins");
  });

  it("is not callable by clients and is documented", () => {
    assert.match(
      sql,
      /revoke all on function public\.findback_guard_last_admin_deletion\(\) from public, anon, authenticated;/,
    );
    assert.match(sql, /comment on function public\.findback_guard_last_admin_deletion\(\) is/);
  });

  it("uses only the approved existing fence and canonical audit for admission", () => {
    assert.doesNotMatch(sql, /create table/i);
    assert.deepEqual([...sql.matchAll(/alter table public\.(\w+)/gi)].map((m) => m[1]), ["account_deletion_fences"]);
    assert.match(sql, /perform public\.findback_write_audit\('account_deletion_admitted'/);
    assert.doesNotMatch(sql, /insert into public\.admin_audit_log/i);
    assert.match(sql, /delete from public\.user_roles where user_id=p_user_id/);
    assert.match(sql, /delete from public\.user_role_capabilities where user_id=p_user_id/);
    assert.match(sql, /grant insert\(user_id\) on public\.account_deletion_fences to service_role/);
  });
});

describe("last-admin deletion guard — the rule lives in ONE place", () => {
  it("exposes the shared rule as a service-role-only, pinned function", () => {
    const definition = ruleDefinition();
    assert.match(
      definition,
      /create or replace function public\.findback_is_last_admin\(p_user_id text\)\s*\nreturns boolean/,
    );
    assert.match(definition, /security definer/);
    assert.match(definition, /set search_path = public, pg_temp/);
    assert.match(
      sql,
      /revoke all on function public\.findback_is_last_admin\(text\) from public, anon, authenticated;/,
    );
    assert.match(
      sql,
      /grant execute on function public\.findback_is_last_admin\(text\) to service_role;/,
    );
    assert.match(sql, /comment on function public\.findback_is_last_admin\(text\) is/);
  });

  it("makes the trigger CALL the rule instead of restating it", () => {
    const body = guardBody();
    assert.match(body, /public\.findback_is_last_admin\(old\.id\)/);
    // A second copy of the predicate inside the trigger is exactly the drift
    // this shape forbids: the trigger and the Edge Function pre-flight would
    // then be able to disagree about who the last admin is.
    assert.doesNotMatch(body, /select count\(/i);
    assert.doesNotMatch(body, /role = 'ADMIN'/i);
  });

  it("makes admission call the SAME rule and Edge call authoritative admission", () => {
    assert.match(
      edgeFunction,
      /beginDeletion: async \(uid\) => \{[\s\S]*?client\.rpc\("findback_begin_account_deletion", \{ p_user_id: uid \}\)/,
    );
    assert.doesNotMatch(edgeFunction, /clients\.isLastAdmin\(/);
    const start = sql.indexOf("create function public.findback_begin_account_deletion(");
    assert.notEqual(start, -1);
    const body = sql.slice(start, sql.indexOf("$$;", start));
    assert.match(body, /public\.findback_is_last_admin\(p_user_id\)/);
    assert.ok(body.indexOf("pg_advisory_xact_lock(20261022143000)") < body.indexOf("hashtextextended(p_user_id, 714)"));
    assert.ok(body.indexOf("findback_is_last_admin(p_user_id)") < body.indexOf("delete from public.user_role_capabilities"));
  });
});

describe("last-admin deletion guard — the check-then-act is serialised", () => {
  it("takes the family advisory lock before the rule is evaluated", () => {
    // The SAME key every role mutation takes
    // (20261022143000_roles_capabilities_invitations.sql:318,:562,:698,:877,:1029).
    const body = guardBody();
    const lock = body.indexOf("pg_advisory_xact_lock(20261022143000)");
    const rule = body.indexOf("findback_is_last_admin(");
    assert.notEqual(lock, -1, "the trigger takes no advisory lock");
    assert.notEqual(rule, -1, "the trigger never evaluates the rule");
    assert.ok(lock < rule, "the lock must be taken before the rule is evaluated");
  });

  it("takes the same lock inside the shared rule, so the pre-flight is serialised too", () => {
    const body = ruleBody();
    const lock = body.indexOf("pg_advisory_xact_lock(20261022143000)");
    const holds = body.indexOf("select exists");
    assert.notEqual(lock, -1, "the shared rule takes no advisory lock");
    assert.notEqual(holds, -1, "the shared rule never checks the ADMIN membership");
    assert.ok(lock < holds, "the lock must be taken before the rule reads user_roles");
  });

  it("uses the SAME lock key the D1 role guards use", () => {
    const d1 = readFileSync(
      join(repoRoot, "supabase", "migrations", "20261022143000_roles_capabilities_invitations.sql"),
      "utf8",
    );
    const d1Locks = [...d1.matchAll(/pg_advisory_xact_lock\((\d+)\)/g)].map((m) => m[1]);
    assert.ok(d1Locks.length >= 5, "the D1 role guards no longer take an advisory lock");
    assert.ok(
      d1Locks.every((key) => key === "20261022143000"),
      `the D1 role guards changed lock key: ${[...new Set(d1Locks)].join(",")}`,
    );
    assert.match(sql, /pg_advisory_xact_lock\(20261022143000\)/);
  });
});

describe("last-admin deletion guard — the sentence the user reads", () => {
  it("is written identically in the database and in the Edge Function", () => {
    const sqlSentence = sql.match(/raise exception '([^']+)'/)?.[1];
    assert.ok(sqlSentence, "the migration has no refusal sentence");
    const tsSentence = edgeFunction.match(
      /LAST_ADMIN_DELETION_REFUSAL\s*=\s*\n?\s*"([^"]+)"/,
    )?.[1];
    assert.ok(tsSentence, "the Edge Function has no refusal sentence");
    // Two copies of one sentence in two languages: the static guard is what
    // stops them from drifting apart.
    assert.equal(
      tsSentence,
      sqlSentence,
      "the database and the Edge Function disagree about the refusal sentence",
    );
  });

  it("validates committed admission and handles refusal before the sweep or any delete", () => {
    const fence = edgeFunction.indexOf("clients.beginDeletion(uid)");
    const sweep = edgeFunction.indexOf("purgeUserData(clients, uid)");
    assert.notEqual(fence, -1, "the fence call is missing");
    assert.notEqual(sweep, -1, "the purge call is missing");
    assert.ok(fence < sweep, "admission must run before the storage sweep");
    assert.match(edgeFunction, /validateAdmission\(await clients\.beginDeletion\(uid\), uid\)/);
    const refusal = edgeFunction.indexOf('admission.status === "blocked"');
    assert.ok(fence < refusal && refusal < sweep);
    assert.match(edgeFunction, /status: 409/);
  });
  it("guards role, capability and invitation acquisition at table boundaries", () => {
    for (const table of ["user_roles", "user_role_capabilities", "role_invitations"]) {
      assert.match(sql, new RegExp(`before insert or update on public\\.${table}`));
    }
    assert.match(sql, /revoke insert on public\.account_deletion_fences from service_role/);
  });
});
