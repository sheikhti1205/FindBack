/**
 * Two-connection regression for single-decider moderation ownership
 * (20261023120000_moderation_single_decider.sql).
 *
 * The single connection probe files cannot express this. The defect the
 * advisory lock closes only appears with two live sessions: moderators A and B
 * both open the same stale console, both read "no decision yet", and — without
 * the lock — BOTH write a decision, so the case ends up owned by the loser of
 * the race while the winner believes they decided it.
 *
 * What this script proves against a disposable local PostgreSQL that has the
 * real migration chain applied:
 *
 *   Scenario 1 — same key: A and B both target the POST.
 *     1. A's decision holds the case advisory lock while its transaction is open.
 *     2. B's concurrent decision really QUEUES on that lock (pg_locks /
 *        pg_stat_activity, not a sleep).
 *     3. When A commits, B wakes, re-reads the case and is refused with
 *        SQLSTATE P0001 MODERATION_DECISION_FINAL.
 *     4. Exactly ONE decision row exists naming A at generation 1, the
 *        visibility is A's, and the refused race wrote no audit row.
 *
 *   Scenario 2 — competing keys: A targets the COMMENT, B targets its POST.
 *     Both resolve to the same POST atom. B must queue on the same lock and be
 *     refused, one decision row exists on the POST key, no COMMENT-key row is
 *     created, and the one audit row still targets the COMMENT.
 *
 * Fixtures are removed loudly at the end: if cleanup fails, this script fails
 * instead of leaving committed scratch rows behind.
 *
 * Local loopback database only: platform-stub evidence, never hosted
 * acceptance evidence.
 *
 * Run:
 *   FINDBACK_TEST_PG_PACKAGE=/abs/path/to/pg \
 *   PGPORT=<port> PGPASSWORD=... PGDATABASE=postgres PGUSER=postgres \
 *     node supabase/tests/moderation-single-decider-concurrency.mjs
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(process.env.FINDBACK_TEST_PG_PACKAGE ?? import.meta.url);
const { Client } = require(process.env.FINDBACK_TEST_PG_PACKAGE ?? "pg");

const connection = () => new Client({
  host: "127.0.0.1",
  port: Number(process.env.PGPORT ?? 15501),
  user: process.env.PGUSER ?? "postgres",
  password: process.env.PGPASSWORD ?? "localtest",
  database: process.env.PGDATABASE ?? "postgres",
});

const author = "11111111-1111-4111-8111-000000000d01";
const moderatorA = "11111111-1111-4111-8111-000000000d02";
const moderatorB = "11111111-1111-4111-8111-000000000d03";
const reporter = "11111111-1111-4111-8111-000000000d04";
const reporterTwo = "11111111-1111-4111-8111-000000000d05";
const reporterThree = "11111111-1111-4111-8111-000000000d06";

const postOne = "p-sd-race";
const postTwo = "p-sd-race-2";
const commentTwo = "c-sd-race-2";
const postThree = "p-sd-race-3";
const allPosts = [postOne, postTwo, postThree];
const allTargets = [postOne, postTwo, postThree, commentTwo];

let passed = 0;
let stage = "startup";
async function asUser(client, id, sql, params = []) {
  await client.query("set local role authenticated");
  await client.query("select set_config('request.jwt.claim.sub', $1, true)", [id]);
  return client.query(sql, params);
}

async function waitForLockWait(observer, pid) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const { rows } = await observer.query(
      "select wait_event_type from pg_stat_activity where pid = $1", [pid]);
    if (rows[0]?.wait_event_type === "Lock") return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

async function refuseAfterLock(admin, winner, loser, loserPid, loserAction, params = []) {
  const pending = (async () => {
    await loser.query("begin");
    return asUser(loser, moderatorB, loserAction, params);
  })().then(() => ({ refused: false }), (error) => ({ refused: true, error }));

  const queued = await waitForLockWait(admin, loserPid);
  if (!queued) {
    const settled = await Promise.race([
      pending,
      new Promise((resolve) => setTimeout(() => resolve(null), 100)),
    ]);
    assert.fail(
      `B must actually wait on A's advisory lock (outcome=${settled ? (settled.error?.message ?? "no error") : "still pending"})`,
    );
  }
  passed += 1;

  await winner.query("commit");
  const outcome = await pending;

  assert.equal(outcome.refused, true, "B must be refused after A commits");
  assert.equal(outcome.error.code, "P0001", `B's SQLSTATE was ${outcome.error.code}`);
  assert.equal(outcome.error.message, "MODERATION_DECISION_FINAL");
  passed += 2;
  return outcome;
}

const admin = connection();
const a = connection();
const b = connection();
try {
  await admin.connect();
  await a.connect();
  await b.connect();

  await admin.query("begin");
  await admin.query(
    `insert into public.users (id, username, email, phone, password_hash, email_verified, phone_verified, created_at, updated_at)
     values ($1, 'sd_race_owner', 'sd_race_owner@example.invalid', '+8801700001001', null, 1, 0, now()::text, now()::text),
            ($2, 'sd_race_mod_a', 'sd_race_mod_a@example.invalid', '+8801700001002', null, 1, 0, now()::text, now()::text),
            ($3, 'sd_race_mod_b', 'sd_race_mod_b@example.invalid', '+8801700001003', null, 1, 0, now()::text, now()::text),
            ($4, 'sd_race_rep',   'sd_race_rep@example.invalid',   '+8801700001004', null, 1, 0, now()::text, now()::text),
            ($5, 'sd_race_rep_2', 'sd_race_rep_2@example.invalid', '+8801700001005', null, 1, 0, now()::text, now()::text),
            ($6, 'sd_race_rep_3', 'sd_race_rep_3@example.invalid', '+8801700001006', null, 1, 0, now()::text, now()::text)
     on conflict (id) do nothing`,
    [author, moderatorA, moderatorB, reporter, reporterTwo, reporterThree]);
  await admin.query(
    `insert into public.user_roles (user_id, role, granted_by, granted_at)
     values ($1, 'MODERATOR', $1, now()::text), ($2, 'MODERATOR', $1, now()::text)
     on conflict do nothing`, [moderatorA, moderatorB]);
  await admin.query(
    `insert into public.user_role_capabilities (user_id, capability, granted_by, granted_at)
     values ($1, 'reports_review', $1, now()::text), ($1, 'content_hide', $1, now()::text),
            ($2, 'reports_review', $1, now()::text), ($2, 'content_hide', $1, now()::text)
     on conflict do nothing`, [moderatorA, moderatorB]);
  await admin.query(
    `insert into public.item_posts (id, user_id, type, title, description, category, status, event_date, created_at, updated_at)
     values ($1, $3, 'LOST', 'Race case', 'One decision only', 'Electronics', 'OPEN', '2020-01-01', now()::text, now()::text),
            ($2, $3, 'LOST', 'Race case two', 'A comment and its post are one atom', 'Electronics', 'OPEN', '2020-01-01', now()::text, now()::text),
            ($4, $3, 'LOST', 'Race case three', 'A report arriving during the decision', 'Electronics', 'OPEN', '2020-01-01', now()::text, now()::text)
     on conflict (id) do nothing`, [postOne, postTwo, author, postThree]);
  await admin.query(
    `insert into public.comments (id, post_id, user_id, body, created_at, updated_at)
     values ($1, $2, $3, 'The reported comment', now()::text, now()::text)
     on conflict (id) do nothing`, [commentTwo, postTwo, author]);
  await admin.query("commit");

  // ---------------------------------------------------------------- scenario 1
  stage = "scenario 1";
  await a.query("begin");
  await asUser(a, reporter,
    "select public.findback_submit_report('POST', $1, 'HARASSMENT', 'First')", [postOne]);
  await a.query("select pg_backend_pid() as pid");

  await asUser(a, moderatorA,
    "select public.findback_apply_moderation('POST', $1, 'HIDE', 'HARASSMENT', 'A decides', null, null)", [postOne]);
  passed += 1; // A holds the lock inside an open transaction.

  const pidB = await b.query("select pg_backend_pid() as pid");
  await refuseAfterLock(
    admin, a, b, pidB.rows[0].pid,
    "select public.findback_apply_moderation('POST', $1, 'HIDE', 'SPAM_OR_DUPLICATE', 'B decides', null, null)",
    [postOne]);

  const decision = await admin.query(
    `select decider_user_id, generation, decision_action, reopened_at
       from public.moderation_case_decisions where target_type = 'POST' and target_id = $1`, [postOne]);
  assert.equal(decision.rows.length, 1, "exactly one decision row may exist");
  assert.equal(decision.rows[0].decider_user_id, moderatorA);
  assert.equal(Number(decision.rows[0].generation), 1);
  assert.equal(decision.rows[0].decision_action, "HIDE");
  assert.equal(decision.rows[0].reopened_at, null);
  passed += 1;

  const visibility = await admin.query(
    "select moderation_visibility from public.item_posts where id = $1", [postOne]);
  assert.equal(visibility.rows[0].moderation_visibility, "HIDDEN");
  const audits = await admin.query(
    `select count(*)::int as n from public.admin_audit_log
      where target_type = 'POST' and target_id = $1`, [postOne]);
  assert.equal(audits.rows[0].n, 1, "the refused race wrote no audit row");
  passed += 1;

  // The losing connection is left in the aborted transaction of its refusal;
  // end it before reusing the connection for the next race.
  await b.query("rollback");

  // ---------------------------------------------------------------- scenario 2
  stage = "scenario 2";
  // A decides the COMMENT (which owns the POST atom); B targets the POST. Both
  // must use one lock and one decision key even though the submitted subjects
  // differ.
  stage = "scenario 2 begin";
  await a.query("begin");
  stage = "scenario 2 report";
  await asUser(a, reporterTwo,
    "select public.findback_submit_report('COMMENT', $1, 'INAPPROPRIATE_CONTENT', 'The comment')", [commentTwo]);
  stage = "scenario 2 decision";

  await asUser(a, moderatorA,
    "select public.findback_apply_moderation('COMMENT', $1, 'HIDE', 'INAPPROPRIATE_CONTENT', 'A decides the comment', null, null)", [commentTwo]);
  passed += 1;

  stage = "scenario 2 race";
  const pidB2 = await b.query("select pg_backend_pid() as pid");
  await refuseAfterLock(
    admin, a, b, pidB2.rows[0].pid,
    "select public.findback_apply_moderation('POST', $1, 'HIDE', 'INAPPROPRIATE_CONTENT', 'B decides the post', null, null)",
    [postTwo]);

  stage = "scenario 2 assertions";
  const atomDecision = await admin.query(
    `select target_type, target_id, decider_user_id, generation, decision_action
       from public.moderation_case_decisions
      where (target_type = 'POST' and target_id = $1)
         or (target_type = 'COMMENT' and target_id = $2)`, [postTwo, commentTwo]);
  assert.equal(atomDecision.rows.length, 1, "one atom, one decision row");
  assert.equal(atomDecision.rows[0].target_type, "POST");
  assert.equal(atomDecision.rows[0].target_id, postTwo);
  assert.equal(atomDecision.rows[0].decider_user_id, moderatorA);
  assert.equal(Number(atomDecision.rows[0].generation), 1);
  assert.equal(atomDecision.rows[0].decision_action, "HIDE");
  passed += 1;

  const atomAudit = await admin.query(
    `select target_type, target_id from public.admin_audit_log
      where target_type = 'COMMENT' and target_id = $1`, [commentTwo]);
  assert.equal(atomAudit.rows.length, 1, "the audit keeps the submitted comment target");
  assert.equal(atomAudit.rows[0].target_type, "COMMENT");
  passed += 1;

  const atomVisibility = await admin.query(
    "select moderation_visibility from public.item_posts where id = $1", [postTwo]);
  assert.equal(atomVisibility.rows[0].moderation_visibility, "HIDDEN");
  passed += 1;

  await b.query("rollback");

  // ---------------------------------------------------------------- scenario 3
  // A decides while a report is committed by another connection after A's
  // decision statement. The report must NOT be marked as already known: after
  // A commits, the case is open and B may decide it.
  stage = "scenario 3 begin";
  await a.query("begin");
  stage = "scenario 3 A decision";
  await asUser(a, moderatorA,
    "select public.findback_apply_moderation('POST', $1, 'HIDE', 'HARASSMENT', 'A decides before the report', null, null)", [postThree]);

  stage = "scenario 3 late report";
  await b.query("begin");
  const lateReport = await asUser(b, reporterThree,
    "select public.findback_submit_report('POST', $1, 'SPAM_OR_DUPLICATE', 'Arrived during the decision')", [postThree]);
  await b.query("commit");
  const lateReportId = lateReport.rows[0].findback_submit_report;

  stage = "scenario 3 commit A";
  await a.query("commit");

  const known = await admin.query(
    `select known_report_ids from public.moderation_case_decisions
      where target_type = 'POST' and target_id = $1`, [postThree]);
  assert.equal(known.rows.length, 1, "A's decision exists");
  assert.equal(known.rows[0].known_report_ids.includes(lateReportId), false,
    "the report committed after the decision statement must stay unknown");
  passed += 1;

  stage = "scenario 3 B reopens";
  await b.query("begin");
  await asUser(b, moderatorB,
    "select public.findback_apply_moderation('POST', $1, 'PUBLISH', 'SPAM_OR_DUPLICATE', 'B decides the new case', null, null)", [postThree]);
  await b.query("commit");
  passed += 1;

  const lateDecision = await admin.query(
    `select decider_user_id, generation, decision_action
       from public.moderation_case_decisions where target_type = 'POST' and target_id = $1`, [postThree]);
  assert.equal(lateDecision.rows[0].decider_user_id, moderatorB);
  assert.equal(Number(lateDecision.rows[0].generation), 2);
  assert.equal(lateDecision.rows[0].decision_action, "PUBLISH");
  const lateStatus = await admin.query(
    "select status from public.content_reports where id = $1", [lateReportId]);
  assert.equal(lateStatus.rows[0].status, "ACTIONED");
  passed += 1;

  // ------------------------------------------------------------------ cleanup
  stage = "cleanup";
  // Decision rows reference audit rows; delete the decisions first. Every
  // failure is surfaced: this script must not report PASS after leaving
  // committed scratch fixtures behind.
  try {
    await b.query("rollback").catch(() => {});
    await admin.query("begin");
    await admin.query(
      `delete from public.moderation_case_decisions
        where target_id = any($1::text[])`, [allTargets]);
    await admin.query(
      `delete from public.admin_audit_log
        where target_id = any($1::text[])`, [allTargets]);
    await admin.query(
      `delete from public.content_reports
        where target_id = any($1::text[])`, [allTargets]);
    await admin.query(
      `delete from public.notifications
        where post_id = any($1::text[])`, [allPosts]);
    await admin.query(
      "delete from public.comments where id = $1", [commentTwo]);
    await admin.query(
      `delete from public.item_posts where id = any($1::text[])`, [allPosts]);
    await admin.query(
      "delete from public.user_role_capabilities where user_id = any($1::text[])",
      [[moderatorA, moderatorB]]);
    await admin.query(
      "delete from public.user_roles where user_id = any($1::text[])",
      [[moderatorA, moderatorB]]);
    await admin.query(
      "delete from public.users where id = any($1::text[])",
      [[author, moderatorA, moderatorB, reporter, reporterTwo, reporterThree]]);
    await admin.query("commit");
    passed += 1;
  } catch (cleanupError) {
    await admin.query("rollback").catch(() => {});
    throw new Error(`fixture cleanup failed: ${cleanupError?.message ?? cleanupError}`);
  }

  console.log(`PASS ${passed} checks: one lock and one decision row per atom, including COMMENT vs POST`);
} catch (error) {
  console.error(`FAIL [${stage}]`, error?.message ?? error);
  process.exitCode = 1;
} finally {
  await a.end().catch(() => {});
  await b.end().catch(() => {});
  await admin.end().catch(() => {});
}
