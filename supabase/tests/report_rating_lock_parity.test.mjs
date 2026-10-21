import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("../migrations/", import.meta.url));
const name = "20261021162730_lock_report_rating_writes.sql";
const sql = readFileSync(`${dir}/${name}`, "utf8").replace(/--[^\n]*/g, "");
const clientTableWrite = /grant\s+(?:all|[^;]*(?:insert|update|delete))[^;]*on\s+(?:table\s+)?public\.ratings[^;]*to\s+[^;]*\b(?:authenticated|anon|public)\b/i;
const clientRpcExecute = /grant\s+(?:execute|all)[^;]*findback_rate_client[^;]*to\s+[^;]*\b(?:authenticated|anon|public)\b/i;

test("report-rating lock closes both direct writes and the legacy RPC", () => {
  for (const policy of ["ratings_insert_own", "ratings_delete_own"]) {
    assert.match(sql, new RegExp(`drop policy if exists ${policy} on public\\.ratings;`, "i"));
  }
  assert.match(sql, /revoke insert, update, delete on public\.ratings from anon, authenticated, public;/i);
  assert.match(sql, /revoke execute on function public\.findback_rate_client\(text, integer\) from anon, authenticated, public;/i);
});

test("rating history stays readable and the service-role contract is explicit", () => {
  assert.match(sql, /grant execute on function public\.findback_rate_client\(text, integer\) to service_role;/i);
  assert.doesNotMatch(sql, /(?:delete from|truncate|drop table)\s+public\.ratings/i);
  assert.doesNotMatch(sql, /drop policy.*ratings_select_authenticated|revoke select.*public\.ratings/i);
});

test("no later migration reopens client rating writes", () => {
  const later = readdirSync(dir).filter(file => file.endsWith(".sql") && file > name);
  for (const file of later) {
    const text = readFileSync(`${dir}/${file}`, "utf8").replace(/--[^\n]*/g, "");
    assert.doesNotMatch(text, clientTableWrite, file);
    assert.doesNotMatch(text, clientRpcExecute, file);
  }
});

test("the future-grant guard catches client roles anywhere in a grantee list", () => {
  assert.match("grant insert on public.ratings to service_role, authenticated;", clientTableWrite);
  assert.match("grant execute on function public.findback_rate_client(text, integer) to service_role, PUBLIC;", clientRpcExecute);
  assert.doesNotMatch("grant select on public.ratings to authenticated;", clientTableWrite);
  assert.doesNotMatch("grant execute on function public.findback_rate_client(text, integer) to service_role;", clientRpcExecute);
});
