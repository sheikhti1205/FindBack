#!/usr/bin/env node
/**
 * check-edge-parity: Edge Function parity checker (SYNC-13/14/15, SYNC0-D09/D11).
 *
 * Compares repo function source hashes (sha256 of
 * supabase/functions/<name>/index.ts) against a deployed manifest supplied
 * by the caller/CI. No network calls in this checker — the manifest is
 * injected (file path via --manifest, or object in tests).
 *
 * Covered functions (5):
 *   ai-help, push-dispatch, reply-comment, cleanup-comment-media, delete-account
 *
 * Per-function status:
 *   CURRENT — manifest sha256 matches repo sha256
 *   STALE   — manifest entry exists but sha256 differs
 *   MISSING — no manifest entry for the function (not deployed / unknown)
 *
 * Exit codes: 0 all CURRENT, 1 any STALE/MISSING, 2 usage error.
 *
 * ---------------------------------------------------------------------------
 * DEPLOYMENT PLAN (owner-side; this script only reports, never deploys):
 *   1. push-dispatch: redeploy only after the push-secrets probe
 *      (scripts/check-push-config.mjs) reports all PRESENT. Redeploy command
 *      (owner runs): supabase functions deploy push-dispatch --no-verify-jwt.
 *   2. cleanup-comment-media: deploy ONLY after migration
 *      20261013020000 (comment_media_cleanup_lease) is live on the target
 *      project. Deploy command (owner runs):
 *      supabase functions deploy cleanup-comment-media [--no-verify-jwt per
 *      its invocation contract].
 *   3. ai-help / reply-comment: redeploy ONLY if this checker proves STALE
 *      (manifest sha256 != repo sha256). Matching (CURRENT) means no
 *      redeploy. Missing (MISSING) means first-time deploy review.
 *   4. delete-account: NOT covered by .github/workflows/backend-deploy.yml
 *      (that workflow patterns only ai-help/push-dispatch/reply-comment plus
 *      the newly added cleanup-comment-media). delete-account deploys
 *      separately, owner-side, after explicit auth-review — never silently
 *      added to the shared backend pipeline by this change.
 * Actual deploys are owner-side; CI calls this checker read-only.
 * ---------------------------------------------------------------------------
 *
 * Usage:
 *   node scripts/check-edge-parity.mjs --manifest <manifest.json>
 *   node scripts/check-edge-parity.mjs --manifest <manifest.json> --root <repo-root>
 *
 * Manifest JSON shape (array or { functions: [...] }):
 *   [{ "name": "<fn>", "sha256": "<64-hex>", "version": "...", "verify_jwt": true|false }, ...]
 * Extra manifest entries for unknown names are ignored (reported on stderr
 * as warnings, never failures).
 *
 * Pure injectable API (exported for node --test, no I/O inside):
 *   sha256Hex(text), checkParity({ localHashes, manifestEntries }),
 *   computeLocalHashes(readSource), parseManifest(input), summarize(results),
 *   formatParityReport(results)
 * Importing this module has no side effects; the CLI runs on direct execution.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

export const EDGE_FUNCTIONS = [
  "ai-help",
  "push-dispatch",
  "reply-comment",
  "cleanup-comment-media",
  "delete-account",
];

/** sha256 hex of UTF-8 text. */
export function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Compute repo hashes via an injectable reader.
 * readSource(name) -> source text (string). Throw / return null/undefined
 * when the source cannot be read.
 * Returns: { [name]: { sha256 } | { missing: true, reason } }
 */
export function computeLocalHashes(readSource) {
  const out = {};
  for (const name of EDGE_FUNCTIONS) {
    let source;
    try {
      source = readSource(name);
    } catch (error) {
      out[name] = { missing: true, reason: String(error?.message ?? error) };
      continue;
    }
    if (typeof source !== "string") {
      out[name] = { missing: true, reason: "unreadable source" };
      continue;
    }
    out[name] = { sha256: sha256Hex(source) };
  }
  return out;
}

/** Default disk reader: supabase/functions/<name>/index.ts under root. */
export function diskReadSource(root = REPO_ROOT) {
  return (name) => readFileSync(resolve(root, "supabase", "functions", name, "index.ts"), "utf8");
}

/**
 * Parse + validate a deployed manifest (object or JSON string).
 * Returns an array of { name, sha256, version, verify_jwt }.
 * Throws on malformed input. Unknown-function entries are kept (caller warns).
 */
export function parseManifest(input) {
  let data = input;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      throw new Error("check-edge-parity: manifest is not valid JSON");
    }
  }
  const list = Array.isArray(data) ? data : data?.functions;
  if (!Array.isArray(list)) {
    throw new Error("check-edge-parity: manifest must be an array or { functions: [...] }");
  }
  return list.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`check-edge-parity: manifest entry ${index} is not an object`);
    }
    const { name, sha256, version, verify_jwt } = entry;
    if (typeof name !== "string" || !name) {
      throw new Error(`check-edge-parity: manifest entry ${index} has no name`);
    }
    if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(sha256)) {
      throw new Error(`check-edge-parity: manifest entry "${name}" has invalid sha256 (expected 64 hex chars)`);
    }
    return { name, sha256: sha256.toLowerCase(), version, verify_jwt };
  });
}

/**
 * Compare local hashes against manifest entries. Pure, no I/O.
 * localHashes: output of computeLocalHashes.
 * manifestEntries: output of parseManifest.
 * Returns: [{ name, status, local, deployed, version, verify_jwt }]
 */
export function checkParity({ localHashes, manifestEntries }) {
  const deployedByName = new Map();
  for (const entry of manifestEntries ?? []) {
    if (!deployedByName.has(entry.name)) deployedByName.set(entry.name, entry);
  }
  return EDGE_FUNCTIONS.map((name) => {
    const local = localHashes?.[name];
    const deployed = deployedByName.get(name) ?? null;
    if (!local || local.missing || !local.sha256) {
      return { name, status: "MISSING", local: null, deployed: deployed?.sha256 ?? null, version: deployed?.version, verify_jwt: deployed?.verify_jwt, detail: "repo source unreadable" };
    }
    if (!deployed) {
      return { name, status: "MISSING", local: local.sha256, deployed: null, version: undefined, verify_jwt: undefined };
    }
    if (String(deployed.sha256).toLowerCase() === String(local.sha256).toLowerCase()) {
      return { name, status: "CURRENT", local: local.sha256, deployed: deployed.sha256, version: deployed.version, verify_jwt: deployed.verify_jwt };
    }
    return { name, status: "STALE", local: local.sha256, deployed: deployed.sha256, version: deployed.version, verify_jwt: deployed.verify_jwt };
  });
}

/** Count statuses; exitCode 0 when all CURRENT, else 1. */
export function summarize(results) {
  const counts = { CURRENT: 0, STALE: 0, MISSING: 0 };
  for (const row of results) {
    if (counts[row.status] !== undefined) counts[row.status] += 1;
  }
  const exitCode = counts.STALE === 0 && counts.MISSING === 0 ? 0 : 1;
  return { ...counts, exitCode };
}

function shortHash(hash) {
  return hash ? `${hash.slice(0, 12)}…` : "-";
}

/** Human-readable table. Hashes are of public source (not secrets). */
export function formatParityReport(results) {
  const lines = ["check-edge-parity: per-function status (name | status | local | deployed) "];
  for (const row of results) {
    lines.push(`  ${row.name} | ${row.status} | ${shortHash(row.local)} | ${shortHash(row.deployed)}`);
  }
  const summary = summarize(results);
  lines.push(
    `check-edge-parity: ${summary.CURRENT} CURRENT, ${summary.STALE} STALE, ${summary.MISSING} MISSING`,
  );
  return lines.join("\n");
}

function printHelp() {
  console.log(`check-edge-parity: compare repo Edge Function sources to a deployed manifest

usage:
  node scripts/check-edge-parity.mjs --manifest <manifest.json> [--root <repo-root>]

options:
  --manifest <path>  deployed manifest JSON (required, read-only input)
  --root <path>      repo root for supabase/functions/* (default: repo root)
  --help             print this help and exit 0

exit codes: 0 all CURRENT, 1 any STALE/MISSING, 2 usage error`);
}

function isMainModule() {
  const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
  return invoked === fileURLToPath(import.meta.url);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }
  const manifestFlag = args.indexOf("--manifest");
  const manifestPath = manifestFlag !== -1 ? args[manifestFlag + 1] : undefined;
  if (!manifestPath) {
    console.error("check-edge-parity: --manifest <path> is required");
    process.exit(2);
  }
  const rootFlag = args.indexOf("--root");
  const root = rootFlag !== -1 ? (args[rootFlag + 1] ?? REPO_ROOT) : REPO_ROOT;
  const unknown = args.filter((arg, index) => {
    if (arg === "--manifest" || index === manifestFlag + 1) return false;
    if (arg === "--root" || index === rootFlag + 1) return false;
    return arg.startsWith("--");
  });
  if (unknown.length > 0) {
    console.error(`check-edge-parity: unknown flag(s): ${unknown.join(", ")}`);
    process.exit(2);
  }
  let manifestRaw;
  try {
    manifestRaw = readFileSync(resolve(manifestPath), "utf8");
  } catch (error) {
    console.error(`check-edge-parity: cannot read manifest ${manifestPath} (${error.message})`);
    process.exit(2);
  }
  let manifestEntries;
  try {
    manifestEntries = parseManifest(manifestRaw);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  for (const entry of manifestEntries) {
    if (!EDGE_FUNCTIONS.includes(entry.name)) {
      console.error(`check-edge-parity: warning: ignoring unknown manifest entry "${entry.name}"`);
    }
  }
  const localHashes = computeLocalHashes(diskReadSource(resolve(root)));
  const results = checkParity({ localHashes, manifestEntries });
  console.log(formatParityReport(results));
  process.exit(summarize(results).exitCode);
}

if (isMainModule()) {
  main();
}
