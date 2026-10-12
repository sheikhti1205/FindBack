#!/usr/bin/env node
/**
 * write-manifest.mjs — deterministic evidence manifest (offline, pure builtins).
 *
 * Usage:
 *   node scripts/device-harness/write-manifest.mjs --dir <evidence-dir>
 *
 * Walks <dir> recursively, writes manifest.json listing every file (relative
 * path, byte size, SHA256) plus manifest header (tool, UTC time, git SHA12,
 * scrub attestation). Refuses to write when any file matches a secret pattern
 * (sb_secret_*, service_role JWT, DSN userinfo) — the orchestrator must scrub
 * first; this is the fail-closed backstop.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

function fail(msg) {
  console.error(`write-manifest: FAIL: ${msg}`);
  process.exit(1);
}

const dirFlag = process.argv.indexOf("--dir");
if (dirFlag < 0 || !process.argv[dirFlag + 1]) fail("expected --dir <evidence-dir>");
const dir = resolve(process.cwd(), process.argv[dirFlag + 1]);
try {
  if (!statSync(dir).isDirectory()) fail(`not a directory: ${dir}`);
} catch {
  fail(`not a directory: ${dir}`);
}

const SECRET_RES = [
  /sb_secret_[A-Za-z0-9_.-]+/,
  /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_.-]+/,
  /https:\/\/[^/@:\s]+@[A-Za-z0-9.-]+/,
  /\[SCRUBBED[_\]]/,
];

function walk(d, out = []) {
  for (const name of readdirSync(d).sort()) {
    if (name === "manifest.json") continue;
    const p = join(d, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const gitSha = (() => {
  const r = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "(unknown)";
})();

const files = [];
for (const p of walk(dir)) {
  const rel = relative(dir, p);
  const bytes = readFileSync(p);
  const text = bytes.toString("utf8");
  for (const re of SECRET_RES.slice(0, 3)) {
    if (re.test(text)) fail(`secret pattern ${re} in ${rel} — scrub before manifesting`);
  }
  const h = createHash("sha256");
  h.update(bytes);
  files.push({ path: rel, bytes: bytes.length, sha256: h.digest("hex") });
}

const manifest = {
  tool: "write-manifest.mjs",
  created_utc: new Date().toISOString(),
  git_sha_full: gitSha,
  git_sha12: gitSha.slice(0, 12),
  scrub_attested: true,
  scrub_note: "Common.sh scrub_file applied by orchestrator; this manifest fails closed on residual secret patterns. [SCRUBBED_*] markers (if any) are expected.",
  file_count: files.length,
  files,
};

writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`write-manifest: PASS dir=${dir} files=${files.length} sha=${gitSha.slice(0, 12)}`);
