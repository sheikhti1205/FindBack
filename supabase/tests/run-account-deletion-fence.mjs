// Disposable, real PostgreSQL boundary tests; never connect to a hosted project.
// FINDBACK_TEST_PG_MODULE=/absolute/path/to/embedded-postgres/dist/index.js node supabase/tests/run-account-deletion-fence.mjs
//
// Proves the storage write fence at the real final-write boundary:
//   * a privileged (BYPASSRLS / owner) writer is refused while fenced — the
//     RLS-invisible path the fence exists for;
//   * a rename/move across owners is fenced on both endpoints;
//   * a versioning delete marker and an archive are ALLOWED while fenced, so
//     the deletion sweep itself can never wedge;
//   * the probe-savepoint-rollback-then-delayed-commit race is refused;
//   * an in-flight write commits before the fence commits (ordering);
//   * a writer queued behind the fence observes it after the lock wait;
//   * the fence row outlives the profile cascade, so an old JWT cannot write.
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const { default: EmbeddedPostgres } = await import(process.env.FINDBACK_TEST_PG_MODULE ?? "embedded-postgres");
const directory = await mkdtemp(join(tmpdir(), "findback-deletion-fence-"));
const pg = new EmbeddedPostgres({ databaseDir: join(directory, "db"), user: "postgres", password: randomBytes(16).toString("hex"), port: 15483, persistent: false, postgresFlags: ["-h", "127.0.0.1"], onLog: () => {}, onError: () => {} });
const clients = [];
let passed = 0;
async function client() { const connection = pg.getPgClient(); await connection.connect(); clients.push(connection); return connection; }
async function rejected(connection, query, pattern) { await assert.rejects(connection.query(query), pattern); passed++; }
async function accepted(connection, query) { await connection.query(query); passed++; }
async function waitForLock(observer, pid) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const { rows } = await observer.query("select wait_event_type from pg_stat_activity where pid=$1", [pid]);
    if (rows[0]?.wait_event_type === "Lock") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Expected the concurrent operation to block on the deletion lock");
}
const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";
try {
  await pg.initialise(); await pg.start();
  const admin = await client();
  await admin.query(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema storage;
    create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create table public.users(id text primary key);
    create table storage.objects(
      id bigint generated always as identity,
      bucket_id text,
      name text,
      is_delete_marker boolean not null default false,
      archived_at timestamptz null,
      version text null
    );
    alter table storage.objects enable row level security;
    grant usage on schema public, auth, storage to anon, authenticated, service_role;
    grant all on storage.objects to authenticated, service_role;
    grant usage on all sequences in schema storage to authenticated, service_role;
    insert into public.users values ('${A}'),('${B}');`);
  await admin.query(await readFile(new URL("../migrations/20261014010000_account_deletion_storage_fence.sql", import.meta.url), "utf8"));

  // Privileged insert passes for a live, unfenced account; an unrecognized key
  // shape is refused fail-closed.
  await accepted(admin, `insert into storage.objects(bucket_id,name) values ('findback-images','${A}/before.jpg')`);
  await rejected(admin, `insert into storage.objects(bucket_id,name) values ('findback-images','root-placeholder.jpg')`, /account required/);
  // An unknown-but-well-formed owner is allowed: the fence targets deletions,
  // not arbitrary uid-shaped keys (no `users`-row requirement to break other
  // writers such as the API's namespace fallback).
  await accepted(admin, `insert into storage.objects(bucket_id,name) values ('findback-images','99999999-9999-4999-8999-999999999999/x.jpg')`);

  await admin.query(`select public.findback_begin_account_deletion('${A}')`);
  // Privileged (RLS-bypassing) writes and every registered namespace are refused.
  await rejected(admin, `insert into storage.objects(bucket_id,name) values ('findback-images','${A}/after.jpg')`, /account deletion prevents storage writes/);
  await rejected(admin, `insert into storage.objects(bucket_id,name) values ('findback-images','avatars/${A}/nested/avatar.jpg')`, /account deletion prevents storage writes/);
  await rejected(admin, `insert into storage.objects(bucket_id,name) values ('findback-comment-media','${A}/nested/photo.jpg')`, /account deletion prevents storage writes/);
  // A rename reaching into the fenced account is refused on the destination.
  await accepted(admin, `insert into storage.objects(bucket_id,name) values ('findback-images','${B}/sibling.jpg')`);
  await rejected(admin, `update storage.objects set name='${A}/moved.jpg' where name='${B}/sibling.jpg'`, /account deletion prevents storage writes/);
  // Versioning removals must pass while fenced, or the sweep wedges forever.
  await accepted(admin, `insert into storage.objects(bucket_id,name,is_delete_marker) values ('findback-images','${A}/before.jpg',true)`);
  await accepted(admin, `update storage.objects set archived_at=now() where name='${A}/before.jpg' and is_delete_marker = false`);
  await rejected(admin, `insert into storage.objects(bucket_id,name,is_delete_marker) values ('findback-images','${A}/after.jpg',false)`, /account deletion prevents storage writes/);

  // Reset the fence to emulate a rolled-back permission probe, then a delayed
  // privileged commit that must still be refused.
  await admin.query("delete from public.account_deletion_fences");
  await admin.query(`begin; savepoint probe; insert into storage.objects(bucket_id,name) values ('findback-images','${A}/probe-race.jpg'); rollback to probe; commit`);
  await admin.query(`select public.findback_begin_account_deletion('${A}')`);
  await rejected(admin, `insert into storage.objects(bucket_id,name) values ('findback-images','${A}/probe-race.jpg')`, /account deletion prevents storage writes/);

  // In-flight write commits before the fence commits.
  await admin.query("delete from public.account_deletion_fences");
  await admin.query(`begin; insert into storage.objects(bucket_id,name) values ('findback-images','${A}/in-flight.jpg')`);
  const monitor = await client(), deleter = await client();
  const { rows: [{ pid: deletionPid }] } = await deleter.query("select pg_backend_pid() pid");
  const fence = deleter.query(`select public.findback_begin_account_deletion('${A}')`);
  await waitForLock(monitor, deletionPid);
  await admin.query("commit"); await fence; passed++;

  // A writer queued behind the fence must observe it after the lock wait even
  // though its statement began with a pre-fence snapshot.
  await deleter.query(`begin; select public.findback_begin_account_deletion('${A}')`);
  const writer = await client();
  const { rows: [{ pid: writerPid }] } = await writer.query("select pg_backend_pid() pid");
  const blockedWrite = assert.rejects(writer.query(`insert into storage.objects(bucket_id,name) values ('findback-images','${A}/waiting.jpg')`), /account deletion prevents storage writes/);
  await waitForLock(monitor, writerPid); await deleter.query("commit"); await blockedWrite; passed++;

  // The fence outlives the profile cascade: an old JWT cannot resurrect bytes.
  await admin.query(`delete from public.users where id='${A}'`);
  await rejected(admin, `insert into storage.objects(bucket_id,name) values ('findback-images','${A}/old-jwt.jpg')`, /account deletion prevents storage writes/);

  // Client roles can neither read the fence nor begin a deletion.
  const caller = await client();
  await caller.query(`set role authenticated; select set_config('request.jwt.claim.sub','${A}',false)`);
  await rejected(caller, "select * from public.account_deletion_fences", /permission denied/);
  await rejected(caller, `select public.findback_begin_account_deletion('${B}')`, /permission denied/);
  console.log(`Account deletion fence: ${passed} real PostgreSQL boundary assertions passed`);
} finally {
  await Promise.all(clients.map((connection) => connection.end().catch(() => {})));
  await pg.stop(); await rm(directory, { recursive: true, force: true });
}
