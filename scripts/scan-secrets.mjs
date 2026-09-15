#!/usr/bin/env node
/** Fail if a secret-looking value is tracked or supplied as an explicit file argument. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const secretPrefix = ["sb", "secret"].join("_") + "_";
const serviceRoleName = ["SUPABASE", "SERVICE", "ROLE", "KEY"].join("_");
const PATTERNS = [
  new RegExp(`${secretPrefix}[A-Za-z0-9_-]+`),
  new RegExp(`${serviceRoleName}\\s*=\\s*\\S+`),
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/,
];
const SKIP = /(^|\/)(node_modules|\.git|dist|build|\.gradle)\//;
const explicit = process.argv.slice(2);
const files = explicit.length
  ? explicit
  : execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);
const hits = [];
for (const file of files) {
  if (SKIP.test(file)) continue;
  if (!explicit.length && !/\.(ts|tsx|js|mjs|json|md|gradle|java|kt|xml|yml|yaml|env|properties)$/.test(file)) continue;
  if (!fs.existsSync(file)) continue;
  if (file === ".env.example") continue;
  const text = fs.readFileSync(file, "utf8");
  for (const pattern of PATTERNS) if (pattern.test(text)) hits.push(`${file}: ${pattern}`);
}
if (hits.length) { console.error(`scan-secrets: ${hits.length} hit(s)\n${hits.join("\n")}`); process.exit(1); }
console.log(`scan-secrets: clean (${files.length} file(s))`);
