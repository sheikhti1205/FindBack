/** Disposable-local PostgreSQL contract gate; Node builtins + psql only.
 * PGHOST=127.0.0.1 PGDATABASE=findback_sql_test node scripts/sql-behavior.mjs
 *   --apply-chain --probe supabase/tests/verify_...sql [--probe ...]
 * The database must already exist and be empty when --apply-chain is used.
 * Platform stubs are NOT Supabase/PostgREST/hosted acceptance evidence.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// PostgreSQL strings, identifiers, dollar bodies and nested comments may all
// contain semicolons. Keep their bytes intact; remove only actual comments.
export function splitSql(sql) {
  const statements = [];
  let current = "", i = 0;
  while (i < sql.length) {
    if (sql.startsWith("--", i)) {
      while (i < sql.length && sql[i] !== "\n") i++;
      current += " ";
    } else if (sql.startsWith("/*", i)) {
      i += 2;
      let depth = 1;
      while (i < sql.length && depth) {
        if (sql.startsWith("/*", i)) { depth++; i += 2; }
        else if (sql.startsWith("*/", i)) { depth--; i += 2; }
        else i++;
      }
      if (depth) throw new Error("Unclosed SQL comment");
      current += " ";
    } else if (sql[i] === "'" || sql[i] === '"') {
      const quote = sql[i];
      const escaped = quote === "'" && /(?:^|[^\w$])[eE]$/.test(current);
      current += sql[i++];
      let closed = false;
      while (i < sql.length) {
        const char = sql[i++];
        current += char;
        if (escaped && char === "\\") {
          if (i < sql.length) current += sql[i++];
        } else if (char === quote) {
          if (sql[i] === quote) current += sql[i++];
          else { closed = true; break; }
        }
      }
      if (!closed) throw new Error("Unclosed SQL quote");
    } else if (sql[i] === "$" && /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.test(sql.slice(i))) {
      const tag = sql.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)[0];
      const end = sql.indexOf(tag, i + tag.length);
      if (end < 0) throw new Error("Unclosed SQL dollar body");
      current += sql.slice(i, end + tag.length);
      i = end + tag.length;
    } else if (sql[i] === ";") {
      if (current.trim()) statements.push(current.trim());
      current = ""; i++;
    } else {
      if (sql[i] === "\\") throw new Error("psql meta commands are not SQL probes");
      current += sql[i++];
    }
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

export function compileProbes(sql) {
  let count = 0;
  const script = splitSql(sql).map((statement) => {
    if (!/^(?:select|with)\b/i.test(statement)) return `${statement};`;
    count++;
    // Crucial: NO semicolon before gset. That would execute writes twice.
    // gset requires exactly one row; ON_ERROR_STOP makes empty/error fatal.
    return `${statement}\n\\gset fb_probe_\n\\echo PASS probe ${count}`;
  });
  if (!count) throw new Error("No SELECT/WITH probe in assertion file");
  return `set standard_conforming_strings = on;\n${script.join("\n")}\n`;
}

export function assertLocalDatabase(env) {
  if (!["127.0.0.1", "localhost", "::1"].includes(env.PGHOST)
      || !/^findback_sql_test(?:_[a-z0-9_]+)?$/.test(env.PGDATABASE ?? "")
      || env.PGHOSTADDR || env.PGSERVICE || env.PGSERVICEFILE) {
    throw new Error("Only an explicit loopback disposable findback_sql_test database is allowed");
  }
}

export function runPsql(sql, { env = process.env, psql = "psql" } = {}) {
  assertLocalDatabase(env);
  const result = spawnSync(psql, ["-X", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
    input: sql, encoding: "utf8", env, maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`SQL gate failed (psql exit ${result.status})\n${result.stderr}`);
  return result.stdout;
}

export function main(args) {
  assertLocalDatabase(process.env);
  const probes = [];
  let apply = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--apply-chain") apply = true;
    else if (args[i] === "--probe" && args[i + 1]) probes.push(resolve(args[++i]));
    else throw new Error("Usage: sql-behavior.mjs [--apply-chain] --probe <SQL file>");
  }
  if (!probes.length) throw new Error("At least one --probe is required");
  // Validate all assertions before making any database changes.
  const batches = probes.map((file) => ({ file, script: compileProbes(readFileSync(file, "utf8")) }));
  if (apply) {
    runPsql(readFileSync(join(ROOT, "supabase/tests/_full_chain_harness.sql"), "utf8"));
    const migrations = readdirSync(join(ROOT, "supabase/migrations")).filter((file) => file.endsWith(".sql")).sort();
    for (const file of migrations) {
      // Supabase-only extension; no public application schema depends on it.
      if (file === "20260914230000_enable_pg_graphql.sql") continue;
      try { runPsql(readFileSync(join(ROOT, "supabase/migrations", file), "utf8")); }
      catch (error) { throw new Error(`Migration ${file}: ${error.message}`); }
      console.log(`APPLIED ${file}`);
    }
  }
  for (const { file, script } of batches) {
    console.log(`ASSERTIONS ${file}`);
    console.log(runPsql(script));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
