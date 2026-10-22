/**
 * Static checks for the match-candidate reader
 * (20261022160000_match_candidates_reader.sql).
 *
 * No database, no network, no secrets: the migration text is parsed and the
 * properties that make it safe to apply are asserted. The BEHAVIOURAL proof
 * lives in supabase/tests/verify_20261022160000_match_candidates_reader.sql
 * and runs against a disposable PostgreSQL; this file is the guard that runs
 * everywhere, including where no engine exists.
 *
 * The strongest check here is the PROJECTION PARITY one: the candidate
 * reader's output shape must be the feed reader's shape with exactly one
 * column removed — the `blocked_author` bit. If somebody appends a block flag
 * to the candidate path, or drops a column the client's mapper needs, this
 * test fails.
 *
 * Run: node --test supabase/tests/match_candidates_reader_parity.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIG = join(ROOT, "migrations", "20261022160000_match_candidates_reader.sql");
const FEED_MIG = join(ROOT, "migrations", "20261020090000_cf060_r10_feed_block_flag.sql");
const VERIFY = join(ROOT, "tests", "verify_20261022160000_match_candidates_reader.sql");
const CAPS = join(ROOT, "..", "apps", "mobile", "src", "services", "appCapabilities.ts");
const read = (p) => readFileSync(p, "utf8");

const sql = read(MIG);
const feedSql = read(FEED_MIG);
const verify = read(VERIFY);
// The header prose names the properties too, so the statement checks run on
// the executable lines only, with the `--` comments stripped.
const normalize = (source) => source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim();
const code = normalize(sql);
function assertExecutableContract(source) {
  // Only in-scope qualifiers are equivalent. In this query c is a CTE-local
  // alias, not a legal final ORDER BY qualifier unless FROM declares it.
  const text = normalize(source).replace(
    /from filtered(?: (?:as )?(?!order\b)([a-z_]\w*))? order by (?:([a-z_]\w*)\.)?created_at desc, (?:([a-z_]\w*)\.)?id desc /i,
    (_, alias, createdQualifier, idQualifier) => {
      for (const qualifier of [createdQualifier, idQualifier]) {
        assert.ok(!qualifier || qualifier === (alias ?? "filtered"), "final ORDER BY qualifier is in scope");
      }
      return "from filtered order by created_at desc, id desc ";
    },
  );
  assert.match(text, /language sql stable security invoker set search_path = public, pg_temp as \$\$/i);
  const required = [
    "with target as ( select t.id, t.type from public.findback_visible_posts t where t.id = p_target_id ),",
    "cross join target t where c.type <> t.type and c.status = 'OPEN' and c.id <> t.id and c.user_id <> (select auth.uid())::text and not c.blocked_author ) select",
    "count(*) over() as total_count,",
    "(select count(r.id) from reactions r where r.post_id = c.id and r.type = 'DISLIKE') as dislike_count,",
    "order by created_at desc, id desc limit least(greatest(coalesce(p_limit, 20), 1), 20);",
    "where n.nspname = 'public' and p.proname = 'findback_match_candidates_client' ) then raise exception 'Match-candidate reader already exists; use a new migration' using errcode = '42723'; end if;",
  ];
  for (const expected of required) assert.ok(text.includes(expected), `missing executable contract: ${expected}`);
  const outputs = returnsTableColumns(source, "findback_match_candidates_client");
  const bodyProjection = text.match(/\) select ([\s\S]+?) from filtered order by/);
  assert.ok(bodyProjection, "final SELECT projection");
  assert.deepEqual(bodyProjection[1].split(",").map((s) => s.trim()), outputs, "body positions equal declared outputs");
  assert.equal((text.match(/create (?:or replace )?function public\.findback_match_candidates_client\(/g) ?? []).length, 1);
  assert.ok(text.startsWith("begin;"));
  assert.ok(text.endsWith("commit;"));
  assert.doesNotMatch(text, /grant[^;]+to (?:anon|public)\b/i);
}

/**
 * The declared output columns of a function, in order.
 *
 * The reader is read from the `returns table (...)` block, one column per
 * line, and the name is the first word of each line.
 */
function returnsTableColumns(source, functionName) {
  const marker = `function public.${functionName}(`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `public.${functionName} is declared`);
  const returnsAt = source.indexOf("returns table (", start);
  assert.ok(returnsAt > start, `public.${functionName} declares a table`);
  const open = source.indexOf("(", returnsAt);
  const close = source.indexOf(")", open);
  const block = source.slice(open + 1, close);
  return block
    .split(",")
    .map((line) => line.trim())
    .map((line) => line.replace(/,$/, "").trim())
    .filter((line) => /^[a-z_][a-z0-9_]*\s/.test(line))
    .map((line) => line.split(/\s+/)[0]);
}

describe("the match-candidate reader is shaped for the hosted schema", () => {
  it("retains the whole bounded predicate, actual body projection and overload fence", () => {
    assertExecutableContract(sql);
    assertExecutableContract(normalize(sql));
  });
  it("declares the reader with the target id and a clamped limit", () => {
    assert.match(
      code,
      /create function public\.findback_match_candidates_client\(\s*p_target_id text,\s*p_limit integer default 20\s*\)/i,
      "the reader takes the target id and a limit",
    );
    assert.match(code, /language\s+sql/i);
    assert.match(code, /stable/i);
    assert.match(code, /security\s+invoker/i, "the reader is an invoker: the view decides what is visible");
    assert.match(code, /set\s+search_path\s*=\s*public,\s*pg_temp/i);
  });

  it("projects the feed reader's shape with exactly one column removed", () => {
    const feed = returnsTableColumns(feedSql, "findback_query_posts_client");
    const candidate = returnsTableColumns(sql, "findback_match_candidates_client");

    assert.ok(feed.includes("blocked_author"), "the feed reader projects the block bit");
    assert.deepEqual(
      candidate,
      feed.filter((column) => column !== "blocked_author"),
      "the candidate shape is the feed shape minus the block bit, in the same order",
    );
    assert.ok(
      !candidate.includes("blocked_author"),
      "no block column is projected on the candidate path",
    );
    assert.ok(candidate.length >= 25, "the candidate row carries the whole post projection");
    assert.ok(candidate.includes("attachments"), "the attachment aggregate is carried");
    assert.ok(candidate.includes("reaction_counts"), "the reaction truth is carried");
    assert.ok(candidate.includes("my_reaction"), "the caller's own reaction is carried");
  });

  it("excludes a blocked counterpart in the WHERE clause, not by flagging it", () => {
    assert.match(
      code,
      /and\s+not\s+c\.blocked_author/i,
      "the block exclusion sits in the reader's WHERE clause",
    );
    // The exclusion is the decision: no client-side re-check, no second
    // predicate, no new block atom.
    assert.doesNotMatch(
      code,
      /findback_is_blocked_pair|findback_is_blocked_with_me|user_blocks|content_reports/i,
      "the reader reads no privileged moderation table and adds no second predicate",
    );
    assert.doesNotMatch(code, /findback_has_role|user_roles/i, "the reader reads no role table");
  });

  it("keeps the five agreed filter terms", () => {
    assert.match(code, /c\.type\s*<>\s*t\.type/i, "only the opposite type is proposed");
    assert.match(code, /c\.status\s*=\s*'OPEN'/i, "only an open report can still be the answer");
    assert.match(code, /c\.id\s*<>\s*t\.id/i, "never the target itself");
    assert.match(code, /c\.user_id\s*<>\s*\(select auth\.uid\(\)\)::text/i, "never the reader's own report");
    assert.match(code, /and\s+not\s+c\.blocked_author/i, "never a blocked counterpart");
  });

  it("reads the target from the visible view, so it cannot be lied about", () => {
    const targetCte = code.match(/with target as \(([\s\S]*?)\),\s*filtered/i);
    assert.ok(targetCte, "the target is a CTE");
    assert.match(targetCte[1], /from public\.findback_visible_posts t/i, "the target comes from the visible view");
    assert.match(targetCte[1], /where t\.id = p_target_id/i, "the target is looked up by id");
    assert.match(targetCte[1], /select t\.id, t\.type/i, "the target projects BOTH columns referenced later");
    assert.match(code, /cross join target t/i, "the target drives the candidate filters");
    // The candidate side is the same view.
    assert.match(code, /from public\.findback_visible_posts c/i);
  });

  it("clamps the page size so a NULL limit cannot return everything", () => {
    assert.match(
      code,
      /limit\s+least\(greatest\(coalesce\(p_limit,\s*20\),\s*1\),\s*20\)/i,
      "the limit is clamped to 1..20 and a NULL limit means 20",
    );
  });

  it("is granted to a signed-in caller only", () => {
    assert.match(
      code,
      /revoke all on function public\.findback_match_candidates_client\(text, integer\) from public, anon;/i,
      "the reader is revoked from anon and from public",
    );
    assert.match(
      code,
      /grant execute on function public\.findback_match_candidates_client\(text, integer\) to authenticated;/i,
      "the reader is executable by a signed-in caller",
    );
    assert.match(sql, /comment on function public\.findback_match_candidates_client\(text, integer\) is/i);
  });

  it("adds nothing else: no table, no view, no policy, no drop", () => {
    assert.doesNotMatch(code, /create\s+table/i, "no table is created");
    assert.doesNotMatch(code, /create\s+(or\s+replace\s+)?view/i, "the view is untouched");
    assert.doesNotMatch(code, /drop\s+/i, "nothing is dropped");
    assert.doesNotMatch(code, /alter\s+table/i, "no table is altered");
    assert.doesNotMatch(code, /create\s+policy/i, "no policy is created");
    assert.doesNotMatch(code, /grant\s+[^;]*on\s+table/i, "no table privilege is granted");
    // The feed reader and its neighbours are frozen (§13.9).
    assert.doesNotMatch(code, /findback_query_posts_client|findback_query_posts_nearby_client/i);
  });

  it("is forward-only and names its verifier", () => {
    assert.match(code, /^\s*begin;/im, "the migration opens a transaction");
    assert.match(code, /commit;\s*$/im, "the migration commits");
    assert.doesNotMatch(sql, /now_text\(\)/i, "there is no now_text() helper in this chain");
    assert.match(sql, /supabase\/tests\/verify_20261022160000_match_candidates_reader\.sql/i);
    assert.match(sql, /supabase\/tests\/match_candidates_reader_parity\.test\.mjs/i);
    assert.doesNotMatch(sql, /supabase\.co|db push|SUPABASE_SERVICE_ROLE/i, "no hosted access from the migration");
  });

  it("advertises the newest schema version on the client", () => {
    const caps = read(CAPS);
    const newest = readdirSync(join(ROOT, "migrations"))
      .map((name) => name.match(/^(\d{14})_/)?.[1])
      .filter((prefix) => prefix !== undefined)
      .sort()
      .at(-1);
    assert.ok(newest, "at least one 14-digit migration prefix exists");
    assert.ok(
      caps.includes(`BACKEND_SCHEMA_VERSION = "${newest}"`),
      `BACKEND_SCHEMA_VERSION names the newest migration prefix (${newest})`,
    );
  });

  it("carries the behavioural readback in the verification file", () => {
    assert.match(verify, /findback_match_candidates_client/i);
    assert.match(verify, /rollback/i, "the verifier rolls its scratch rows back");
    assert.match(verify, /UNRUN|NOT been applied/i, "the verifier states that it has not been applied");
  });
});

it("accepts equivalent in-scope ORDER BY qualifiers, not an out-of-scope CTE alias", () => {
  assertExecutableContract(sql.replace("order by created_at desc, id desc", "order by filtered.created_at desc, filtered.id desc"));
  assertExecutableContract(sql.replace("from filtered\n  order by created_at desc, id desc", "from filtered c\n  order by c.created_at desc, c.id desc"));
  assert.throws(() => assertExecutableContract(sql.replace("order by created_at desc, id desc", "order by c.created_at desc, c.id desc")));
});

for (const [before, after] of [["security invoker", "security definer"], ["search_path = public, pg_temp", "search_path = public"]]) {
  it(`ignores comment-spoofed posture: ${after}`, () => {
    const mutated = sql.replace(before, `${after} -- ${before}\n`);
    assert.notEqual(mutated, sql);
    assert.throws(() => assertExecutableContract(mutated));
  });
}

const mutations = [
  ["misspelled legacy dislike", "r.type = 'DISLIKE'", "r.type = 'DISKLIKE'"],
  ["block bypass", "and not c.blocked_author", "and not c.blocked_author or true"],
  ["own-row bypass", "and c.user_id <>", "or c.user_id <>"],
  ["type bypass", "c.type <> t.type", "(c.type <> t.type or true)"],
  ["closed admitted", "c.status = 'OPEN'", "c.status in ('OPEN','CLOSED')"],
  ["swapped text outputs", "type, title, description, category,", "type, description, title, category,"],
  ["anon execute", "to authenticated;", "to authenticated; grant execute on function public.findback_match_candidates_client(text, integer) to anon;"],
  ["hard-coded type", "select t.id, t.type", "select t.id, 'LOST'::text as type"],
  ["wrong total", "count(*) over() as total_count", "count(*) over()+1000 as total_count"],
  ["missing tiebreak", "order by created_at desc, id desc", "order by created_at desc"],
  ["second overload", "commit;", "create function public.findback_match_candidates_client(text) returns int language sql as $$select 1$$; commit;"],
  ["unprojected target id", "select t.id, t.type", "select t.type"],
];
for (const [label, before, after] of mutations) it(`rejects known mutation: ${label}`, () => {
  const original = normalize(sql);
  const mutated = original.replace(before, after);
  assert.ok(mutated !== original, "mutation must change executable bytes");
  assert.throws(() => assertExecutableContract(mutated));
});
