/**
 * Static checks for the saved-reports migration (20261021162726_post_saves.sql).
 *
 * No database, no network, no secrets: the migration text is parsed and the
 * properties that make it safe to apply are asserted. The BEHAVIOURAL proof
 * lives in supabase/tests/verify_20261021162726_post_saves.sql and runs
 * against a disposable PostgreSQL; this file is the guard that the shipped
 * SQL still says what it is supposed to say.
 *
 * Run: node --test supabase/tests/post_saves_parity.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIG = join(ROOT, "migrations", "20261021162726_post_saves.sql");
const VERIFY = join(ROOT, "tests", "verify_20261021162726_post_saves.sql");
const read = (p) => readFileSync(p, "utf8");

const sql = read(MIG);
const verify = read(VERIFY);
const lower = sql.toLowerCase();
// The prose of the header names the properties too ("SECURITY DEFINER with a
// locked search_path"), so statement counting runs on the executable lines
// only, with the `--` comments stripped.
const code = sql
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

const FUNCTIONS = [
  "findback_save_post_client",
  "findback_unsave_post_client",
  "findback_list_saved_posts_client",
];

describe("post_saves migration is shaped for the hosted schema", () => {
  it("declares the table with text ids and the house timestamp column", () => {
    const table = sql.match(
      /create table if not exists public\.post_saves \(([\s\S]*?)\n\);/i,
    );
    assert.ok(table, "public.post_saves is created");
    const body = table[1];

    assert.match(body, /post_id\s+text\s+not\s+null/i);
    assert.match(body, /user_id\s+text\s+not\s+null/i);
    assert.match(body, /created_at\s+text\s+not\s+null/i);
    assert.match(body, /primary key \(post_id, user_id\)/i);
    // The id columns are TEXT because public.item_posts.id and
    // public.users.id are text in the hosted schema.
    assert.doesNotMatch(body, /uuid/i);
  });

  it("points both foreign keys at the real tables, cascading", () => {
    assert.match(
      sql,
      /post_id\s+text\s+not\s+null\s+references\s+public\.item_posts\(id\)\s+on delete cascade/i,
    );
    assert.match(
      sql,
      /user_id\s+text\s+not\s+null\s+references\s+public\.users\(id\)\s+on delete cascade/i,
    );
    // There is no `posts` table in this schema and no uuid reference.
    assert.doesNotMatch(sql, /references\s+public\.posts\(/i);
    assert.doesNotMatch(sql, /references\s+auth\.users/i);
  });

  it("enables RLS and grants the table to no client role", () => {
    assert.match(sql, /alter table public\.post_saves enable row level security/i);
    assert.match(
      sql,
      /revoke all on public\.post_saves from public, anon, authenticated/i,
    );
  });

  it("gives the table an index on the account", () => {
    assert.match(
      sql,
      /create index if not exists idx_post_saves_user on public\.post_saves \(user_id\)/i,
    );
  });
});

describe("post_saves policies are owner-scoped", () => {
  const policies = [...sql.matchAll(/create policy\s+(\w+)\s+([\s\S]*?);/gi)];

  it("creates exactly the three owner-scoped policies", () => {
    assert.equal(policies.length, 3, "three policies on public.post_saves");
    for (const [, name, body] of policies) {
      assert.match(name, /^post_saves_(select|insert|delete)_own$/i);
      assert.match(body, /to authenticated/i);
      assert.match(body, /auth\.uid\(\)/i);
      assert.match(body, /\(select auth\.uid\(\)\)::text/i);
      assert.match(body, /user_id/i);
    }
  });

  it("drops each policy before recreating it", () => {
    for (const [, name] of policies) {
      assert.match(
        sql,
        new RegExp(`drop policy if exists ${name} on public\\.post_saves`, "i"),
        `${name} is dropped before it is created`,
      );
    }
  });
});

describe("post_saves RPCs are definer, locked and caller-derived", () => {
  it("locks the search_path of every SECURITY DEFINER function", () => {
    const definers = (code.match(/security definer/gi) ?? []).length;
    const paths = (code.match(/set search_path = public, pg_temp/gi) ?? []).length;
    assert.equal(definers, 3, "the file defines three definer functions");
    assert.equal(paths, definers, "every definer locks search_path");
  });

  it("creates the three client RPCs with the expected signatures", () => {
    assert.match(
      sql,
      /create function public\.findback_save_post_client\(p_post_id text\)/i,
    );
    assert.match(
      sql,
      /create function public\.findback_unsave_post_client\(p_post_id text\)/i,
    );
    assert.match(sql, /create function public\.findback_list_saved_posts_client\(\)/i);
  });

  it("takes the caller from auth.uid() and never from a parameter", () => {
    const definers = [...code.matchAll(/security definer[\s\S]*?\$\$;/gi)];
    assert.equal(definers.length, 3, "three function bodies");
    for (const [body] of definers) {
      assert.match(body, /v_uid\s+text\s*:=\s*auth\.uid\(\)::text/i);
    }
    // No RPC argument is a user id: only p_post_id (or nothing).
    const argLists = [...code.matchAll(/create function public\.findback_\w+\(([^)]*)\)/gi)];
    for (const [, args] of argLists) {
      assert.doesNotMatch(args, /user|uid/i, "no RPC takes a user id");
    }
  });

  it("verifies the report through public.item_posts", () => {
    const save = sql.match(
      /create function public\.findback_save_post_client[\s\S]*?\$\$;/i,
    );
    assert.ok(save, "the save function body");
    assert.match(save[0], /select 1 from public\.item_posts p where p\.id = trim\(p_post_id\)/i);
    assert.match(save[0], /raise exception 'Post not found' using errcode = 'P0002'/i);
  });

  it("revokes every RPC from public and anon and grants only authenticated", () => {
    const signatures = {
      findback_save_post_client: "public.findback_save_post_client(text)",
      findback_unsave_post_client: "public.findback_unsave_post_client(text)",
      findback_list_saved_posts_client: "public.findback_list_saved_posts_client()",
    };
    for (const [fn, signature] of Object.entries(signatures)) {
      assert.match(
        sql,
        new RegExp(
          `revoke all on function ${signature.replace("(", "\\(").replace(")", "\\)")} from public, anon`,
          "i",
        ),
        `${fn} is revoked from public and anon`,
      );
      assert.match(
        sql,
        new RegExp(
          `grant execute on function ${signature.replace("(", "\\(").replace(")", "\\)")} to authenticated`,
          "i",
        ),
        `${fn} is granted to authenticated`,
      );
    }
    // anon holds nothing at all in this file.
    assert.doesNotMatch(sql, /grant\s+[^;]*\bto\s+anon\b/i);
    assert.doesNotMatch(sql, /grant\s+[^;]*\bto\s+public\b/i);
  });

  it("scopes the unsave delete to the caller's own row", () => {
    const unsave = sql.match(
      /create function public\.findback_unsave_post_client[\s\S]*?\$\$;/i,
    );
    assert.ok(unsave, "the unsave function body");
    assert.match(unsave[0], /delete from public\.post_saves/i);
    assert.match(unsave[0], /s\.user_id = v_uid/i);
  });

  it("returns one complete JSON snapshot without a hidden row or device-cache cap", () => {
    const list = code.match(/create function public\.findback_list_saved_posts_client[\s\S]*?\$\$;/i)?.[0];
    assert.ok(list);
    assert.match(list, /returns jsonb/i);
    assert.match(list, /jsonb_build_object\(\s*'complete', true,\s*'items'/i);
    assert.match(list, /jsonb_agg\(/i);
    assert.match(list, /'post_id', s\.post_id, 'saved_at', s\.created_at/i);
    assert.match(list, /where s\.user_id = v_uid/i);
    assert.doesNotMatch(list, /\blimit\s+\d+/i);
  });

  it("writes the house timestamp format, server-side", () => {
    assert.match(
      sql,
      /to_char\(clock_timestamp\(\) at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS\.MS"Z"'\)/,
    );
    // The client never supplies a timestamp.
    assert.doesNotMatch(sql, /p_created_at/i);
  });

  it("refreshes the server save clock on an explicit re-save", () => {
    assert.match(code, /on conflict \(post_id, user_id\) do update\s+set created_at = excluded\.created_at/i);
    assert.match(code, /to_char\(clock_timestamp\(\) at time zone 'utc'/i);
  });
});

describe("post_saves migration is additive and idempotent", () => {
  it("keeps schema application additive and confines data mutations to caller RPCs", () => {
    assert.doesNotMatch(lower, /drop table/);
    assert.doesNotMatch(lower, /drop column/);
    assert.doesNotMatch(lower, /truncate/);
    assert.doesNotMatch(lower, /alter table public\.item_posts/);
    assert.doesNotMatch(lower, /alter table public\.users/);
    // The one DELETE FROM is the unsave RPC's own statement.
    const deletes = [...lower.matchAll(/delete\s+from\s+/g)];
    assert.equal(deletes.length, 1, "one delete statement");
    const unsaveAt = lower.indexOf("create function public.findback_unsave_post_client");
    assert.ok(deletes[0].index > unsaveAt, "the delete lives inside the unsave RPC");
  });

  it("guards every creation so a re-run changes nothing", () => {
    assert.match(sql, /create table if not exists public\.post_saves/i);
    assert.match(sql, /create index if not exists idx_post_saves_user/i);
    for (const fn of FUNCTIONS) {
      assert.match(
        sql,
        new RegExp(`drop function if exists public\\.${fn}`, "i"),
        `${fn} is dropped before it is created`,
      );
    }
  });

  it("states that it is additive, records its hosted apply, and points at its verifier", () => {
    assert.match(sql, /ADDITIVE ONLY/);
    // The migration HAS been applied to the hosted project (2026-10-21, hosted
    // version 20261021162726), so the file may no longer claim to be
    // LIVE-PENDING. It must instead name the hosted version and the readback
    // that proves it landed.
    assert.match(sql, /APPLIED/);
    assert.match(sql, /20261021162726/);
    assert.match(sql, /D2-hosted-applied-2026-10-21/);
    assert.match(sql, /supabase\/tests\/verify_20261021162726_post_saves\.sql/);
  });
});

describe("post_saves verification file carries the readback", () => {
  it("probes the table, the policies and the routine privileges", () => {
    assert.match(verify, /information_schema\.tables/);
    assert.match(verify, /pg_policies/);
    assert.match(verify, /information_schema\.routine_privileges/);
    assert.match(verify, /pg_get_functiondef/);
    assert.match(verify, /relrowsecurity/);
  });

  it("does not claim an execution it never had", () => {
    // The hosted readback for the migration exists and is recorded elsewhere,
    // but THE PROBES IN THIS FILE were not run: the file must say so, and it
    // must not let its own probes be quoted as a passing result.
    assert.match(verify, /NOT EXECUTED/);
    assert.match(verify, /Nothing here may be quoted as a passing/);
  });
});
