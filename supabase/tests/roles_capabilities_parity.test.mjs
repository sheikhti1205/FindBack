/**
 * Static checks for the roles/capabilities/invitations migration
 * (20261022143000_roles_capabilities_invitations.sql).
 *
 * No database, no network, no secrets: the migration text is parsed and the
 * properties that make it safe to apply are asserted. The BEHAVIOURAL proof
 * lives in supabase/tests/verify_20261022143000_roles_capabilities.sql and
 * runs against a disposable PostgreSQL; this file is the guard that runs
 * everywhere, including where no engine exists.
 *
 * THIS GUARD ASSERTS SHAPE, NOT PROSE. A guard that only asks whether a word
 * appears in the file passes a migration that has been neutered: it stayed
 * green when `findback_can` was made to `return true` unconditionally, when
 * the last-admin count was loosened, and when the admin-only refusal was
 * deleted. So the checks here read the EXECUTABLE text of each function and
 * assert that the check is there, that it comes before the first write, and
 * that the vocabulary is the same list in every place it is written down.
 *
 * Run: node --test supabase/tests/roles_capabilities_parity.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIG = join(ROOT, "migrations", "20261022143000_roles_capabilities_invitations.sql");
const VERIFY = join(ROOT, "tests", "verify_20261022143000_roles_capabilities.sql");
const CAPS = join(ROOT, "..", "apps", "mobile", "src", "services", "appCapabilities.ts");
const CLIENT_ROLES = join(ROOT, "..", "apps", "mobile", "src", "services", "roles.ts");
const read = (p) => readFileSync(p, "utf8");

const sql = read(MIG);
const verify = read(VERIFY);
const lower = sql.toLowerCase();

/**
 * Remove the comments WITHOUT touching the text inside a string literal, so
 * that the prose in the header cannot satisfy a check about the executable
 * text (and a string that happens to contain "--" survives).
 */
function stripComments(source) {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "'") {
      out += ch;
      i += 1;
      while (i < source.length) {
        out += source[i];
        if (source[i] === "'") {
          if (source[i + 1] === "'") {
            out += source[i + 1];
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (ch === "-" && source[i + 1] === "-") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

const code = stripComments(sql);

const PRIVILEGED_TABLES = [
  "user_roles",
  "user_role_capabilities",
  "role_invitations",
  "bootstrap_admins",
  "admin_audit_log",
];

/**
 * The header (signature and attributes) and the body of one declared
 * function, split at the dollar-quoted body. The extraction is by name and
 * by delimiter, never by a fragile pattern, so the guard keeps working when
 * the signature is written on one line or on three.
 */
function functionParts(name) {
  const marker = `create or replace function public.${name}(`;
  const start = code.indexOf(marker);
  if (start < 0) return null;
  const asAt = code.indexOf("as $$", start);
  if (asAt < 0) return null;
  const bodyStart = asAt + "as $$".length;
  const bodyEnd = code.indexOf("$$;", bodyStart);
  if (bodyEnd < 0) return null;
  return { header: code.slice(start, asAt), body: code.slice(bodyStart, bodyEnd) };
}

function functionBody(name) {
  const parts = functionParts(name);
  return parts ? parts.body : "";
}

/** The first position of any write statement in a body, or -1. */
function firstWrite(body) {
  const patterns = [
    /\binsert\s+into\b/i,
    /\bupdate\s+public\./i,
    /\bdelete\s+from\b/i,
  ];
  let best = -1;
  for (const pattern of patterns) {
    const match = pattern.exec(body);
    if (match && (best < 0 || match.index < best)) best = match.index;
  }
  return best;
}

/** The quoted identifiers of a list literal, in the order they are written. */
function quotedList(text) {
  return [...text.matchAll(/'([a-z_]+)'|"([a-z_]+)"/g)].map((match) => match[1] ?? match[2]);
}

/**
 * The condition a check is written with, as it appears in the source.
 *
 * A guard that only asks "is the phrase somewhere in the file" is blind to
 * the condition the phrase sits in: `if not findback_can('roles_manage')
 * and false then` still contains the phrase, and still refuses nobody. So
 * the checks below read the CONDITION, not the phrase.
 */
function conditionOf(body, marker) {
  const at = body.search(marker);
  if (at < 0) return null;
  // Walk back to the nearest STANDALONE `if` keyword: the letters "if"
  // inside a word ("invitation", "if any") are not a condition.
  let start = -1;
  for (let i = at; i >= 0; i -= 1) {
    if (body.slice(i, i + 2) !== "if") continue;
    const before = i === 0 ? " " : body[i - 1];
    const after = body[i + 2] ?? " ";
    if (!/\s/.test(before) || !/\s/.test(after)) continue;
    start = i;
    break;
  }
  if (start < 0) return null;
  // The condition ends at its own `then`. The parentheses inside it must be
  // balanced, so a `then` that belongs to an inner call is not taken as the
  // end of the condition.
  let depth = 0;
  for (let i = start; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth < 0) return null;
    } else if (depth === 0 && /t/.test(ch)) {
      const word = body.slice(i, i + 4);
      if (/^then\b/.test(word)) {
        return body.slice(start, i + 4);
      }
    }
  }
  return null;
}

const ADMIN_ONLY = ["roles_manage", "settings_manage", "data_export", "data_delete"];

const MODERATOR_CAPABILITIES = [
  "reports_review",
  "content_hide",
  "content_remove",
  "members_warn",
  "members_restrict",
  "members_suspend",
  "feedback_read",
  "appeals_review",
  "audit_read",
  "matches_confirm",
];

const EXPECTED_VOCABULARY = [...MODERATOR_CAPABILITIES, ...ADMIN_ONLY];

/** The privileged RPCs and the capability each of them demands. */
const PRIVILEGED_RPCS = {
  findback_role_grant: "roles_manage",
  findback_role_set_capabilities: "roles_manage",
  findback_role_revoke: "roles_manage",
  findback_role_assignments: "roles_manage",
  findback_role_invitations: "roles_manage",
  findback_audit_log: "audit_read",
};

describe("the roles migration is shaped for the hosted schema", () => {
  it("creates the role source, the capability matrix, the invitations, the allowlist and the audit log", () => {
    for (const table of PRIVILEGED_TABLES) {
      assert.match(
        sql,
        new RegExp(`create table if not exists public\\.${table}\\s*\\(`, "i"),
        `public.${table} is created`,
      );
    }
    // D34: the role source has no client-writable role column on users.
    const userRoles = sql.match(/create table if not exists public\.user_roles \(([\s\S]*?)\n\);/i);
    assert.ok(userRoles, "public.user_roles is created");
    assert.match(userRoles[1], /user_id\s+text\s+not\s+null\s+references\s+public\.users\(id\)\s+on delete cascade/i);
    assert.match(userRoles[1], /role\s+text\s+not\s+null\s+check \(role in \('MODERATOR', 'ADMIN'\)\)/i);
    assert.match(userRoles[1], /granted_by\s+text\s+null\s+references\s+public\.users\(id\)\s+on delete set null/i);
    assert.match(userRoles[1], /granted_at\s+text\s+not\s+null/i);
    assert.match(userRoles[1], /primary key \(user_id, role\)/i);

    // A2.1: the capability matrix is a sibling relation, not a JSON blob.
    const caps = sql.match(
      /create table if not exists public\.user_role_capabilities \(([\s\S]*?)\n\);/i,
    );
    assert.ok(caps, "public.user_role_capabilities is created");
    assert.match(caps[1], /capability\s+text\s+not\s+null\s+check/i);
    assert.match(caps[1], /primary key \(user_id, capability\)/i);
    assert.doesNotMatch(caps[1], /jsonb/i, "the capability matrix is not a JSON blob");

    // A2.3: the invitation carries an email, a role and a capability set.
    const inv = sql.match(/create table if not exists public\.role_invitations \(([\s\S]*?)\n\);/i);
    assert.ok(inv, "public.role_invitations is created");
    assert.match(inv[1], /email\s+text\s+not\s+null/i);
    assert.match(inv[1], /capabilities\s+text\[\]\s+not\s+null\s+default\s+'\{\}'/i);
    assert.match(inv[1], /accepted_at\s+text\s+null/i);
    assert.match(inv[1], /revoked_at\s+text\s+null/i);
    // A pending invitation may not carry a capability outside the vocabulary.
    assert.match(inv[1], /check\s*\(\s*capabilities\s*<@\s*array\[/i);

    // D37: the audit log is the append-only action record.
    const audit = sql.match(/create table if not exists public\.admin_audit_log \(([\s\S]*?)\n\);/i);
    assert.ok(audit, "public.admin_audit_log is created");
    assert.match(audit[1], /actor_user_id\s+text\s+null\s+references\s+public\.users\(id\)\s+on delete set null/i);
    assert.match(audit[1], /action\s+text\s+not\s+null/i);
    assert.match(audit[1], /target_type\s+text\s+not\s+null/i);
    assert.match(audit[1], /target_id\s+text\s+not\s+null/i);
    assert.match(audit[1], /reason\s+text/i);
    assert.match(audit[1], /previous_state\s+jsonb/i);
    assert.match(audit[1], /new_state\s+jsonb/i);
  });

  it("ungrants every privileged table and enables RLS on it (D36)", () => {
    for (const table of PRIVILEGED_TABLES) {
      assert.match(
        code,
        new RegExp(`alter table public\\.${table}\\s+enable row level security;`, "i"),
        `public.${table} has RLS enabled`,
      );
      assert.match(
        code,
        new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated;`, "i"),
        `public.${table} is ungranted to the consumer roles`,
      );
    }
    // The fact-#14 trap: a table grant must never be added back.
    assert.doesNotMatch(
      code,
      /grant\s+[^;]*on\s+table\s+public\.(user_roles|user_role_capabilities|role_invitations|bootstrap_admins|admin_audit_log)/i,
      "no table grant is added to a privileged table",
    );
  });

  it("keeps the audit log append-only (D37)", () => {
    assert.doesNotMatch(
      code,
      /grant\s+[^;]*\b(update|delete|insert)\b[^;]*admin_audit_log/i,
      "the audit log is granted no write path",
    );
    assert.doesNotMatch(
      code,
      /update\s+public\.admin_audit_log|delete\s+from\s+public\.admin_audit_log/i,
      "the audit log is never updated or deleted",
    );
  });

  it("declares the predicates as definer, stable and revoked to anon (D35, A2.2)", () => {
    for (const name of ["findback_has_role", "findback_can", "findback_my_role"]) {
      const parts = functionParts(name);
      assert.ok(parts, `public.${name} is declared`);
      assert.match(parts.header, /language\s+plpgsql/i);
      assert.match(parts.header, /stable/i);
      assert.match(parts.header, /security\s+definer/i);
      assert.match(parts.header, /set\s+search_path\s*=\s*public,\s*pg_temp/i);
      assert.match(
        code,
        new RegExp(`revoke all on function public\\.${name}\\([^)]*\\) from public, anon;`, "i"),
        `public.${name} is revoked from anon`,
      );
    }
    for (const name of ["findback_has_role", "findback_can"]) {
      assert.match(
        code,
        new RegExp(`grant execute on function public\\.${name}\\(text\\) to authenticated;`, "i"),
        `public.${name} is executable by a signed-in caller`,
      );
    }
    // A predicate never writes: a STABLE function that wrote would not see
    // its own write.
    for (const name of ["findback_has_role", "findback_can", "findback_my_role"]) {
      const body = functionBody(name);
      assert.equal(firstWrite(body), -1, `public.${name} writes nothing`);
      assert.doesNotMatch(body, /findback_attach_pending_role/i, `public.${name} attaches nothing`);
    }
  });

  it("makes the capability predicate refuse a revoked account (A2.3)", () => {
    const body = functionBody("findback_can");
    assert.ok(body, "public.findback_can is declared");

    // The ADMIN branch: an admin holds every capability, and that early
    // return is INSIDE an exists() — never an unconditional `return true`.
    assert.match(
      body,
      /if\s+exists\s*\(\s*select\s+1\s+from\s+public\.user_roles\s+r[\s\S]*?role\s*=\s*'ADMIN'[\s\S]*?\)\s*then\s+return\s+true;/i,
      "the ADMIN branch is an exists() that returns true",
    );
    const trueCount = (body.match(/return\s+true\s*;/gi) ?? []).length;
    assert.equal(trueCount, 1, "there is exactly one unconditional-true return, and it is the ADMIN branch");

    // The moderator branch: the capability row only counts while the account
    // still HOLDS the moderator role.
    assert.match(
      body,
      /return\s+exists\s*\(\s*select\s+1\s+from\s+public\.user_role_capabilities\s+c\s+join\s+public\.user_roles\s+r/i,
      "the capability lookup joins the live role",
    );
    assert.match(body, /and\s+r\.role\s*=\s*'MODERATOR'/i, "the join requires the MODERATOR role");
    assert.match(
      body,
      /and\s+c\.capability\s*=\s*p_capability/i,
      "the lookup is for the asked-for capability",
    );
  });

  it("reports only the capabilities of a live role (A2.3)", () => {
    const body = functionBody("findback_my_role");
    assert.match(
      body,
      /from\s+public\.user_role_capabilities\s+c\s+join\s+public\.user_roles\s+r/i,
      "the reported capabilities are joined to the role table",
    );
    assert.match(body, /and\s+r\.role\s*=\s*'MODERATOR'/i, "the join requires a live moderator role");
  });

  it("checks the capability BEFORE the first write in every privileged RPC (A2.6)", () => {
    for (const [name, capability] of Object.entries(PRIVILEGED_RPCS)) {
      const parts = functionParts(name);
      assert.ok(parts, `public.${name} is declared`);
      const body = parts.body;

      const checkAt = body.search(new RegExp(`findback_can\\('${capability}'\\)`, "i"));
      assert.ok(checkAt >= 0, `public.${name} demands the ${capability} capability`);

      const writeAt = firstWrite(body);
      assert.ok(
        writeAt < 0 || checkAt < writeAt,
        `public.${name} checks the capability before it writes anything`,
      );

      // The refusal is a 42501 with a message of its own.
      assert.match(
        body,
        /raise\s+exception\s+'[^']*'\s+using\s+errcode\s*=\s*'42501'/i,
        `public.${name} refuses with 42501`,
      );
      assert.match(parts.header, /security\s+definer/i, `public.${name} is a definer`);
      assert.match(
        parts.header,
        /set\s+search_path\s*=\s*public,\s*pg_temp\s*$/i,
        `public.${name} pins the search path exactly`,
      );
      assert.match(
        code,
        new RegExp(`revoke all on function public\\.${name}\\([^)]*\\) from public, anon;`, "i"),
        `public.${name} is revoked from anon`,
      );
    }
  });

  it("makes the capability check a REAL condition, not a phrase (A2.6)", () => {
    // `if not findback_can('roles_manage') and false then` contains the
    // phrase and refuses nobody. The check must be the WHOLE condition.
    for (const [name, capability] of Object.entries(PRIVILEGED_RPCS)) {
      const body = functionBody(name);
      const condition = conditionOf(body, new RegExp(`findback_can\\('${capability}'\\)`, "i"));
      assert.ok(condition, `public.${name} has a condition around its capability check`);
      assert.match(
        condition,
        new RegExp(`^\\s*if\\s+not\\s+public\\.findback_can\\('${capability}'\\)\\s+then$`, "i"),
        `public.${name} refuses on the capability check alone (got: ${condition.trim()})`,
      );
    }

    // A condition that is neutralised by a constant is not a condition.
    // Nothing in this chain may carry one: `and false` disables a check,
    // `or true` forces a branch.
    assert.doesNotMatch(
      code,
      /\band\s+false\b|\bor\s+true\b|\band\s+true\b|\bor\s+false\b/i,
      "no condition in the migration is neutralised by a constant",
    );
  });

  it("re-authorizes UNDER the lock in every role mutation (review HIGH 1)", () => {
    // The pre-lock capability check is a fast refusal only. A caller that
    // passes it and then waits on the lock may have its role revoked while it
    // waits; without a check AFTER the lock it would act on permission it no
    // longer holds. The re-check must exist, be the same real condition, and
    // still come before anything is written.
    for (const name of ["findback_role_grant", "findback_role_set_capabilities", "findback_role_revoke"]) {
      const body = functionBody(name);
      assert.ok(body, `public.${name} is declared`);
      const lockAt = body.search(/pg_advisory_xact_lock\(\s*20261022143000\s*\)/i);
      assert.ok(lockAt >= 0, `public.${name} takes the role lock`);

      const after = body.slice(lockAt);
      const rechecks = [...after.matchAll(/if\s+not\s+public\.findback_can\('roles_manage'\)\s+then/gi)];
      assert.equal(
        rechecks.length,
        1,
        `public.${name} re-authorizes exactly once after the lock (found ${rechecks.length})`,
      );

      const writeAt = firstWrite(after);
      assert.ok(
        writeAt < 0 || rechecks[0].index < writeAt,
        `public.${name} re-authorizes before it writes anything after the lock`,
      );

      // The re-check refuses with the same 42501 and its own message: a
      // silent `return` would leave the caller believing the mutation applied.
      const recheckText = after.slice(rechecks[0].index, rechecks[0].index + 400);
      assert.match(recheckText, /raise\s+exception\s+'[^']*'\s+using\s+errcode\s*=\s*'42501'/i,
        `public.${name} refuses the queued caller with 42501`);
    }
  });

  it("never lets an UNVERIFIED account consume the seeded invitation (review HIGH 2)", () => {
    // The seed attaches the moderator invitation immediately when the address
    // already has an account. An unconfirmed address is not proof that the
    // account belongs to the invitee, so the attach must be gated on the
    // profile's own verification flag, exactly as the insert trigger is.
    const doAt = code.search(/\bdo\s+\$\$/i);
    assert.ok(doAt >= 0, "the seed runs a DO block");
    const bodyStart = code.indexOf("$$", doAt) + 2;
    const bodyEnd = code.indexOf("$$;", bodyStart);
    assert.ok(bodyEnd > bodyStart, "the seed DO block is terminated");
    const seed = code.slice(bodyStart, bodyEnd);

    assert.match(seed, /select\s+u\.id\s*,\s*u\.email_verified/i,
      "the seed reads the account's verification state");
    assert.match(seed, /email_verified\s*=\s*1/i,
      "the seed requires a CONFIRMED address");
    assert.match(
      seed,
      /if\s+v_user_id\s+is\s+not\s+null\s+and\s+v_email_verified\s*=\s*1\s+then/i,
      "the verified check guards the attach instead of sitting beside it",
    );
    // The attach is inside that condition: the `perform` comes after the `if`
    // and before its `end if`.
    const guardAt = seed.search(/if\s+v_user_id\s+is\s+not\s+null\s+and\s+v_email_verified\s*=\s*1\s+then/i);
    const attachAt = seed.search(/findback_attach_pending_role\(/i);
    const endIfAt = seed.indexOf("end if", guardAt);
    assert.ok(attachAt > guardAt && attachAt < endIfAt,
      "the seed attaches only inside the verified branch");
  });

  it("audits the state a mutation REPLACES, not a placeholder (review MEDIUM 1)", () => {
    // previous_state is the only record of what the person held before the
    // change. A literal `null` / `'role', null` answers a question nobody can
    // answer later, so each mutation must snapshot the real before-state.
    const grant = functionBody("findback_role_grant");
    assert.ok(grant, "public.findback_role_grant is declared");
    assert.match(grant, /select\s+r\.role\s+into\s+v_previous_role/i,
      "the grant reads the role it replaces");
    assert.match(grant, /into\s+v_previous_capabilities/i,
      "the grant reads the capability set it replaces");
    const grantAudit = grant.slice(grant.search(/'ROLE_GRANTED'/i));
    assert.match(grantAudit, /'role'\s*,\s*v_previous_role/i,
      "ROLE_GRANTED records the previous role");
    assert.match(grantAudit, /'capabilities'\s*,\s*to_jsonb\(v_previous_capabilities\)/i,
      "ROLE_GRANTED records the previous capability set");
    assert.doesNotMatch(
      grantAudit,
      /'role'\s*,\s*null\s*,\s*'capabilities'\s*,\s*'\[\]'::jsonb/i,
      "ROLE_GRANTED does not keep the empty placeholder as its previous state",
    );

    const setCaps = functionBody("findback_role_set_capabilities");
    assert.ok(setCaps, "public.findback_role_set_capabilities is declared");
    assert.match(setCaps, /into\s+v_invitation_role\s*,\s*v_invitation_capabilities/i,
      "the capability edit reads the invitation set it replaces");
    const inviteAudit = setCaps.slice(setCaps.search(/'INVITATION_CAPABILITIES_CHANGED'/i));
    assert.match(inviteAudit, /to_jsonb\(coalesce\(v_invitation_capabilities,\s*'\{\}'\)\)/i,
      "INVITATION_CAPABILITIES_CHANGED records the previous capability set");
    assert.doesNotMatch(
      inviteAudit,
      /'Capability set changed on a pending invitation'\s*,\s*null\s*,/i,
      "the invitation audit does not pass a NULL previous state",
    );
  });

  it("makes the one-time claim REPLACE a held role and audit what it removed", () => {
    // A claim by an account that already holds MODERATOR must not leave both
    // rows behind, and the audit row must say what was there — the same rule
    // the grant follows.
    const claim = functionBody("findback_bootstrap_admin");
    assert.ok(claim, "public.findback_bootstrap_admin is declared");

    const deleteRoleAt = claim.search(/delete\s+from\s+public\.user_roles\s+r\s+where\s+r\.user_id\s*=\s*v_uid\s+and\s+r\.role\s*<>\s*'ADMIN'/i);
    assert.ok(deleteRoleAt >= 0, "the claim deletes a non-ADMIN role row for the caller");
    assert.match(
      claim,
      /delete\s+from\s+public\.user_role_capabilities\s+c\s+where\s+c\.user_id\s*=\s*v_uid/i,
      "the claim clears the caller's capability rows",
    );

    const snapshotAt = claim.search(/select\s+r\.role\s+into\s+v_previous_role/i);
    assert.ok(snapshotAt >= 0 && snapshotAt < deleteRoleAt, "the claim snapshots the replaced role BEFORE deleting it");
    assert.match(claim, /into\s+v_previous_capabilities/i, "the claim snapshots the replaced capability set");
    assert.match(
      claim,
      /'role'\s*,\s*v_previous_role/i,
      "BOOTSTRAP_ADMIN records the previous role",
    );
    assert.doesNotMatch(
      claim,
      /'First admin claim from the bootstrap allowlist'\s*,\s*jsonb_build_object\('role'\s*,\s*null\)/i,
      "BOOTSTRAP_ADMIN no longer writes a hard-coded null previous state",
    );
  });

  it("takes the SAME advisory lock in every mutation that can change the admin set (A2.3)", () => {    const keys = {};
    for (const name of [
      "findback_bootstrap_admin",
      "findback_role_grant",
      "findback_role_revoke",
      "findback_attach_pending_role",
    ]) {
      const body = functionBody(name);
      const match = body.match(/pg_advisory_xact_lock\(\s*(\d+)\s*\)/i);
      assert.ok(match, `public.${name} takes an advisory lock`);
      keys[name] = match[1];
    }
    const distinct = new Set(Object.values(keys));
    assert.equal(
      distinct.size,
      1,
      `every admin-set mutation takes the SAME lock key (got ${JSON.stringify(keys)})`,
    );
  });

  it("really demotes when a grant replaces a role set (A2.3)", () => {
    const grant = functionBody("findback_role_grant");
    assert.match(
      grant,
      /delete\s+from\s+public\.user_roles\s+r\s+where\s+r\.user_id\s*=\s*v_user_id\s+and\s+r\.role\s*<>\s*p_role/i,
      "the grant removes the roles it replaces",
    );
    assert.match(
      grant,
      /v_admin_count\s*<=\s*1/i,
      "the grant refuses to demote the last admin",
    );
  });

  it("replaces the role set when an invitation is consumed (A2.3)", () => {
    const attach = functionBody("findback_attach_pending_role");
    assert.match(
      attach,
      /delete\s+from\s+public\.user_roles\s+r\s+where\s+r\.user_id\s*=\s*p_user_id\s+and\s+r\.role\s*<>\s*v_inv_role/i,
      "the attachment removes the roles it replaces",
    );
    assert.match(attach, /pg_advisory_xact_lock/i, "the attachment is serialized");
  });

  it("reads the invitation into SCALARS, never into the composite row (BLOCKER-1)", () => {
    // A composite target is filled BY POSITION: a four-column list poured
    // into the eight-field `public.role_invitations` row type would put the
    // text[] capability column into the row's text role column and raise
    // "cannot cast type text[] to text" on every single call.
    const attach = functionBody("findback_attach_pending_role");
    assert.doesNotMatch(
      attach,
      /into\s+v_inv\b/i,
      "the invitation is not read into a composite variable",
    );
    assert.doesNotMatch(
      attach,
      /v_inv\s+public\.role_invitations/i,
      "no composite variable of the invitation row type is declared",
    );
    assert.match(
      attach,
      /into\s+v_inv_id,\s*v_inv_role,\s*v_inv_caps,\s*v_inv_by/i,
      "the invitation is read into four scalar variables",
    );
    // The capability loop must be real: it stores the invited capabilities.
    assert.match(
      attach,
      /foreach\s+v_capability\s+in\s+array\s+coalesce\(v_inv_caps,\s*'\{\}'\)\s+loop/i,
      "the attachment stores the invited capability set",
    );
    assert.match(
      attach,
      /insert\s+into\s+public\.user_role_capabilities/i,
      "the attachment writes the capability rows",
    );
  });

  it("refuses a NULL capability element everywhere one is accepted (A2.1)", () => {
    for (const name of ["findback_role_grant", "findback_role_set_capabilities"]) {
      const body = functionBody(name);
      assert.match(
        body,
        /if\s+v_capability\s+is\s+null\s+then/i,
        `public.${name} refuses a NULL capability element`,
      );
    }
  });

  it("refuses an ADMIN account's capability set instead of editing something else (A2.3)", () => {
    const body = functionBody("findback_role_set_capabilities");
    assert.match(
      body,
      /if\s+v_account_role\s*=\s*'ADMIN'\s+then\s+raise\s+exception/i,
      "an admin account is refused by name",
    );
    assert.match(
      body,
      /if\s+v_effective_role\s+is\s+null\s+then\s+raise\s+exception/i,
      "an address with neither an assigned role nor a live invitation is refused",
    );
    // An assigned role takes precedence; a roleless sign-up can still configure
    // its live invitation (the R3 guard previously pinned the actual defect).
    assert.match(
      body,
      /v_effective_role\s*:=\s*coalesce\(v_account_role,\s*v_invitation_role\)/i,
      "an assigned account role wins; a live invitation remains reachable otherwise",
    );
    assert.match(body, /if\s+v_account_role\s+is\s+not\s+null\s+then/i);
  });

  it("pins invitation/revoke ordering, exact identity lookup and the audit actor", () => {
    const compact = (name) => functionBody(name).replace(/\s+/g, " ").trim();
    const attach = compact("findback_attach_pending_role");
    assert.match(attach, /limit 1 for update; if not found then return; end if;/);
    assert.ok(attach.indexOf("pg_advisory_xact_lock(") < attach.indexOf("select r.id, r.role"), "advisory lock precedes the invitation row lock");
    assert.match(attach, /delete from public\.user_role_capabilities c where c\.user_id = p_user_id;/);
    assert.match(attach, /and \(v_inv_role = 'ADMIN' or v_capability <> all \(public\.findback_admin_capabilities\(\)\)\)/);
    const revoke = compact("findback_role_revoke");
    const lockAt = revoke.indexOf("pg_advisory_xact_lock(");
    const countAt = revoke.indexOf("select count(*) into v_admin_count");
    const deleteAt = revoke.indexOf("delete from public.user_roles r");
    const diagnosticsAt = revoke.indexOf("get diagnostics v_role_count = row_count;");
    assert.ok(lockAt >= 0 && countAt > lockAt && deleteAt > countAt && diagnosticsAt > deleteAt);
    assert.match(revoke, /select count\(\*\) into v_admin_count from public\.user_roles r where r\.role = 'ADMIN';/);
    assert.match(revoke, /else v_role_count := 0; end if;/);
    const grant = compact("findback_role_grant");
    assert.match(grant, /select u\.id into v_user_id from public\.users u where lower\(btrim\(u\.email\)\) = v_email limit 1;/);
    assert.match(compact("findback_write_audit"), /values \( gen_random_uuid\(\)::text, auth\.uid\(\)::text, p_action,/);
  });

  it("keeps the invitation attach helper unreachable by every client role", () => {
    assert.match(code, /revoke all on function public\.findback_attach_pending_role\(text, text\) from public, anon, authenticated;/i);
    assert.doesNotMatch(code, /grant\s+execute\s+on\s+function\s+public\.findback_attach_pending_role\([^)]*\)\s+to\s+(?:public|anon|authenticated)/i);
  });

  it("reports an ADMIN in the team list with the whole vocabulary (A2.2)", () => {
    const body = functionBody("findback_role_assignments");
    assert.match(
      body,
      /when\s+r\.role\s*=\s*'ADMIN'\s+then\s+public\.findback_capability_vocabulary\(\)/i,
      "the team list gives an admin the full vocabulary",
    );
  });

  it("gives the admin the whole vocabulary only when the caller IS an admin (A2.2)", () => {
    const body = functionBody("findback_my_role");
    assert.match(
      body,
      /if\s+v_role\s*=\s*'ADMIN'\s+then[\s\S]{0,200}v_caps\s*:=\s*public\.findback_capability_vocabulary\(\);[\s\S]{0,40}end\s+if;/i,
      "the full vocabulary is handed out inside the admin branch",
    );
  });

  it("demands a confirmed address with a REAL condition (A2.4)", () => {
    const claim = functionBody("findback_bootstrap_admin");
    const condition = conditionOf(claim, /coalesce\(\s*v_verified/i);
    assert.ok(condition, "the claim has a condition around the confirmed-address check");
    assert.match(
      condition,
      /^\s*if\s+coalesce\(\s*v_verified\s*,\s*0\s*\)\s*<>\s*1\s+then$/i,
      `the claim demands a confirmed address on its own (got: ${condition.trim()})`,
    );
  });

  it("refuses a revoke that removed nothing, on a REAL condition (A2.3)", () => {
    const revoke = functionBody("findback_role_revoke");
    const condition = conditionOf(revoke, /No role assignment or pending invitation/i);
    assert.ok(condition, "the revoke has a condition around its nothing-there refusal");
    assert.match(
      condition,
      /^\s*if\s+v_role_count\s*=\s*0\s+and\s+v_invitation_count\s*=\s*0\s+then$/i,
      `the refusal needs BOTH counts to be zero (got: ${condition.trim()})`,
    );
    // The counts must be the rows actually removed.
    assert.match(
      revoke,
      /get\s+diagnostics\s+v_role_count\s*=\s*row_count/i,
      "the role count is the number of removed rows",
    );
    assert.match(
      revoke,
      /get\s+diagnostics\s+v_invitation_count\s*=\s*row_count/i,
      "the invitation count is the number of cancelled rows",
    );
  });

  it("makes the invitation triggers definers, and drops before it creates (A2.3)", () => {
    for (const name of [
      "handle_role_invitation_on_auth_user_created",
      "handle_role_invitation_on_auth_user_confirmed",
      "handle_role_invitation_on_profile_created",
    ]) {
      const parts = functionParts(name);
      assert.ok(parts, `public.${name} is declared`);
      assert.match(parts.header, /security\s+definer/i, `public.${name} is a definer`);
      assert.match(
        parts.header,
        /set\s+search_path\s*=\s*public,\s*pg_temp\s*$/i,
        `public.${name} pins the search path`,
      );
    }
    for (const trigger of [
      "on_role_invitation_auth_user_created",
      "on_role_invitation_auth_user_confirmed",
      "on_role_invitation_profile_created",
    ]) {
      const dropAt = code.search(new RegExp(`drop\\s+trigger\\s+if\\s+exists\\s+${trigger}\\b`, "i"));
      const createAt = code.search(new RegExp(`create\\s+trigger\\s+${trigger}\\b`, "i"));
      assert.ok(dropAt >= 0, `the ${trigger} trigger is dropped before it is created`);
      assert.ok(createAt > dropAt, `the ${trigger} trigger is created after its drop`);
    }
  });

  it("attaches the seeded moderator when that account already exists (A2.4)", () => {
    assert.match(
      code,
      /do\s+\$\$[\s\S]*?findback_attach_pending_role\([\s\S]*?\$\$;/i,
      "the seed attaches the seeded invitation to an existing account",
    );
  });

  it("never lets a moderator hold an admin-only capability (A2.1)", () => {
    // The refusal must exist in BOTH places that store a capability set, and
    // it must come before anything is written.
    for (const name of ["findback_role_grant", "findback_role_set_capabilities"]) {
      const body = functionBody(name);
      assert.ok(body, `public.${name} is declared`);
      assert.match(
        body,
        /findback_admin_capabilities\(\)/i,
        `public.${name} consults the admin-only set`,
      );
      const refusalAt = body.search(
        /raise\s+exception\s+'Capability % is admin-only[^']*'\s*,\s*v_capability\s+using\s+errcode\s*=\s*'22023'/i,
      );
      assert.ok(refusalAt >= 0, `public.${name} refuses an admin-only capability`);
      const writeAt = firstWrite(body);
      assert.ok(
        writeAt < 0 || refusalAt < writeAt,
        `public.${name} refuses an admin-only capability before it writes anything`,
      );
    }
  });

  it("writes one audit row for every mutation (D37)", () => {
    const expected = {
      findback_role_grant: ["ROLE_GRANTED", "ROLE_INVITED"],
      findback_role_set_capabilities: ["CAPABILITIES_CHANGED", "INVITATION_CAPABILITIES_CHANGED"],
      findback_role_revoke: ["ROLE_REVOKED"],
      findback_bootstrap_admin: ["BOOTSTRAP_ADMIN"],
      findback_attach_pending_role: ["INVITATION_ACCEPTED"],
    };
    for (const [name, actions] of Object.entries(expected)) {
      const body = functionBody(name);
      assert.ok(body, `public.${name} is declared`);
      assert.match(body, /perform\s+public\.findback_write_audit\(/i, `public.${name} writes an audit row`);
      for (const action of actions) {
        assert.match(
          body,
          new RegExp(`'${action}'`),
          `public.${name} writes a ${action} audit row`,
        );
      }
    }
    // The audit writer itself is unreachable by any client role.
    assert.match(
      code,
      /revoke all on function public\.findback_write_audit\([^)]*\) from public, anon, authenticated;/i,
      "the audit writer is revoked from every client role",
    );
  });

  it("names the SAME capability list everywhere it is written down (A2.1)", () => {
    // 1. the vocabulary function
    const vocabulary = functionBody("findback_capability_vocabulary");
    assert.ok(vocabulary, "public.findback_capability_vocabulary is declared");
    const vocabularyList = quotedList(vocabulary);
    assert.deepEqual(
      vocabularyList,
      EXPECTED_VOCABULARY,
      "the vocabulary function holds the agreed capability list",
    );

    // 2. the CHECK on the capability matrix
    const capsCheck = code.match(
      /capability\s+text\s+not\s+null\s+check\s*\(\s*capability\s+in\s*\(([\s\S]*?)\)\s*\)/i,
    );
    assert.ok(capsCheck, "the capability matrix has a vocabulary CHECK");
    assert.deepEqual(
      quotedList(capsCheck[1]),
      EXPECTED_VOCABULARY,
      "the CHECK on the capability matrix holds the agreed capability list",
    );

    // 3. the CHECK on a pending invitation
    const invCheck = code.match(
      /capabilities\s+text\[\][\s\S]*?check\s*\(\s*capabilities\s*<@\s*array\[([\s\S]*?)\]\s*\)/i,
    );
    assert.ok(invCheck, "a pending invitation has a vocabulary CHECK");
    assert.deepEqual(
      quotedList(invCheck[1]),
      EXPECTED_VOCABULARY,
      "the CHECK on a pending invitation holds the agreed capability list",
    );

    // 4. the client
    const client = read(CLIENT_ROLES);
    const clientModerator = client.match(
      /export const MODERATOR_CAPABILITIES = \[([\s\S]*?)\] as const;/,
    );
    const clientAdmin = client.match(
      /export const ADMIN_ONLY_CAPABILITIES = \[([\s\S]*?)\] as const;/,
    );
    assert.ok(clientModerator, "the client names the moderator capabilities");
    assert.ok(clientAdmin, "the client names the admin-only capabilities");
    const clientList = [
      ...quotedList(clientModerator[1]),
      ...quotedList(clientAdmin[1]),
    ];
    assert.deepEqual(
      clientList,
      EXPECTED_VOCABULARY,
      "the client holds the same capability list as the database",
    );
  });

  it("guards the last admin, exactly (A2.3)", () => {
    const revoke = functionBody("findback_role_revoke");
    assert.match(revoke, /v_admin_count\s*<=\s*1/i, "the revoke refuses the last admin");
    assert.match(revoke, /The last admin cannot be revoked/i);
    assert.match(revoke, /42501/i, "the last-admin refusal is a 42501");
    // The count and the delete are ONE critical section.
    assert.match(revoke, /pg_advisory_xact_lock/i, "the revoke is serialized");

    // A demotion is the same danger: the last admin may not be demoted.
    const grant = functionBody("findback_role_grant");
    assert.match(grant, /v_admin_count\s*<=\s*1/i, "the grant refuses to demote the last admin");
    assert.match(grant, /The last admin cannot be demoted/i);
    assert.match(grant, /pg_advisory_xact_lock/i, "the grant is serialized");
  });

  it("takes the capability rows away with the role (A2.3)", () => {
    const revoke = functionBody("findback_role_revoke");
    assert.match(
      revoke,
      /delete\s+from\s+public\.user_role_capabilities/i,
      "the revoke deletes the capability rows too",
    );
  });

  it("refuses a revoke of an address that has nothing (M7)", () => {
    const revoke = functionBody("findback_role_revoke");
    assert.match(
      revoke,
      /raise\s+exception\s+'No role assignment or pending invitation for that address'\s+using\s+errcode\s*=\s*'22023'/i,
      "a revoke of an unknown address is refused by name",
    );
  });

  it("claims the admin once, atomically, and only from the allowlist", () => {
    const claim = functionBody("findback_bootstrap_admin");
    assert.match(claim, /pg_advisory_xact_lock/i, "the claim is serialized");
    assert.match(claim, /bootstrap_admins/i, "the claim consults the allowlist");
    assert.match(claim, /An admin already exists/i, "the claim is refused once an admin exists");
    assert.match(claim, /findback_write_audit/i, "the claim is audited");
    assert.match(claim, /not authenticated/i, "an anonymous caller is refused");
    // Only a confirmed address may claim it.
    assert.match(
      claim,
      /coalesce\(\s*v_verified\s*,\s*0\s*\)\s*<>\s*1|v_verified\s*<>\s*1/i,
      "the claim demands a confirmed address",
    );
  });

  it("seeds the owner's accounts with emails only", () => {
    assert.match(sql, /'sheikhti1205@gmail\.com'/i, "the primary admin email is seeded");
    assert.match(sql, /'sheikhti1205@outlook\.com'/i, "the backup admin email is seeded");
    assert.match(sql, /'sheikhti109@gmail\.com'/i, "the first moderator email is seeded");
    assert.match(
      sql,
      /'sheikhti109@gmail\.com',\s*\n\s*'MODERATOR',\s*\n\s*array\['reports_review', 'content_hide'\]/i,
      "the first moderator is seeded as a MODERATOR with the owner's default capability set",
    );
    // No password, token or key may ever appear in this file.
    assert.doesNotMatch(
      lower,
      /password\s*=|secret\s*=|token\s*=|api[_-]?key\s*=|service_role/,
      "no credential is stored in the migration",
    );
  });

  it("consumes a pending invitation only on a VERIFIED path (A2.3)", () => {
    // The shipped signup trigger function is NOT re-created: an unverified
    // sign-up must not be able to burn an invitation.
    assert.doesNotMatch(
      code,
      /create\s+or\s+replace\s+function\s+public\.handle_new_auth_user/i,
      "the shipped signup trigger function is left alone",
    );

    // The attachment helper itself is the only writer of the invitation.
    const attach = functionBody("findback_attach_pending_role");
    assert.match(attach, /findback_write_audit/i, "the attachment is audited");
    assert.match(
      attach,
      /if\s+not\s+exists\s*\(\s*select\s+1\s+from\s+public\.users/i,
      "the attachment waits for the profile row",
    );
    // The address is the invitation's key: when the caller carries only the
    // account id, the helper must read it from the account itself. Without
    // this the helper is a no-op and no invitation is ever consumed.
    assert.match(
      attach,
      /select\s+lower\(btrim\(u\.email\)\)\s+into\s+v_email\s+from\s+public\.users\s+u\s+where\s+u\.id\s*=\s*p_user_id/i,
      "the attachment resolves the address from the account itself",
    );

    // 1. the confirmed-address path
    const confirmed = functionBody("handle_role_invitation_on_auth_user_confirmed");
    assert.ok(confirmed, "the confirmation trigger function is declared");
    assert.match(
      confirmed,
      /old\.email_confirmed_at\s+is\s+null\s+and\s+new\.email_confirmed_at\s+is\s+not\s+null/i,
      "the confirmation trigger fires only when the address becomes confirmed",
    );
    assert.match(confirmed, /findback_attach_pending_role/i, "the confirmation path attaches");

    // 2. the already-confirmed insert path (a social sign-in)
    const created = functionBody("handle_role_invitation_on_auth_user_created");
    assert.ok(created, "the auth insert trigger function is declared");
    assert.match(
      created,
      /if\s+new\.email_confirmed_at\s+is\s+not\s+null/i,
      "the insert trigger attaches only for an already-confirmed account",
    );
    assert.match(created, /findback_attach_pending_role/i, "the insert path attaches");

    // 3. the verified profile path
    const profile = functionBody("handle_role_invitation_on_profile_created");
    assert.ok(profile, "the profile trigger function is declared");
    assert.match(
      profile,
      /if\s+new\.email_verified\s*=\s*1/i,
      "the profile trigger attaches only for a verified profile row",
    );
    assert.match(profile, /findback_attach_pending_role/i, "the profile path attaches");

    // The triggers exist on the right tables.
    assert.match(
      code,
      /create\s+trigger\s+on_role_invitation_auth_user_confirmed[\s\S]*?after\s+update\s+of\s+email_confirmed_at\s+on\s+auth\.users/i,
      "the confirmation trigger is on auth.users",
    );
    assert.match(
      code,
      /create\s+trigger\s+on_role_invitation_profile_created[\s\S]*?after\s+insert\s+on\s+public\.users/i,
      "the profile trigger is on public.users",
    );
  });

  it("is forward-only and names its verifier", () => {
    assert.match(code, /^\s*begin;/im, "the migration opens a transaction");
    assert.match(code, /commit;\s*$/im, "the migration commits");
    assert.doesNotMatch(code, /drop\s+(table|column|function)\s+(if\s+exists\s+)?public\./i, "nothing is dropped");
    // The header prose names the helper too, so the guard runs on the
    // executable lines only.
    assert.doesNotMatch(code, /now_text\(\)/i, "there is no now_text() helper in this chain");
    assert.match(sql, /supabase\/tests\/verify_20261022143000_roles_capabilities\.sql/i);
    assert.match(sql, /supabase\/tests\/roles_capabilities_parity\.test\.mjs/i);
    // The file never connects to a hosted project.
    assert.doesNotMatch(sql, /supabase\.co|db push|SUPABASE_SERVICE_ROLE/i, "no hosted access from the migration");
  });

  it("advertises the newest schema version on the client", () => {
    const caps = read(CAPS);
    const newest = readdirSync(join(ROOT, "migrations"))
      .map((name) => name.match(/^(\d{14})_/)?.[1])
      .filter((prefix) => prefix !== undefined)
      .sort()
      .at(-1);
    assert.ok(newest, "at least one 14-digit migration prefix exists");
    assert.ok(
      caps.includes(`BACKEND_SCHEMA_VERSION = "${newest}"`),
      `BACKEND_SCHEMA_VERSION names the newest migration prefix (${newest})`,
    );
  });

  it("carries a behavioural verifier that can actually be run", () => {
    assert.match(verify, /findback_has_role|findback_can/i);
    assert.match(verify, /42501/i, "the verifier asserts the refusal code");
    assert.match(verify, /rollback/i, "the verifier rolls its scratch rows back");
    // A refusal inside a transaction ABORTS it, so a verifier that calls a
    // privileged RPC directly can never reach the probes after it. Every
    // refusal must therefore be caught.
    const refusals = [...verify.matchAll(/when\s+insufficient_privilege/gi)];
    assert.ok(
      refusals.length >= 4,
      "the verifier catches the privilege refusals instead of aborting on them",
    );
    assert.doesNotMatch(
      verify,
      /--\s*run each of these/i,
      "the verifier has no commented-out refusal probes",
    );
  });
});
