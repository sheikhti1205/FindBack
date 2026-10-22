import { it } from "node:test";
import assert from "node:assert/strict";
import { compileProbes, splitSql, assertLocalDatabase } from "./sql-behavior.mjs";

it("splits only executable semicolons, preserving quoted text and function bodies", () => {
  assert.deepEqual(splitSql(`-- apostrophe ' ;
    select 'a;''b', "a;""b"; /* outer ; /* nested ; */ */
    do $body$ begin perform ';'; end $body$;
    select E'back\\';slash';`), [
    `select 'a;''b', "a;""b"`, `do $body$ begin perform ';'; end $body$`, `select E'back\\';slash'`,
  ]);
});

it("keeps token boundaries when removing comments", () => {
  assert.deepEqual(splitSql("select/* hi */1; select-- hi\n2;"), ["select 1", "select \n2"]);
});

it("rejects malformed quoting and psql meta commands rather than executing a partial file", () => {
  for (const source of ["select 'oops", 'select "oops', "do $$oops", "/*oops", "\\include file", "select 1; \\quit"]) {
    assert.throws(() => splitSql(source));
  }
});

it("executes SELECT/WITH probes exactly once with gset, never semicolon then gset", () => {
  const script = compileProbes("begin; select 'B1' as probe where true; with x as (select 1) select * from x; rollback;");
  assert.match(script, /select 'B1' as probe where true\n\\gset fb_probe_/);
  assert.match(script, /with x as \(select 1\) select \* from x\n\\gset fb_probe_/);
  assert.doesNotMatch(script, /;\s*\\gset/);
  assert.equal((script.match(/begin;/g) ?? []).length, 1);
  assert.equal((script.match(/rollback;/g) ?? []).length, 1);
});

it("refuses an empty assertion file", () => {
  assert.throws(() => compileProbes("-- nothing here"), /no.*probe/i);
  assert.throws(() => compileProbes("begin; rollback;"), /no.*probe/i);
});

it("will only connect to explicitly named loopback disposable databases", () => {
  assert.doesNotThrow(() => assertLocalDatabase({ PGHOST: "127.0.0.1", PGDATABASE: "findback_sql_test" }));
  for (const env of [
    {}, { PGHOST: "db.example.invalid", PGDATABASE: "findback_sql_test" },
    { PGHOST: "localhost", PGDATABASE: "postgres" },
    { PGHOST: "localhost", PGDATABASE: "findback_sql_test", PGHOSTADDR: "198.51.100.1" },
    { PGHOST: "localhost", PGDATABASE: "findback_sql_test", PGSERVICE: "hosted" },
  ]) assert.throws(() => assertLocalDatabase(env), /disposable/i);
});
