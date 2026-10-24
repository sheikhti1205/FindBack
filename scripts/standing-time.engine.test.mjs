/** Requires a migrated disposable loopback DB; real locks, simulated UTC midnight.
 * Moving the day sample before the actor lock must fail the four rollover cases.
 * Only this test's clock/schema and temporary function search_path are substituted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { assertLocalDatabase } from "./sql-behavior.mjs";

assertLocalDatabase(process.env);
const env = { ...process.env, PGOPTIONS: "-c statement_timeout=10000 -c lock_timeout=8000" };
const args = ["-X", "-Atq", "-v", "ON_ERROR_STOP=1", "-f", "-"];
function query(sql) {
  const result = spawnSync("psql", args, { env, input: sql, encoding: "utf8", timeout: 15000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function session(sql, hold = false) {
  const child = spawn("psql", args, { env, stdio: ["pipe", "pipe", "pipe"] });
  const state = { child, out: "", err: "", exited: false };
  child.stdout.on("data", data => { state.out += data; });
  child.stderr.on("data", data => { state.err += data; });
  state.done = new Promise(resolve => {
    child.on("error", error => { state.err += error.message; });
    child.on("close", code => { state.exited = true; resolve({ code, out: state.out, err: state.err }); });
  });
  const timer = setTimeout(() => child.kill("SIGTERM"), 20000);
  state.done.then(() => clearTimeout(timer));
  if (hold) child.stdin.write(sql); else child.stdin.end(sql);
  return state;
}
async function waitFor(predicate, detail) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail(`Not observed: ${detail}`);
}

test("daily limit uses the UTC day after the actual actor-lock wait", { timeout: 60000 }, async t => {
  for (const table of ["item_posts", "comments"]) {
    for (const probation of [false, true]) {
      await t.test(`${table}: ${probation ? "probation" : "ordinary"} author crosses midnight`, async () => {
        const suffix = `${table === "comments" ? 2 : 1}${probation ? 1 : 0}`;
        const uid = `00000000-0000-4000-9600-0000000000${suffix}`;
        const targetOwner = "00000000-0000-4000-9600-000000000099";
        const prefix = `standing_day_${suffix}`;
        const schema = `standing_clock_${suffix}`;
        const signature = "public.findback_enforce_interaction_limit()";
        const before = query(`select md5(pg_get_functiondef('${signature}'::regprocedure));`);
        assert.equal(query(`select proconfig::text from pg_proc where oid='${signature}'::regprocedure;`), '{"search_path=public, pg_temp"}');
        let holder, caller;
        try {
          query(`begin;
            insert into public.users(id,username,email,phone,email_verified,created_at,updated_at)
            values('${uid}','${prefix}','${prefix}@example.invalid','+88019600000${suffix}',1,'2026-10-24T00:00:00Z','2026-10-24T00:00:00Z'),
              ('${targetOwner}','standing_day_target','standing_day_target@example.invalid','+8801960000099',1,'2026-10-24T00:00:00Z','2026-10-24T00:00:00Z');
            insert into public.item_posts(id,user_id,type,title,description,category,status,event_date,created_at,updated_at)
            values('${prefix}_target','${targetOwner}','LOST','Keys','Synthetic','Other','OPEN','2026-10-24','2026-10-24T00:00:00Z','2026-10-24T00:00:00Z');
            ${table === "item_posts" ? `insert into public.item_posts(id,user_id,type,title,description,category,status,event_date,created_at,updated_at)
              select '${prefix}_old_'||n,'${uid}','LOST','Keys','Synthetic','Other','OPEN','2040-01-01','2040-01-01T20:00:00Z','2040-01-01T20:00:00Z' from generate_series(1,3)n;`
              : `insert into public.comments(id,user_id,post_id,body,created_at,updated_at)
              select '${prefix}_old_'||n,'${uid}','${prefix}_target','Synthetic','2040-01-01T20:00:00Z','2040-01-01T20:00:00Z' from generate_series(1,3)n;`}
            ${probation ? `insert into public.account_sanctions(id,user_id,kind,starts_at,reason_code,created_at)
              values('${prefix}_sanction','${uid}','PROBATION','2020-01-01T00:00:00Z','OTHER','2020-01-01T00:00:00Z');` : ""}
            create schema ${schema};
            create table ${schema}.clock(value timestamptz not null);
            insert into ${schema}.clock values('2040-01-01T23:59:59Z');
            create function ${schema}.clock_timestamp() returns timestamptz language sql volatile
              as $$select value from ${schema}.clock$$;
            alter function ${signature} set search_path=${schema},public,pg_temp,pg_catalog;
            commit;`);
          const insert = id => table === "item_posts"
            ? `insert into public.item_posts(id,user_id,type,title,description,category,status,event_date,created_at,updated_at)
                values('${id}','${uid}','LOST','New day','Synthetic','Other','OPEN','2040-01-02','2040-01-02T00:01:00Z','2040-01-02T00:01:00Z');`
            : `insert into public.comments(id,user_id,post_id,body,created_at,updated_at)
                values('${id}','${uid}','${prefix}_target','New day','2040-01-02T00:01:00Z','2040-01-02T00:01:00Z');`;
          const actor = `set role authenticated; select set_config('request.jwt.claim.sub','${uid}',false);`;
          // Same-day exhausted limit must still refuse before the clock transition.
          const refused = await session(actor + insert(`${prefix}_refused`)).done;
          assert.equal(refused.code, 3);
          assert.match(refused.err, /POST_LIMIT_REACHED/);
          holder = session(`begin; select pg_advisory_xact_lock(hashtextextended('findback_public_admission:${uid}',0));
            select 'HOLDER:'||pg_backend_pid();\n`, true);
          await waitFor(() => /HOLDER:\d+/.test(holder.out), "holder acquired actor lock");
          const holderPid = Number(holder.out.match(/HOLDER:(\d+)/)[1]);
          caller = session(`${actor} select 'CALLER:'||pg_backend_pid(); ${insert(`${prefix}_new`)}`);
          await waitFor(() => /CALLER:\d+/.test(caller.out), "caller backend identity");
          const callerPid = Number(caller.out.match(/CALLER:(\d+)/)[1]);
          await waitFor(() => query(`select ${holderPid}=any(pg_blocking_pids(${callerPid}));`) === "t", "exact actor-lock wait");
          query(`update ${schema}.clock set value='2040-01-02T00:01:00Z';`);
          holder.child.stdin.end("commit;\n");
          assert.equal((await holder.done).code, 0);
          const written = await caller.done;
          assert.equal(written.code, 0, `post-midnight INSERT must succeed: ${written.err}`);
          assert.equal(query(`select count(*) from public.${table} where id='${prefix}_new';`), "1");
          assert.equal(query(`select count(*) from public.${table} where id like '${prefix}_old_%';`), "3");
          assert.equal(query(`select count(*) from public.public_action_admissions where user_id='${uid}';`), probation ? "1" : "0");
        } finally {
          if (holder && !holder.exited) { holder.child.stdin.end("rollback;\n"); await holder.done; }
          if (caller && !caller.exited) await caller.done;
          query(`begin;
            alter function ${signature} set search_path=public,pg_temp;
            drop schema if exists ${schema} cascade;
            delete from public.comments where id like '${prefix}%';
            delete from public.item_posts where id like '${prefix}%';
            delete from public.users where id in('${uid}','${targetOwner}');
            commit;`);
          assert.equal(query(`select md5(pg_get_functiondef('${signature}'::regprocedure));`), before, "test metadata must be restored");
        }
      });
    }
  }
});
