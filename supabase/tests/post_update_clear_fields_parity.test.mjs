/**
 * Static checks for the explicit-clear migration
 * (20261022103000_post_update_clear_fields.sql).
 *
 * No database, no network, no secrets: the migration text is parsed and the
 * properties that make it safe to apply are asserted. The BEHAVIOURAL proof
 * lives in supabase/tests/verify_20261022103000_post_update_clear_fields.sql
 * and runs against a disposable PostgreSQL; this file is the guard that runs
 * everywhere, including where no engine exists.
 *
 * Run: node --test supabase/tests/post_update_clear_fields_parity.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIG = join(ROOT, "migrations", "20261022103000_post_update_clear_fields.sql");
const VERIFY = join(ROOT, "tests", "verify_20261022103000_post_update_clear_fields.sql");
const read = (p) => readFileSync(p, "utf8");

const sql = read(MIG);
const verify = read(VERIFY);
// The prose of the header names the properties too, so statement counting
// runs on the executable lines only, with the `--` comments stripped.
const code = sql
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

const FN = "findback_update_post_client";
const NEW_SIGNATURE =
  "text, text, text, text, text, text, double precision, double precision, text, text, text[]";
// The SQL wraps the signature across lines, so the argument list is matched
// with flexible whitespace instead of the literal one-line form.
const signaturePattern = (signature) =>
  signature
    .split(",")
    .map((part) => part.trim().replace(/[[\]]/g, "\\$&").replace(/\s+/g, "\\s+"))
    .join("\\s*,\\s*");

describe("the update RPC keeps its contract and gains ONE explicit clear argument", () => {
  it("declares the ten original arguments, unchanged, plus p_clear_fields", () => {
    const declaration = sql.match(
      /create function public\.findback_update_post_client\(([\s\S]*?)\)\s*returns boolean/i,
    );
    assert.ok(declaration, "the function is declared");
    const args = declaration[1];
    for (const name of [
      "p_post_id",
      "p_type",
      "p_title",
      "p_description",
      "p_category",
      "p_event_date",
      "p_latitude",
      "p_longitude",
      "p_location_label",
      "p_youtube_url",
    ]) {
      assert.match(args, new RegExp(`\\b${name}\\b`), `${name} is still a parameter`);
    }
    assert.match(args, /p_clear_fields\s+text\[\]\s+default\s+null/i);
    // The new argument is LAST, so every existing positional call is intact.
    assert.match(
      args,
      /p_youtube_url\s+text\s+default\s+null\s*,\s*p_clear_fields\s+text\[\]\s+default\s+null/i,
    );
  });

  it("drops the old ten-argument signature, guarded, before the re-create", () => {
    assert.match(
      sql,
      /drop function if exists public\.findback_update_post_client\(\s*text, text, text, text, text, text, double precision, double precision, text, text\s*\);/i,
    );
    const dropAt = code.search(/drop function if exists public\.findback_update_post_client/i);
    const createAt = code.search(/create function public\.findback_update_post_client/i);
    assert.ok(dropAt >= 0 && createAt > dropAt, "the drop comes before the create");
  });

  it("keeps the return type, the invoker security and the locked search_path", () => {
    assert.match(sql, /create function public\.findback_update_post_client\([\s\S]*?\)\s*returns boolean/i);
    assert.match(sql, /security invoker/i);
    assert.match(sql, /set search_path = public, pg_temp/i);
    // The definer count and the locked-path count stay equal: this file adds
    // no definer function, so it may add no unlocked one either.
    const definers = (code.match(/security definer/gi) ?? []).length;
    const paths = (code.match(/set search_path = public, pg_temp/gi) ?? []).length;
    assert.equal(definers, 0, "no definer function is introduced");
    assert.equal(paths, 1, "the one function locks its search_path");
  });
});

describe("clearing is opt-in and cannot happen by accident", () => {
  it("reads the clear request before the row is touched", () => {
    const body = sql.match(/create function public\.findback_update_post_client[\s\S]*?\$\$;/i);
    assert.ok(body, "the function body");
    const readAt = body[0].search(/if p_clear_fields is not null then/i);
    const updateAt = body[0].search(/update public\.item_posts set/i);
    assert.ok(readAt >= 0, "the clear request is read");
    assert.ok(updateAt > readAt, "the clear request is read before the update");
  });

  it("a null array clears nothing — every existing caller is unaffected", () => {
    assert.match(code, /if p_clear_fields is not null then/i);
    // The keep-old merge is still there for every field.
    assert.match(code, /v_merged_title\s*:=\s*coalesce\(nullif\(btrim\(coalesce\(p_title, ''\)\), ''\), v_existing\.title\)/i);
    assert.match(code, /v_merged_location_label\s*:=\s*case/i);
  });

  it("only the optional fields can be cleared", () => {
    const body = sql.match(/create function public\.findback_update_post_client[\s\S]*?\$\$;/i);
    assert.ok(body, "the function body");
    for (const field of ["location_label", "latitude", "longitude"]) {
      assert.match(body[0], new RegExp(`'${field}'`), `${field} is clearable`);
    }
    // The required fields are refused by name, not silently ignored.
    for (const field of ["type", "title", "description", "category", "event_date"]) {
      assert.match(
        body[0],
        new RegExp(`v_requested\\s*=\\s*'${field}'`),
        `${field} is explicitly refused`,
      );
    }
    assert.match(body[0], /is required on every report and cannot be cleared/i);
  });

  it("refuses an unknown field name instead of doing nothing", () => {
    assert.match(code, /raise exception 'Unknown field to clear: %'/i);
    assert.match(code, /using errcode = '22023'/i);
  });

  it("treats the coordinates as one field", () => {
    const body = sql.match(/create function public\.findback_update_post_client[\s\S]*?\$\$;/i);
    assert.ok(body, "the function body");
    assert.match(body[0], /v_requested = 'latitude' or v_requested = 'longitude'/i);
    assert.match(body[0], /Cannot clear the location coordinates and set new coordinates/i);
    assert.match(body[0], /v_merged_latitude\s*:=\s*case when v_clear_coords then null/i);
    assert.match(body[0], /v_merged_longitude\s*:=\s*case when v_clear_coords then null/i);
  });

  it("lets an explicit value beat a clear request for the same field", () => {
    const body = sql.match(/create function public\.findback_update_post_client[\s\S]*?\$\$;/i);
    assert.ok(body, "the function body");
    assert.match(
      body[0],
      /when v_clear_location and nullif\(btrim\(coalesce\(p_location_label, ''\)\), ''\) is null then null/i,
    );
  });

  it("still validates the row it writes and still writes only the caller's row", () => {
    assert.match(code, /perform public\.findback_validate_post_fields\(/i);
    assert.match(code, /where id = p_post_id and user_id = v_uid;/i);
    assert.match(code, /raise exception 'Post not found or you do not own it' using errcode = '42501'/i);
  });
});

describe("the validation rule is the DEPLOYED rule, unchanged", () => {
  // The function that is LIVE on the hosted project is the one re-created by
  // 20260919000000_validation_alignment.sql, and THAT function validates the
  // MERGED row. The migration must keep that rule exactly: the row that is
  // validated is the row that is written.
  const DEPLOYED = "20260919000000_validation_alignment.sql";
  const body = () => {
    const match = sql.match(/create function public\.findback_update_post_client[\s\S]*?\$\$;/i);
    assert.ok(match, "the function body");
    return match[0];
  };
  const validatorArgs = (source, pattern) => {
    const fn = source.match(pattern);
    assert.ok(fn, "the function body");
    const call = fn[0].match(/perform public\.findback_validate_post_fields\(([\s\S]*?)\);/i);
    assert.ok(call, "the validator call");
    return call[1]
      .split(",")
      .map((argument) => argument.replace(/\s+/g, " ").trim())
      .filter(Boolean);
  };

  it("validates the MERGED row, with the deployed function's own arguments", () => {
    const deployed = read(join(ROOT, "migrations", DEPLOYED));
    const deployedArgs = validatorArgs(
      deployed,
      /create or replace function public\.findback_update_post_client[\s\S]*?\$\$;/i,
    );
    const migratedArgs = validatorArgs(
      sql,
      /create function public\.findback_update_post_client[\s\S]*?\$\$;/i,
    );
    assert.deepEqual(
      migratedArgs,
      deployedArgs,
      "the validator sees exactly the merged values the deployed function validates",
    );
    assert.deepEqual(migratedArgs, [
      "v_merged_type",
      "v_merged_title",
      "v_merged_description",
      "v_merged_category",
      "v_merged_event_date",
      "v_merged_latitude",
      "v_merged_longitude",
      "v_merged_location_label",
      "v_merged_youtube_url",
    ]);
  });

  it("builds the merged values FIRST, then validates them, then writes them", () => {
    const mergeAt = body().search(/v_merged_type\s*:=\s*coalesce\(/i);
    const validateAt = body().search(/perform public\.findback_validate_post_fields\(/i);
    const updateAt = body().search(/update public\.item_posts set/i);
    assert.ok(mergeAt >= 0, "the merge happens");
    assert.ok(validateAt > mergeAt, "the validation sees the merged values");
    assert.ok(updateAt > validateAt, "a refused edit never reaches the write");
  });

  it("the merged values carry the clear request, so a clear is validated as stored", () => {
    // The three optional fields are the only ones a clear may empty, and the
    // merged values are what the validator reads.
    assert.match(
      body(),
      /v_merged_latitude\s*:=\s*case when v_clear_coords then null else coalesce\(p_latitude, v_existing\.latitude\) end;/i,
    );
    assert.match(
      body(),
      /v_merged_longitude\s*:=\s*case when v_clear_coords then null else coalesce\(p_longitude, v_existing\.longitude\) end;/i,
    );
    assert.match(body(), /v_merged_location_label\s*:=\s*case/i);
    // The keep-old merge is unchanged: an argument the caller did not send
    // leaves the stored value alone.
    assert.match(
      body(),
      /v_merged_title\s*:=\s*coalesce\(nullif\(btrim\(coalesce\(p_title, ''\)\), ''\), v_existing\.title\)/i,
    );
  });

  it("keeps the clear refusals before anything is written", () => {
    const refusalAt = body().search(/Field % is required on every report and cannot be cleared/i);
    const mergeAt = body().search(/v_merged_type\s*:=\s*coalesce\(/i);
    const updateAt = body().search(/update public\.item_posts set/i);
    assert.ok(refusalAt >= 0, "the required-field refusal is there");
    assert.ok(refusalAt < mergeAt, "the refusal comes before the row is read");
    assert.ok(refusalAt < updateAt, "the refusal comes before the write");
  });
});

describe("the client only names the clear argument when there is something to clear", () => {
  it("adds p_clear_fields to the RPC arguments only for a non-empty clear list", () => {
    const client = read(join(ROOT, "..", "apps", "mobile", "src", "services", "posts.ts"));
    const args = client.match(/const args: Record<string, unknown> = \{([\s\S]*?)\n {2}\};/);
    assert.ok(args, "the RPC argument object");
    // The ten shipped arguments are always there.
    for (const name of [
      "p_post_id",
      "p_type",
      "p_title",
      "p_description",
      "p_category",
      "p_event_date",
      "p_latitude",
      "p_longitude",
      "p_location_label",
      "p_youtube_url",
    ]) {
      assert.ok(args[1].includes(name), `${name} is always sent`);
    }
    // The eleventh argument is NOT in the literal — it is added only when the
    // owner really emptied something. PostgREST resolves a function by its
    // NAMED arguments, so naming an argument the deployed function does not
    // have is an error whatever its value is.
    assert.doesNotMatch(args[1], /p_clear_fields/);
    assert.match(client, /if \(clearFields\.length > 0\) \{\s*args\.p_clear_fields = \[\.\.\.clearFields\];/);
  });
});

describe("the migration touches nothing but that one function", () => {
  it("deletes no row, drops no table or column, and edits no applied file", () => {
    const lower = sql.toLowerCase();
    assert.doesNotMatch(lower, /drop table/);
    assert.doesNotMatch(lower, /drop column/);
    assert.doesNotMatch(lower, /truncate/);
    assert.doesNotMatch(lower, /delete\s+from/);
    assert.doesNotMatch(lower, /alter table/);
    assert.doesNotMatch(lower, /create policy/);
  });

  it("grants the new signature to authenticated and to nobody else", () => {
    const sig = signaturePattern(NEW_SIGNATURE);
    assert.match(
      sql,
      new RegExp(
        `revoke\\s+all\\s+on\\s+function\\s+public\\.${FN}\\(\\s*${sig}\\s*\\)\\s*from\\s+public\\s*,\\s*anon\\s*;`,
        "i",
      ),
    );
    assert.match(
      sql,
      new RegExp(
        `grant\\s+execute\\s+on\\s+function\\s+public\\.${FN}\\(\\s*${sig}\\s*\\)\\s+to\\s+authenticated\\s*;`,
        "i",
      ),
    );
    assert.doesNotMatch(sql, /grant[^;]*\bto\s+anon\b/i);
    assert.doesNotMatch(sql, /grant[^;]*\bto\s+public\b/i);
  });

  it("states that it is forward-only, live-pending, and points at its verifier", () => {
    assert.match(sql, /FORWARD-ONLY/);
    assert.match(sql, /LIVE-PENDING/);
    assert.match(sql, /supabase\/tests\/verify_20261022103000_post_update_clear_fields\.sql/);
    assert.match(sql, /supabase\/tests\/post_update_clear_fields_parity\.test\.mjs/);
  });

  it("no later migration reopens the old ten-argument signature", () => {
    const dir = join(ROOT, "migrations");
    const later = readdirSync(dir)
      .filter((file) => file.endsWith(".sql") && file > "20261022103000_post_update_clear_fields.sql");
    for (const file of later) {
      const text = readFileSync(join(dir, file), "utf8").replace(/--[^\n]*/g, "");
      assert.doesNotMatch(
        text,
        /create or replace function public\.findback_update_post_client\((?![\s\S]*p_clear_fields)/i,
        file,
      );
    }
  });
});

describe("the client advertises the schema version this migration lands", () => {
  it("BACKEND_SCHEMA_VERSION is the newest migration prefix", () => {
    const caps = read(join(ROOT, "..", "apps", "mobile", "src", "services", "appCapabilities.ts"));
    const newest = readdirSync(join(ROOT, "migrations"))
      .map((name) => name.match(/^(\d{14})_/)?.[1])
      .filter((prefix) => prefix !== undefined)
      .sort()
      .at(-1);
    assert.ok(newest, "at least one 14-digit migration prefix exists");
    assert.ok(
      caps.includes(`BACKEND_SCHEMA_VERSION = "${newest}"`),
      `BACKEND_SCHEMA_VERSION is ${newest}`,
    );
  });
});

describe("the verification file carries the readback", () => {
  it("probes the catalog and states the behavioural expectations", () => {
    assert.match(verify, /information_schema\.routine_privileges/);
    assert.match(verify, /pg_get_functiondef/);
    assert.match(verify, /proargnames/);
    assert.match(verify, /HAVE NOT BEEN EXECUTED/);
    assert.match(verify, /LIVE-PENDING/);
  });
});
