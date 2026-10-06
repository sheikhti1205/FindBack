#!/usr/bin/env node
/**
 * completion-gate: fail-closed completion/release gate (audit FBA-023/024).
 *
 * The completion audit's core failure mode was "green CI treated as proof of
 * completion" while P0/P1 findings, deferrals and work markers stayed open.
 * This gate makes that state machine-checkable:
 *
 *   node scripts/completion-gate.mjs            # integrity mode (CI)
 *   node scripts/completion-gate.mjs --release  # fail-closed release gate
 *
 * Integrity mode (default) fails when the ledger is malformed: unknown
 * status/severity, duplicate ids, a CLOSED item with no evidence, an OPEN
 * (BLOCKED_EXTERNAL / IN_PROGRESS / VERIFIED_WITH_LIMITATION) item with no
 * named blocker, or an unallowlisted TODO/FIXME-style work marker in shipped
 * source. This keeps CI honest without pretending external blockers are done.
 *
 * Release mode adds the closure rule: no P0/P1 item may remain unclosed and
 * releaseStatus must be READY. A release is impossible while any P0/P1 is
 * BLOCKED_EXTERNAL/IN_PROGRESS, which is exactly the audit HOLD condition.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..");

export const CLOSED_STATUSES = Object.freeze(["DONE", "VERIFIED", "OK"]);
export const OPEN_STATUSES = Object.freeze(["IN_PROGRESS", "BLOCKED_EXTERNAL", "VERIFIED_WITH_LIMITATION"]);
export const ALL_STATUSES = Object.freeze([...CLOSED_STATUSES, ...OPEN_STATUSES]);
const SEVERITIES = Object.freeze(["P0", "P1", "P2", "P3", "OK"]);

/** Tracked work markers that are deliberate and have a ledger owner. */
export const DEBT_ALLOWLIST = Object.freeze([
  { file: "apps/mobile/src/services/similarity.ts", contains: "TODO(DEVICE-CALIBRATION)", owner: "FBA-013" },
]);

const DEBT_MARKER = /\b(TODO|FIXME|XXX|HACK)\b/;
const SCAN_EXTENSIONS = Object.freeze([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".kt", ".java", ".sql", ".cs", ".py"]);
const SCAN_DIRS = Object.freeze([
  "apps/mobile/src",
  "apps/api/src",
  "services",
  "packages/shared/src",
  "supabase/functions",
  "supabase/migrations",
]);
const SKIP_DIR_NAMES = Object.freeze(new Set(["node_modules", "build", "dist", ".gradle", "generated", "third_party", "vendor", "Pods"]));
const SKIP_FILE = /(?:\.test\.|\.spec\.|__tests__|__mocks__)|(?:^|\/)(?:testing|fixtures|__fixtures__)\//;

export function loadLedger(root = REPO_ROOT) {
  return JSON.parse(readFileSync(resolve(root, "completion-ledger.json"), "utf8"));
}

/**
 * Validate the completion ledger's integrity; `release` adds the closure rule.
 * Returns a list of human-readable errors (empty == pass).
 */
export function validateLedger(ledger, { release = false } = {}) {
  const errors = [];
  if (!ledger || typeof ledger !== "object") return ["ledger is not an object"];
  if (ledger.version !== 1) errors.push(`unsupported ledger version: ${JSON.stringify(ledger.version)}`);
  if (!Array.isArray(ledger.items) || ledger.items.length === 0) return [...errors, "ledger.items must be a non-empty array"];

  const seen = new Set();
  for (const item of ledger.items) {
    const tag = item?.id ?? "<missing id>";
    if (typeof item?.id !== "string" || !/^FBA-\d{3}$/.test(item.id)) errors.push(`${tag}: id must match FBA-NNN`);
    if (seen.has(item?.id)) errors.push(`${tag}: duplicate id`);
    seen.add(item?.id);
    if (!SEVERITIES.includes(item?.severity)) errors.push(`${tag}: invalid severity ${JSON.stringify(item?.severity)}`);
    if (!ALL_STATUSES.includes(item?.status)) errors.push(`${tag}: invalid status ${JSON.stringify(item?.status)}`);
    const evidence = typeof item?.evidence === "string" ? item.evidence.trim() : "";
    const blocker = typeof item?.blocker === "string" ? item.blocker.trim() : "";
    if (CLOSED_STATUSES.includes(item?.status) && evidence === "") errors.push(`${tag}: CLOSED status ${item.status} requires non-empty evidence`);
    if (OPEN_STATUSES.includes(item?.status) && blocker === "") errors.push(`${tag}: OPEN status ${item.status} requires a named blocker`);
  }

  const openP0P1 = ledger.items.filter((item) => (item?.severity === "P0" || item?.severity === "P1") && !CLOSED_STATUSES.includes(item?.status));
  if (release) {
    if (ledger.releaseStatus !== "READY") errors.push(`releaseStatus is ${JSON.stringify(ledger.releaseStatus)} (must be READY to release)`);
    for (const item of openP0P1) errors.push(`release blocked: ${item.id} (${item.severity}) is ${item.status}`);
  }
  return errors;
}

/** Find work markers in shipped source that are not on the debt allowlist. */
export function findUnallowlistedDebt(files, { allowlist = DEBT_ALLOWLIST } = {}) {
  const errors = [];
  for (const [relPath, contents] of Object.entries(files)) {
    const normalized = relPath.split(sep).join("/");
    contents.split("\n").forEach((line, index) => {
      const marker = DEBT_MARKER.exec(line);
      if (!marker) return;
      const allowed = allowlist.some((entry) => entry.file === normalized && line.includes(entry.contains));
      if (!allowed) errors.push(`${normalized}:${index + 1}: unallowlisted ${marker[1]} work marker`);
    });
  }
  return errors;
}

function walk(dir, files) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIR_NAMES.has(name)) continue;
    const full = resolve(dir, name);
    let info;
    try {
      info = statSync(full);
    } catch {
      continue;
    }
    if (info.isDirectory()) {
      walk(full, files);
    } else if (SCAN_EXTENSIONS.includes(name.slice(name.lastIndexOf("."))) && !SKIP_FILE.test(full)) {
      const rel = relative(REPO_ROOT, full).split(sep).join("/");
      files[rel] = readFileSync(full, "utf8");
    }
  }
}

export function collectShippedSources(root = REPO_ROOT) {
  const files = {};
  for (const dir of SCAN_DIRS) walk(resolve(root, dir), files);
  return files;
}

export function checkCompletionGate({ release = false, ledger = loadLedger(), files = collectShippedSources() } = {}) {
  const errors = [...validateLedger(ledger, { release }), ...findUnallowlistedDebt(files)];
  return { passed: errors.length === 0, errors };
}

function printHelp() {
  console.log(`completion-gate: fail-closed completion/release gate

usage:
  node scripts/completion-gate.mjs [--release] [--json] [--help]

modes:
  default    ledger integrity + no unallowlisted work markers in shipped source
  --release  additionally require releaseStatus=READY and all P0/P1 closed

exit codes: 0 pass, 1 gate failure, 2 usage error`);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }
  const known = new Set(["--release", "--json"]);
  const unknown = args.filter((arg) => arg.startsWith("--") && !known.has(arg));
  if (unknown.length > 0) {
    console.error(`completion-gate: unknown flag(s): ${unknown.join(", ")}`);
    process.exit(2);
  }
  const release = args.includes("--release");
  const { passed, errors } = checkCompletionGate({ release });
  if (args.includes("--json")) {
    console.log(JSON.stringify({ passed, mode: release ? "release" : "integrity", errors }, null, 2));
  } else {
    for (const error of errors) console.error(`completion-gate: FAIL ${error}`);
    console.log(
      passed
        ? `completion-gate: PASS (${release ? "release" : "integrity"} mode)`
        : `completion-gate: FAIL (${release ? "release" : "integrity"} mode, ${errors.length} error(s))`,
    );
  }
  process.exit(passed ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
