/** Requires the explicitly named disposable DB; no skip/fallback to text tests. */
import { it } from "node:test";
import assert from "node:assert/strict";
import { compileProbes, runPsql } from "./sql-behavior.mjs";

it("psql accepts a true assertion and refuses zero, multi-row and errored probes", () => {
  assert.match(runPsql(compileProbes("select 'good' as probe where true;")), /PASS probe 1/);
  for (const sql of [
    "select 'empty' as probe where false;",
    "select generate_series(1,2) as probe;",
    "select 1/0 as probe;",
    "do $$ begin raise exception 'broken DO assertion'; end $$; select 1;",
  ]) assert.throws(() => runPsql(compileProbes(sql)), /psql exit 3/);
});

it("a probe with side effects executes exactly once in the same transaction", () => {
  const output = runPsql(compileProbes(`
    begin;
    create temporary table sql_runner_once(n integer);
    with inserted as (insert into sql_runner_once values(1) returning n)
      select n from inserted;
    select 'once' as probe where (select count(*) from sql_runner_once)=1;
    rollback;
  `));
  assert.match(output, /PASS probe 2/);
});

it("the first failure aborts the file, rolls back and cannot print later PASS", () => {
  assert.throws(() => runPsql(compileProbes(`
    begin;
    create table sql_runner_rollback(n integer);
    select 'empty' as probe where false;
    select 'must not run' as probe;
    commit;
  `)), /psql exit 3/);
  assert.match(runPsql(compileProbes("select 'rolled back' as probe where to_regclass('public.sql_runner_rollback') is null;")), /PASS/);
});
