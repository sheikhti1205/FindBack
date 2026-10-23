/**
 * Static checks for the admin-claim eligibility read
 * (20261022171000_bootstrap_claim_eligibility.sql).
 *
 * No database, no network, no secrets: the migration texts are parsed and the
 * properties that make the read safe to apply are asserted. The BEHAVIOURAL
 * proof lives in
 * supabase/tests/verify_20261022171000_bootstrap_claim_eligibility.sql and
 * runs against a disposable PostgreSQL; this file is the guard that runs
 * everywhere, including where no engine exists.
 *
 * The strongest check here is the SENTENCE BINDING. The eligibility read
 * answers "may this caller claim, and why not" with a sentence the owner
 * reads. The claim itself answers the same question by RAISING a sentence. If
 * those two drift, the app shows one reason and the server refuses for
 * another, and the owner is told a lie by a screen. The claim migration is
 * applied and must never be edited, so the binding is enforced HERE: the
 * sentences and their ORDER are extracted from both files and compared byte
 * for byte.
 *
 * The second-strongest check is the LEAK CHECK: the read may consult the
 * allowlist, but only as an existence test on the address of the CALLER, and
 * it may not project anybody else's identity.
 *
 * Run: node --test supabase/tests/bootstrap_claim_eligibility_parity.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIG = join(ROOT, "migrations", "20261022171000_bootstrap_claim_eligibility.sql");
const CLAIM_MIG = join(ROOT, "migrations", "20261022143000_roles_capabilities_invitations.sql");
const VERIFY = join(ROOT, "tests", "verify_20261022171000_bootstrap_claim_eligibility.sql");
const SERVICE = join(ROOT, "..", "apps", "mobile", "src", "services", "roles.ts");
const read = (p) => readFileSync(p, "utf8");

const sql = read(MIG);
const claimSql = read(CLAIM_MIG);
const verify = read(VERIFY);
const service = read(SERVICE);

/** Strip comments so a sentence quoted in prose cannot satisfy a check. */
const strip = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");

/** The body of one dollar-quoted function body, by its declaration. */
function functionBody(source, name) {
  const start = source.indexOf(`function public.${name}(`);
  assert.notEqual(start, -1, `public.${name} is declared`);
  const open = source.indexOf("$$", start);
  assert.notEqual(open, -1, `public.${name} has a dollar-quoted body`);
  const end = source.indexOf("$$", open + 2);
  assert.notEqual(end, -1, `public.${name} body is closed`);
  return source.slice(open + 2, end);
}

/** The sentences the claim raises, in the order it raises them. */
const claimSentences = [
  ...functionBody(claimSql, "findback_bootstrap_admin").matchAll(
    /raise exception '([^']+)'/g,
  ),
].map((match) => match[1]);

/** The sentences the eligibility read reports, in the order it reports them. */
const statusSentences = [
  ...functionBody(sql, "findback_bootstrap_claim_status").matchAll(
    /v_reason := '([^']+)'/g,
  ),
].map((match) => match[1]);

describe("the eligibility read is the claim's own answer", () => {
  it("reports the very sentences the claim raises, in the very order", () => {
    assert.ok(claimSentences.length >= 5, "the claim raises its sentences");
    assert.deepEqual(
      statusSentences,
      claimSentences.filter((sentence) => sentence !== "Not authenticated"),
      "every refusal sentence of the claim is reported by the read, in order",
    );
  });

  it("keeps the four contract sentences byte for byte", () => {
    for (const sentence of [
      "This account has no email address, so it cannot claim the admin role",
      "Confirm your email address before claiming the admin role",
      "This account is not in the admin bootstrap list",
      "An admin already exists",
    ]) {
      assert.ok(claimSentences.includes(sentence), `the claim raises: ${sentence}`);
      assert.ok(statusSentences.includes(sentence), `the read reports: ${sentence}`);
    }
  });

  it("refuses a drifted sentence in either file", () => {
    // A sentence that no longer matches the claim's is a lie the owner reads.
    const drifted = sql.replace(
      "This account is not in the admin bootstrap list",
      "This account is not on the list",
    );
    assert.notEqual(drifted, sql);
    assert.notDeepEqual(
      [...functionBody(drifted, "findback_bootstrap_claim_status").matchAll(
        /v_reason := '([^']+)'/g,
      )].map((match) => match[1]),
      claimSentences.filter((sentence) => sentence !== "Not authenticated"),
    );
  });
});

describe("the read answers only about the caller", () => {
  const body = strip(functionBody(sql, "findback_bootstrap_claim_status"));

  it("projects exactly the four contract keys", () => {
    const keys = [...body.matchAll(/'([a-z_]+)',/g)].map((match) => match[1]);
    assert.deepEqual(
      [...new Set(keys)].sort(),
      ["already_admin", "can_claim", "has_admin", "reason"],
    );
  });

  it("consults the allowlist only as an existence test on the caller's own address", () => {
    assert.match(body, /not exists \(\s*select 1 from public\.bootstrap_admins b/);
    // The comparison is against the caller's own address variable, never
    // against a column of another row.
    assert.ok(
      !/bootstrap_admins[^;]*select\s+1,\s*2|bootstrap_admins[^;]*\bfrom\s+public\.bootstrap_admins\s+b\s*,/i.test(
        body,
      ),
      "the allowlist is never joined or selected as a list",
    );
    assert.ok(
      !/jsonb_agg|array_agg|jsonb_object_agg[\s\S]*bootstrap_admins/i.test(body),
      "the allowlist is never aggregated into an answer",
    );
  });

  it("reads no other account's identity", () => {
    // The only profile row read is the caller's own, by the caller's own id.
    assert.match(body, /from public\.users u\s*where u\.id = v_uid/);
    assert.ok(
      !/select[^;]*u\.email[^;]*from\s+public\.users\s+u(?!\s*where u\.id = v_uid)/i.test(
        body,
      ),
      "no email is read from any row but the caller's own",
    );
    assert.ok(
      !/jsonb_build_object\([^)]*\bemail\b/i.test(body),
      "no address is projected into the answer",
    );
    assert.ok(
      !/jsonb_build_object\([^)]*\buser_id\b/i.test(body),
      "no account id is projected into the answer",
    );
  });

  it("is a read: it takes no lock and writes nothing", () => {
    assert.ok(!/pg_advisory_xact_lock/.test(body), "no lock is taken");
    assert.ok(!/\binsert\b|\bupdate\b|\bdelete\b/i.test(body), "nothing is written");
  });
});

describe("the object is a properly-posed definer function", () => {
  it("locks the search_path, is granted to authenticated and revoked from anon", () => {
    assert.match(sql, /security definer/);
    assert.match(sql, /set search_path = public, pg_temp/);
    assert.match(
      sql,
      /revoke all on function public\.findback_bootstrap_claim_status\(\) from public, anon;/,
    );
    assert.match(
      sql,
      /grant execute on function public\.findback_bootstrap_claim_status\(\) to authenticated;/,
    );
    assert.match(sql, /comment on function public\.findback_bootstrap_claim_status\(\) is/);
  });

  it("is wrapped in one transaction", () => {
    assert.match(sql, /begin;/);
    assert.match(sql, /commit;/);
  });

  it("sorts after the already-applied reader and before the moderation migration", () => {
    const names = readdirSync(join(ROOT, "migrations")).sort();
    const index = (name) => names.indexOf(name);
    assert.ok(index("20261022171000_bootstrap_claim_eligibility.sql") > index("20261022160000_match_candidates_reader.sql"));
    assert.ok(index("20261022171000_bootstrap_claim_eligibility.sql") < index("20261022173000_moderation_reports_sanctions_appeals.sql"));
    assert.equal(names.filter((name) => name.startsWith("20261022171000_")).length, 1);
  });

  it("states that it has not been applied and points at the verifier", () => {
    assert.match(sql, /NOT been applied to the hosted project/i);
    assert.match(sql, /supabase\/tests\/verify_20261022171000_bootstrap_claim_eligibility\.sql/);
  });
});

describe("the client calls the read by its exact name", () => {
  it("uses the RPC name the migration creates", () => {
    assert.match(service, /findback_bootstrap_claim_status/);
  });
  it("binds the UI-safe refusal list to the claim's exact sentences", () => {
    const list = service.match(/const BOOTSTRAP_REFUSALS = \[([\s\S]*?)\];/);
    assert.ok(list);
    assert.deepEqual([...list[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]), claimSentences);
  });
});

describe("the verifier proves the behaviour", () => {
  it("states that it has not been applied and rolls its scratch rows back", () => {
    assert.match(verify, /NOT been applied/i);
    assert.match(verify, /rollback;/i);
  });

  it("proves every branch the owner can hit", () => {
    for (const sentence of [
      "This account has no email address, so it cannot claim the admin role",
      "Confirm your email address before claiming the admin role",
      "This account is not in the admin bootstrap list",
      "An admin already exists",
    ]) {
      assert.ok(verify.includes(sentence), `the verifier proves: ${sentence}`);
    }
  });
});
