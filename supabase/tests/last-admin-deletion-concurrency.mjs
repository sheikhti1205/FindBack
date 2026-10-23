/**
 * Two-connection regression for the last-admin deletion guard
 * (20261023030000_last_admin_deletion_guard.sql).
 *
 * The single-connection probe files cannot express this. The defect the
 * advisory lock closes only appears with two live sessions: two admins delete
 * their accounts at the same time, each sees the other admin, and — without
 * the lock — BOTH transactions commit, leaving the app with no admin at all.
 *
 * What this script proves, against a disposable local PostgreSQL that has the
 * real migration chain applied:
 *
 *   1. The deletion of admin A holds the role lock (the SAME key every role
 *      mutation takes) while it is open.
 *   2. The concurrent deletion of admin B really QUEUES on that advisory
 *      lock — matched through pg_locks and pg_stat_activity, not guessed
 *      from a sleep.
 *   3. When A commits, B re-reads the admin set under the lock, finds no
 *      other admin, and is refused with SQLSTATE 42501 and the server
 *      sentence.
 *   4. Exactly ONE of the two deletions committed, and at least one ADMIN
 *      still exists.
 *
 * Node builtins + psql only, like scripts/sql-behavior.mjs. Local loopback
 * database only: this is a platform stub, never hosted acceptance evidence.
 *
 * Run: PGHOST=127.0.0.1 PGPORT=<port> PGDATABASE=findback_sql_test_guard \
 *      PGUSER=postgres PGPASSWORD=localtest \
 *      node supabase/tests/last-admin-deletion-concurrency.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { assertLocalDatabase } from "../../scripts/sql-behavior.mjs";

const A = "11111111-1111-4111-8111-00000000aaaa";
const B = "11111111-1111-4111-8111-00000000bbbb";
const LOCK_KEY = 20261022143000;
const LOCK_CLASSID = Math.floor(LOCK_KEY / 2 ** 32);
const LOCK_OBJID = LOCK_KEY - LOCK_CLASSID * 2 ** 32;
const HOLD_SECONDS = 6;

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
// Committed, so the two contending sessions see each other's state. Both
// accounts are admins: each deletion is permitted on its own.
run(`
delete from public.user_roles where user_id in ('${A}', '${B}');
delete from public.users where id in ('${A}', '${B}');
insert into public.users (id, username, email, phone, password_hash, email_verified, created_at, updated_at) values
  ('${A}', 'conc_admin_a', 'conc-admin-a@example.invalid', '+8801710000301', 'x', 1, '2020-01-01', '2020-01-01'),
  ('${B}', 'conc_admin_b', 'conc-admin-b@example.invalid', '+8801710000302', 'x', 1, '2020-01-01', '2020-01-01');
insert into public.user_roles (user_id, role, granted_at) values
  ('${A}', 'ADMIN', '2020-01-01'),
  ('${B}', 'ADMIN', '2020-01-01');
`);
check("two admins are arranged", scalar(`select count(*) from public.user_roles where role = 'ADMIN';`), "2");

// --- act: A deletes itself and keeps the lock open ------------------------
const aSql = `
begin;
delete from public.users where id = '${A}';
select pg_sleep(${HOLD_SECONDS});
commit;
`;

const a = spawn(psql, ["-X", "-q", "-tA", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
  env: env({ PGAPPNAME: "findback-guard-a" }),
  stdio: ["pipe", "pipe", "pipe"],
});
let aOut = "", aErr = "";
a.stdout.on("data", (chunk) => { aOut += chunk; });
a.stderr.on("data", (chunk) => { aErr += chunk; });
a.stdin.end(aSql);
// The exit code must be captured from the moment the child starts: A can
// finish before the second session has even been started, and a listener
// attached later would never fire.
const aExited = new Promise((resolve) => a.on("exit", resolve));

// Wait until A is inside pg_sleep: at that moment its deletion has executed
// and it holds the advisory lock. Matching the backend's wait event is
// deterministic; a sleep would only be a guess.
const deadline = Date.now() + 20_000;
let holding = false;
while (Date.now() < deadline) {
  const n = scalar(`
select count(*) from pg_stat_activity
 where application_name = 'findback-guard-a' and wait_event = 'PgSleep';
`);
  if (n === "1") { holding = true; break; }
  await new Promise((resolve) => setTimeout(resolve, 100));
}
if (!holding) {
  a.kill("SIGTERM");
  throw new Error("session A never reached the lock-holding sleep");
}

// --- act: B deletes itself and must queue behind the lock ----------------
const b = spawn(psql, ["-X", "-q", "-tA", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
  env: env({ PGAPPNAME: "findback-guard-b" }),
  stdio: ["pipe", "pipe", "pipe"],
});
let bErr = "";
b.stderr.on("data", (chunk) => { bErr += chunk; });
b.stdin.end(`
\\set VERBOSITY verbose
set statement_timeout = '30s';
begin;
delete from public.users where id = '${B}';
commit;
`);
const bExited = new Promise((resolve) => b.on("exit", resolve));

// B must actually be WAITING on the advisory lock while A holds it. Without
// this the run could pass on a slow machine where B only started after A
// committed: B would then see a single admin and be refused, but nothing
// would be proved about the serialization.
const bDeadline = Date.now() + 15_000;
let queued = false;
let advisoryWaiters = "0";
while (Date.now() < bDeadline) {
  const waiting = scalar(`
select count(*) from pg_stat_activity
 where application_name = 'findback-guard-b' and wait_event_type = 'Lock';
`);
  if (waiting === "1") {
    queued = true;
    advisoryWaiters = scalar(`
select count(*) from pg_locks
 where locktype = 'advisory'
   and classid = ${LOCK_CLASSID}
   and objid = ${LOCK_OBJID}
   and objsubid = 1
   and not granted;
`);
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
}

const aCode = await aExited;
if (aCode !== 0) throw new Error(`session A failed (exit ${aCode})\n${aErr}\n${aOut}`);
const bCode = await bExited;

// --- assert --------------------------------------------------------------
check("B queued on the advisory lock while A held it", String(queued), "true");
check("the lock B waited on is the D1 role-guard key", advisoryWaiters, "1");
check("A's deletion committed", String(aCode), "0");
check("B's deletion was refused", String(bCode === 0 ? 0 : 1), "1");
const refusalLine = bErr
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.includes("This is the only admin account"))
  .join(" | ");
console.log(`B refusal line: ${refusalLine || "(none)"}`);
check(
  "B's refusal carries the server sentence",
  /This is the only admin account\. Promote another admin before deleting this one\./.test(bErr) ? "true" : "false",
  "true",
);
check(
  "B's refusal is SQLSTATE 42501",
  /42501|insufficient_privilege/.test(bErr) ? "true" : "false",
  "true",
);
check("exactly one account was deleted", scalar(`select count(*) from public.users where id in ('${A}', '${B}');`), "1");
check("exactly one admin remains", scalar(`select count(*) from public.user_roles where role = 'ADMIN';`), "1");
check(
  "the surviving admin is the one that was refused",
  scalar(`select user_id from public.user_roles where role = 'ADMIN';`),
  B,
);

// Clean up so the harness can be re-run against the same database.
run(`
delete from public.user_roles where user_id in ('${A}', '${B}');
delete from public.users where id in ('${A}', '${B}');
`);
