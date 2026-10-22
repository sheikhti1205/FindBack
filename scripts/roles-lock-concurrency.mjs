/**
 * Two-connection regression: a role mutation that WAITED on the role lock
 * must not act on the permission it held before waiting.
 *
 * The single-transaction probe files cannot express this. The defect only
 * appears with two live sessions: admin B passes the pre-lock capability
 * check, blocks on the advisory lock while admin A revokes B, and then
 * proceeds after A commits. Without a check UNDER the lock, B strips or
 * grants a role with permission it no longer holds.
 *
 * What this script proves, against a disposable local PostgreSQL that has the
 * real migration chain applied:
 *
 *   1. A revokes B while holding the role lock (A's transaction sleeps after
 *      the revoke so B has a real wait).
 *   2. B's queued `findback_role_grant` is refused with SQLSTATE 42501.
 *   3. B is left roleless (A's revoke committed), the target gained nothing,
 *      and no ROLE_GRANTED audit row exists for the target.
 *
 * Node builtins + psql only, like scripts/sql-behavior.mjs. Local loopback
 * database only: this is a platform stub, never hosted acceptance evidence.
 *
 * Run: PGHOST=127.0.0.1 PGDATABASE=findback_sql_test PGUSER=postgres \
 *      node scripts/roles-lock-concurrency.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { assertLocalDatabase } from "./sql-behavior.mjs";

const A = "00000000-0000-4000-8000-0000000c0a01";
const B = "00000000-0000-4000-8000-0000000c0a02";
const C = "00000000-0000-4000-8000-0000000c0a03";
const A_EMAIL = "lock-admin-a@example.invalid";
const B_EMAIL = "lock-admin-b@example.invalid";
const C_EMAIL = "lock-target-c@example.invalid";
const HOLD_SECONDS = 5;

const psql = process.env.PSQL ?? "psql";

function env(extra = {}) {
  return { ...process.env, ...extra };
}

/** One synchronous psql run; throws on a non-zero exit. */
function run(sql, { extraEnv = {} } = {}) {
  const result = spawnSync(psql, ["-X", "-q", "-tA", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
    input: sql,
    encoding: "utf8",
    env: env(extraEnv),
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`psql failed (exit ${result.status})\n${result.stderr}`);
  return result.stdout.trim();
}

/** A single scalar, as text. */
function scalar(sql) {
  const rows = run(sql).split("\n").map((line) => line.trim()).filter(Boolean);
  if (rows.length !== 1) throw new Error(`expected one row, got:\n${rows.join("\n")}`);
  return rows[0];
}

function check(label, actual, expected) {
  if (actual !== expected) {
    console.error(`FAIL ${label}: expected ${expected}, got ${actual}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS ${label}`);
  }
}

assertLocalDatabase(process.env);

// --- arrange -------------------------------------------------------------
// Committed, so the two contending sessions see each other's state. B is an
// ADMIN: it would pass the capability check on its own.
run(`
delete from public.admin_audit_log where target_id in ('${A}', '${B}', '${C}', '${A_EMAIL}', '${B_EMAIL}', '${C_EMAIL}');
delete from public.user_role_capabilities where user_id in ('${A}', '${B}', '${C}');
delete from public.user_roles where user_id in ('${A}', '${B}', '${C}');
delete from public.role_invitations where lower(btrim(email)) like '%@example.invalid';
delete from public.users where id in ('${A}', '${B}', '${C}');
insert into public.users (id, username, email, phone, email_verified, created_at, updated_at) values
  ('${A}', 'lock_admin_a', '${A_EMAIL}', '+8801710000201', 1, '2020-01-01', '2020-01-01'),
  ('${B}', 'lock_admin_b', '${B_EMAIL}', '+8801710000202', 1, '2020-01-01', '2020-01-01'),
  ('${C}', 'lock_target_c', '${C_EMAIL}', '+8801710000203', 1, '2020-01-01', '2020-01-01');
insert into public.user_roles (user_id, role, granted_at) values
  ('${A}', 'ADMIN', '2020-01-01'),
  ('${B}', 'ADMIN', '2020-01-01');
`);

// --- act: A holds the lock and revokes B ----------------------------------
const aSql = `
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '${A}', true);
select public.findback_role_revoke('${B_EMAIL}');
select pg_sleep(${HOLD_SECONDS});
commit;
`;

const a = spawn(psql, ["-X", "-q", "-tA", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
  env: env({ PGAPPNAME: "findback-lock-a" }),
  stdio: ["pipe", "pipe", "pipe"],
});
let aOut = "", aErr = "";
a.stdout.on("data", (chunk) => { aOut += chunk; });
a.stderr.on("data", (chunk) => { aErr += chunk; });
a.stdin.end(aSql);

// Wait until A is actually inside pg_sleep: at that moment its revoke has
// executed and it holds the advisory lock. Matching the backend's wait event
// is deterministic; a sleep would only be a guess.
const deadline = Date.now() + 20_000;
let holding = false;
while (Date.now() < deadline) {
  const n = scalar(`
select count(*) from pg_stat_activity
 where application_name = 'findback-lock-a' and wait_event = 'PgSleep';
`);
  if (n === "1") { holding = true; break; }
  await new Promise((resolve) => setTimeout(resolve, 100));
}
if (!holding) {
  a.kill("SIGTERM");
  throw new Error("session A never reached the lock-holding sleep");
}

// --- act: B's grant queues behind the lock -------------------------------
// B still SEES its own ADMIN row (A's revoke is uncommitted), so it passes
// the pre-lock check and blocks on the advisory lock.
const b = spawn(psql, ["-X", "-q", "-tA", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
  env: env({ PGAPPNAME: "findback-lock-b" }),
  stdio: ["pipe", "pipe", "pipe"],
});
let bOut = "", bErr = "";
b.stdout.on("data", (chunk) => { bOut += chunk; });
b.stderr.on("data", (chunk) => { bErr += chunk; });
b.stdin.end(`
\\set VERBOSITY verbose
set statement_timeout = '20s';
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '${B}', true);
select public.findback_role_grant('${C_EMAIL}', 'MODERATOR', array['reports_review']);
commit;
`);

// B must actually be WAITING on the lock while A holds it. Without this the
// run could pass on a slow machine where B only started after A committed:
// B would then be refused by the PRE-lock check and prove nothing about the
// post-lock one.
const bDeadline = Date.now() + 15_000;
let queued = false;
while (Date.now() < bDeadline) {
  const n = scalar(`
select count(*) from pg_stat_activity
 where application_name = 'findback-lock-b' and wait_event_type = 'Lock';
`);
  if (n === "1") { queued = true; break; }
  await new Promise((resolve) => setTimeout(resolve, 50));
}

const aCode = await new Promise((resolve) => a.on("exit", resolve));
if (aCode !== 0) throw new Error(`session A failed (exit ${aCode})\n${aErr}\n${aOut}`);
const bCode = await new Promise((resolve) => b.on("exit", resolve));
const bResult = { status: bCode, stdout: bOut, stderr: bErr, error: null };

// --- assert --------------------------------------------------------------
if (!queued && bResult.status === 0) {
  // Nothing to prove if B neither waited nor was refused.
  console.error("B never queued on the lock before A committed");
}
check("B waited on the role lock while A held it", String(queued), "true");
if (bResult.error) throw bResult.error;
check("B's queued grant is refused", String(bResult.status !== 0), "true");
check(
  "the refusal is the capability refusal (SQLSTATE 42501)",
  String(/42501/.test(bResult.stderr) && /Only an admin may assign roles/.test(bResult.stderr)),
  "true",
);
if (bResult.status === 0) {
  console.error("B's grant succeeded:\n" + bResult.stdout);
} else {
  console.log("B stderr:\n" + bResult.stderr.trim());
}

check("A's revoke committed: B holds no role", scalar(
  `select count(*) from public.user_roles where user_id = '${B}';`,
), "0");
check("the target gained no role", scalar(
  `select count(*) from public.user_roles where user_id = '${C}';`,
), "0");
check("no ROLE_GRANTED was written for the refused mutation", scalar(
  `select count(*) from public.admin_audit_log
    where action = 'ROLE_GRANTED'
      and (target_id = '${C}' or new_state->>'email' = '${C_EMAIL}');`,
), "0");
check("the revoke wrote exactly one ROLE_REVOKED", scalar(
  `select count(*) from public.admin_audit_log
    where action = 'ROLE_REVOKED' and target_id = '${B}';`,
), "1");

// Leave the database as it was found: the fixtures are ADMIN rows, and a
// leftover admin changes what a later verifier run expects. Cleanup is not
// part of the assertion, so a failed run still reports its failure first.
run(`
delete from public.admin_audit_log where target_id in ('${A}', '${B}', '${C}', '${A_EMAIL}', '${B_EMAIL}', '${C_EMAIL}');
delete from public.user_role_capabilities where user_id in ('${A}', '${B}', '${C}');
delete from public.user_roles where user_id in ('${A}', '${B}', '${C}');
delete from public.role_invitations where lower(btrim(email)) like '%@example.invalid';
delete from public.users where id in ('${A}', '${B}', '${C}');
`);

if (process.exitCode) console.error("roles lock concurrency: FAILED");
else console.log("roles lock concurrency: PASS");
