// Parse-level guard for every migration (CF-060 R10 follow-up).
//
// Why this exists: the R10 readers shipped with an unescaped apostrophe inside
// a single-quoted `comment on function ... is '...'` body. Every text-level
// parity test passed, and both migrations were still unparseable — Supabase
// would have refused the push, so the readers would never have existed. A
// parity test compares text to text; it cannot see a broken string.
//
// This scanner does not pretend to be PostgreSQL. It is a lexer over the exact
// lexical constructs that can swallow the rest of a file when they are broken:
//
//   * line comments (`-- ...`),
//   * nested block comments (`/* ... /* ... */ ... */`, which PostgreSQL nests),
//   * single-quoted strings, including `''` escapes and `E'...'` backslash
//     escapes (the R10 bug was an unterminated single-quoted string),
//   * quoted identifiers (`"..."`, `""` escape),
//   * dollar-quoted strings (`$$`, `$tag$`), including the `$cmt$` style the
//     R10 comment bodies now use so a possessive apostrophe cannot end it.
//
// At end of file all three must be closed. A single misplaced quote shifts the
// lexer into string state and the EOF check fails, which is exactly the R10
// failure. That is a real parse-level signal, not a style preference.
//
// LIMIT, stated honestly: this proves lexical balance, not grammar. It cannot
// tell whether a statement is valid SQL. The engine proof for the R10 pair is
// the mandatory apply step recorded in each R10 migration header and in the
// handoff (`FAILED 0` from the disposable PostgreSQL 17 chain); this suite is
// the cheap guard that runs everywhere, including where no engine exists.

import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const SUPABASE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = join(SUPABASE_ROOT, "migrations");

/** Return every lexical problem in `sql`; an empty array means balanced. */
export function scanSql(sql) {
  const problems = [];
  const n = sql.length;
  let i = 0;

  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (ch === "-" && next === "-") {
      const lineEnd = sql.indexOf("\n", i + 2);
      i = lineEnd === -1 ? n : lineEnd + 1;
      continue;
    }

    if (ch === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth += 1;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth -= 1;
          i += 2;
        } else {
          i += 1;
        }
      }
      if (depth > 0) {
        problems.push({ offset: i, kind: "unterminated block comment" });
        return problems;
      }
      continue;
    }

    if (ch === "'") {
      // E'...' honours backslash escapes; a plain '...' only doubles quotes.
      const prefix = sql.slice(Math.max(0, i - 2), i);
      const escapeString =
        /(^|[^\w$])[eE]$/.test(prefix);
      i += 1;
      let closed = false;
      while (i < n) {
        if (escapeString && sql[i] === "\\") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          closed = true;
          i += 1;
          break;
        }
        i += 1;
      }
      if (!closed) {
        problems.push({ offset: i, kind: "unterminated single-quoted string" });
        return problems;
      }
      continue;
    }

    if (ch === '"') {
      i += 1;
      let closed = false;
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            i += 2;
            continue;
          }
          closed = true;
          i += 1;
          break;
        }
        i += 1;
      }
      if (!closed) {
        problems.push({ offset: i, kind: "unterminated quoted identifier" });
        return problems;
      }
      continue;
    }

    if (ch === "$") {
      const opener = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (opener) {
        const tag = opener[0];
        const end = sql.indexOf(tag, i + tag.length);
        if (end === -1) {
          problems.push({ offset: i, kind: `unterminated dollar quote ${tag}` });
          return problems;
        }
        i = end + tag.length;
        continue;
      }
    }

    i += 1;
  }

  return problems;
}

const files = (await readdir(MIGRATIONS))
  .filter((name) => name.endsWith(".sql"))
  .sort();

describe("every migration is lexically balanced", () => {
  for (const name of files) {
    it(name, async () => {
      const sql = await readFile(join(MIGRATIONS, name), "utf8");
      assert.ok(sql.trim().length > 0, `${name} is empty`);
      assert.deepEqual(
        scanSql(sql),
        [],
        `${name} has an unterminated comment/string/identifier — PostgreSQL would refuse it`,
      );
    });
  }
});

describe("SQL text can never close a statement string early", () => {
  it("scanner catches the exact R10 defect (unescaped apostrophe in a quoted body)", () => {
    const broken = [
      "begin;",
      "comment on function public.f()",
      "  is 'the caller and this row's author are blocked';",
      "commit;",
    ].join("\n");
    const problems = scanSql(broken);
    assert.equal(problems.length, 1);
    assert.match(problems[0].kind, /unterminated single-quoted string/);
  });

  it("scanner accepts the dollar-quoted form the R10 files use", () => {
    const fixed = [
      "begin;",
      "comment on function public.f()",
      "  is $cmt$the caller and this row's author are blocked$cmt$;",
      "commit;",
    ].join("\n");
    assert.deepEqual(scanSql(fixed), []);
  });

  for (const name of files.filter((n) => /cf060_r10/.test(n))) {
    it(`${name} dollar-quotes its comment bodies`, async () => {
      const sql = await readFile(join(MIGRATIONS, name), "utf8");
      // A backtick-free, apostrophe-bearing sentence is the failure class; the
      // R10 files must not use a single-quoted COMMENT body at all.
      assert.doesNotMatch(
        sql,
        /\bcomment\s+on\b[\s\S]*?\bis\s+'/i,
        `${name} still has a single-quoted COMMENT body; use $cmt$ ... $cmt$`,
      );
      assert.match(sql, /\bis\s+\$[A-Za-z_0-9]*\$/i, `${name} should dollar-quote its comment body`);
    });
  }
});
