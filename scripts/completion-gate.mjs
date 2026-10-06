#!/usr/bin/env node
/**
 * completion-gate: fail-closed completion/release gate (audit FBA-023/024).
 *
 * The completion audit's core failure mode was "green CI treated as proof of
 * completion" while findings, deferrals and work markers stayed open. This
 * gate makes that state machine-checkable:
 *
 *   node scripts/completion-gate.mjs            # integrity mode (CI)
 *   node scripts/completion-gate.mjs --final    # full closure (pre-release)
 *   node scripts/completion-gate.mjs --release  # final + releaseStatus READY
 *
 * Integrity mode (default) fails on malformed ledger state: unknown
 * status/severity, ledger ids that do not exactly match the canonical
 * findings manifest, duplicate ids, a CLOSED item with no evidence, an OPEN
 * item with no named blocker, a WAIVED item with no waiver, or an
 * unallowlisted TODO/FIXME-style work marker in shipped source (including
 * production Android/Kotlin/XML).
 *
 * Final mode adds the "complete once and for all" semantics:
 *   - every finding is closed (DONE/VERIFIED/OK) or formally waived
 *     (WAIVED + written waiver) — P2/P3 cannot silently remain open;
 *   - no DONE/VERIFIED/OK item retains a blocker (cross-references belong
 *     in evidence; an unresolved blocker means the item is not closed);
 *   - every evidence string cites at least one verifiable reference
 *     (an existing repo path, an existing commit, a CI run id, or a
 *     manual:<runbook> id with a matching docs/runbooks/ file), and no
 *     cited repo path dangles;
 *   - the audit register names every ledger id with a state cell that
 *     agrees with the ledger (no DONE-in-ledger/IN_PROGRESS-in-doc drift);
 *   - current docs carry no stale "ledger upcoming" predictions and no
 *     stale active baseline SHA;
 *   - unresolved it.todo/describe.todo/skips are allowlisted as
 *     device-only with an owner, or the gate fails;
 *   - the ledger is bound to HEAD: the tree is clean and nothing but the
 *     ledger itself changed since `generatedFor`. Reconcile the ledger
 *     LAST (final commit touches only completion-ledger.json), then tag.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..");

/** Canonical audit findings. The ledger must contain exactly these ids. */
export const FINDINGS_MANIFEST = Object.freeze([
  ...Array.from({ length: 34 }, (_, i) => `FBA-${String(i + 1).padStart(3, "0")}`),
  // Closure-review packet (2026-10-06): password recovery was an unlisted
  // missing flow; account deletion an unlisted scope decision. Both are now
  // tracked explicitly instead of being discovered after "completion".
  "FBA-035",
  "FBA-036",
  // v0.9.0-beta.1 finishing wave (2026-10-07): consumer Help/Assistant
  // readiness and real dependency-security closure, both tracked explicitly.
  "FBA-037",
  "FBA-038",
]);

export const CLOSED_STATUSES = Object.freeze(["DONE", "VERIFIED", "OK"]);
/** WAIVED is closed-for-release: an accepted limitation with a written waiver. */
export const WAIVED_STATUS = "WAIVED";
export const FINAL_CLOSED_STATUSES = Object.freeze([...CLOSED_STATUSES, WAIVED_STATUS]);
export const OPEN_STATUSES = Object.freeze(["IN_PROGRESS", "BLOCKED_EXTERNAL", "VERIFIED_WITH_LIMITATION"]);
export const ALL_STATUSES = Object.freeze([...FINAL_CLOSED_STATUSES, ...OPEN_STATUSES]);
const SEVERITIES = Object.freeze(["P0", "P1", "P2", "P3", "OK"]);

/** Tracked work markers that are deliberate and have a ledger owner. */
export const DEBT_ALLOWLIST = Object.freeze([
  { file: "apps/mobile/src/services/similarity.ts", contains: "TODO(DEVICE-CALIBRATION)", owner: "FBA-013" },
]);

/**
 * Unresolved todo/skip inventory that is genuinely device-only (or an
 * optional manual suite) and therefore may remain without failing --final.
 * Everything else must become a real test before final closure.
 */
export const SKIP_ALLOWLIST = Object.freeze([
  { file: "apps/mobile/src/test-wiring-pulltorefresh-profile.test.ts", contains: "FEED-03 device trace", owner: "FBA-014", reason: "needs owner hardware trace (Gate-E)" },
  { file: "apps/mobile/src/test-wiring-pulltorefresh-profile.test.ts", contains: "before trace:", owner: "FBA-014", reason: "needs owner hardware trace (Gate-E)" },
  { file: "apps/mobile/src/test-wiring-pulltorefresh-profile.test.ts", contains: "after trace", owner: "FBA-014", reason: "needs owner hardware trace (Gate-E)" },
  { file: "apps/mobile/src/test-wiring-sen01-gates.test.ts", contains: "signed APK carries bundle asserts", owner: "FBA-015", reason: "needs release-signed artifact + device" },
  { file: "apps/mobile/src/services/media/motionPhoto.real.test.ts", contains: "MANUAL-ONLY supplied Xiaomi", owner: "FBA-016", reason: "optional manual validation; deterministic fixture runs in CI" },
  { file: "apps/mobile/src/test-wiring-sen01-gates.test.ts", contains: "SEN-01 device-only boundary", owner: "FBA-015", reason: "needs release-signed artifact + device" },
]);

/** Docs that must read as current (no stale predictions or baselines). */
export const CURRENT_DOCS = Object.freeze([
  "README.md",
  "DEFERRED_DECISIONS.md",
  "docs/REQUIREMENTS_MATRIX.md",
  "docs/FINAL_ACCEPTANCE_REPORT.md",
  "docs/DEMO_CHECKLIST.md",
]);
const STALE_LEDGER_PREDICTIONS = Object.freeze([
  "upcoming `completion-ledger.json`",
  "upcoming completion ledger",
  "planned machine ledger",
  "ledger does not yet exist",
  "not claimed present",
  "upcoming work; no pass accepted here",
]);

const DEBT_MARKER = /\b(TODO|FIXME|XXX|HACK)\b/;
const SKIP_MARKER = /\.(todo|skip)\s*\(|skipIf\s*\(/;
const SCAN_EXTENSIONS = Object.freeze([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".kt", ".java", ".xml", ".sql", ".cs", ".py"]);
const SCAN_DIRS = Object.freeze([
  "apps/mobile/src",
  "apps/mobile/android/app/src/main",
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
 * Validate the completion ledger's integrity; `final` adds full closure
 * rules, `release` adds the READY requirement. Pure apart from injected
 * checkers so tests can run it without git or the working tree.
 */
export function validateLedger(ledger, { final = false, release = false } = {}, checkers = {}) {
  const errors = [];
  if (!ledger || typeof ledger !== "object") return ["ledger is not an object"];
  if (ledger.version !== 1) errors.push(`unsupported ledger version: ${JSON.stringify(ledger.version)}`);
  if (!Array.isArray(ledger.items) || ledger.items.length === 0) return [...errors, "ledger.items must be a non-empty array"];

  const seen = new Set();
  const byId = new Map();
  for (const item of ledger.items) {
    const tag = item?.id ?? "<missing id>";
    if (typeof item?.id !== "string" || !/^FBA-\d{3}$/.test(item.id)) errors.push(`${tag}: id must match FBA-NNN`);
    if (seen.has(item?.id)) errors.push(`${tag}: duplicate id`);
    seen.add(item?.id);
    byId.set(item?.id, item);
    if (!SEVERITIES.includes(item?.severity)) errors.push(`${tag}: invalid severity ${JSON.stringify(item?.severity)}`);
    if (!ALL_STATUSES.includes(item?.status)) errors.push(`${tag}: invalid status ${JSON.stringify(item?.status)}`);
    const evidence = typeof item?.evidence === "string" ? item.evidence.trim() : "";
    const blocker = typeof item?.blocker === "string" ? item.blocker.trim() : "";
    const waiver = typeof item?.waiver === "string" ? item.waiver.trim() : "";
    if (CLOSED_STATUSES.includes(item?.status) && evidence === "") errors.push(`${tag}: CLOSED status ${item.status} requires non-empty evidence`);
    if (item?.status === WAIVED_STATUS && (waiver === "" || evidence === "")) {
      errors.push(`${tag}: WAIVED requires a written waiver and acceptance evidence`);
    }
    if (OPEN_STATUSES.includes(item?.status) && blocker === "") errors.push(`${tag}: OPEN status ${item.status} requires a named blocker`);
    if (final && CLOSED_STATUSES.includes(item?.status) && blocker !== "") {
      errors.push(`${tag}: closed as ${item.status} but retains a blocker ("${item.blocker}") — move the reference to evidence or reopen the item`);
    }
  }
  const missing = FINDINGS_MANIFEST.filter((id) => !seen.has(id));
  const extra = [...seen].filter((id) => !FINDINGS_MANIFEST.includes(id));
  for (const id of missing) errors.push(`ledger is missing canonical finding ${id}`);
  for (const id of extra) errors.push(`ledger has non-canonical id ${id}`);

  if (final || release) {
    for (const item of ledger.items) {
      if (!FINAL_CLOSED_STATUSES.includes(item?.status)) {
        errors.push(`final blocked: ${item?.id} (${item?.severity}) is ${item?.status}`);
      }
    }
    errors.push(...validateEvidenceRefs(ledger, checkers));
    errors.push(...validateDocsConsistency(ledger, checkers));
    errors.push(...validateHeadBinding(ledger, checkers));
  }
  if (release && ledger.releaseStatus !== "READY") {
    errors.push(`releaseStatus is ${JSON.stringify(ledger.releaseStatus)} (must be READY to release)`);
  }
  return errors;
}

const PATH_REF = /[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+\.(?:tsx|jsx|mts|cts|ts|js|mjs|cjs|sql|md|json|kt|java|xml|yml|css)(?![A-Za-z0-9_.-])/g;
const BARE_PATH_REF = /(?:^|[\s("'])((?:apps|packages|services|supabase|scripts|tools|docs)\/[A-Za-z0-9_./-]*|[A-Za-z0-9_.-]+\.(?:md|json|mjs|cjs|ts|tsx))(?=[\s)"',;.:]|$)/g;
const RUN_REF = /(?:CI run|dispatch|workflow run|run id|run)\s+#?\d{5,}/i;
const MANUAL_REF = /manual:([A-Za-z0-9_/-]+)/g;
const HEX_REF = /(?<![0-9a-z])[0-9a-f]{7,40}(?![0-9a-z])/g;

/**
 * Every evidence string must cite ≥1 verifiable reference (existing repo
 * path, existing commit, CI run id, or manual:<runbook> with a matching
 * docs/runbooks/ file), and no cited repo path may dangle.
 */
export function validateEvidenceRefs(ledger, { exists = existsSync, commitExists, root = REPO_ROOT } = {}) {
  const errors = [];
  const commitExistsFn = commitExists ?? ((sha) => {
    try {
      execFileSync("git", ["cat-file", "-e", sha], { cwd: root, stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  });
  for (const item of ledger?.items ?? []) {
    const evidence = typeof item?.evidence === "string" ? item.evidence : "";
    const tag = item?.id ?? "<missing id>";
    if (evidence.trim() === "") {
      errors.push(`${tag}: evidence is empty`);
      continue;
    }
    const paths = new Set([
      ...[...evidence.matchAll(PATH_REF)].map((m) => m[0]),
      ...[...evidence.matchAll(BARE_PATH_REF)].map((m) => m[1]),
    ]);
    let cited = 0;
    for (const p of paths) {
      const clean = p.replace(/[),;:'".]+$/, "");
      if (exists(resolve(root, clean))) {
        cited += 1;
      } else {
        errors.push(`${tag}: evidence cites missing path ${clean}`);
      }
    }
    const shas = [...evidence.matchAll(HEX_REF)]
      .map((m) => m[0])
      .filter((s) => !(s.length >= 10 && /^[0-9]+$/.test(s)));
    for (const sha of new Set(shas)) {
      if (commitExistsFn(sha)) {
        cited += 1;
      } else {
        errors.push(`${tag}: evidence cites unknown commit ${sha}`);
      }
    }
    if (RUN_REF.test(evidence)) cited += 1;
    for (const m of evidence.matchAll(MANUAL_REF)) {
      const id = m[1];
      let matched = false;
      try {
        matched = readdirSync(resolve(root, "docs/runbooks")).some((name) => name.startsWith(id));
      } catch {
        matched = false;
      }
      if (matched) {
        cited += 1;
      } else {
        errors.push(`${tag}: evidence cites manual:${id} with no matching docs/runbooks/ file`);
      }
    }
    if (cited === 0) errors.push(`${tag}: evidence cites no verifiable reference (repo path, commit, run id, or manual:<runbook>)`);
  }
  return errors;
}

/** Parse `| FBA-NNN | ... | STATE ... |` rows from the audit register. */
export function parseAuditStates(registerText) {
  const states = new Map();
  for (const line of String(registerText ?? "").split("\n")) {
    const id = line.match(/\|\s*(FBA-\d{3})\s*\|/);
    if (!id) continue;
    const cells = line.split("|").map((c) => c.trim()).filter((c) => c !== "");
    if (cells.length >= 3) states.set(id[1], cells[2]);
  }
  return states;
}

/**
 * The register must name every ledger id with an agreeing state cell, and
 * current docs must not predict the ledger as upcoming or present a stale
 * active baseline SHA.
 */
export function validateDocsConsistency(ledger, { read = (p) => readFileSync(resolve(REPO_ROOT, p), "utf8") } = {}) {
  const errors = [];
  let register;
  try {
    register = read("docs/COMPLETION_AUDIT.md");
  } catch {
    return ["docs/COMPLETION_AUDIT.md is missing (register must track every finding)"];
  }
  const states = parseAuditStates(register);
  for (const item of ledger?.items ?? []) {
    const state = states.get(item?.id);
    if (!state) {
      errors.push(`${item?.id}: audit register names no state for this finding`);
      continue;
    }
    const closed = FINAL_CLOSED_STATUSES.includes(item?.status);
    if (closed && /\b(IN_PROGRESS|OPEN|BLOCKED)\b/.test(state) && !/\bWAIVED\b/.test(state)) {
      errors.push(`${item?.id}: ledger says ${item?.status} but the register still says "${state}"`);
    }
    if (!closed && /(^|[^_])DONE([^_]|$)/.test(state)) {
      errors.push(`${item?.id}: ledger says ${item?.status} but the register claims DONE`);
    }
  }
  for (const doc of CURRENT_DOCS) {
    let text;
    try {
      text = read(doc);
    } catch {
      errors.push(`${doc} is missing`);
      continue;
    }
    for (const stale of STALE_LEDGER_PREDICTIONS) {
      if (text.includes(stale)) errors.push(`${doc} still predicts the ledger as upcoming ("${stale}")`);
    }
  }
  errors.push(...validateActiveBaseline(ledger, { read }));
  return errors;
}

/** Current docs must cite the reconciled baseline, not a stale active SHA. */
export function validateActiveBaseline(ledger, { read = (p) => readFileSync(resolve(REPO_ROOT, p), "utf8") } = {}) {
  const errors = [];
  const generated = typeof ledger?.generatedFor === "string" ? ledger.generatedFor : "";
  const short = generated.slice(0, 7);
  for (const doc of CURRENT_DOCS) {
    let text;
    try {
      text = read(doc);
    } catch {
      continue;
    }
    text.split("\n").forEach((line, index) => {
      if (!/[0-9a-f]{7,40}/.test(line)) return;
      if (short && (line.includes(generated) || line.includes(short))) return;
      if (/histor|archive|previous|superseded|as-of|preserved|e813028|was (read|recorded|reported|at)|before\b/i.test(line)) return;
      const sha = line.match(/[0-9a-f]{7,40}/)?.[0] ?? "";
      // Pure-digit timestamps (migrations) and versions are not baseline SHAs.
      if (/^[0-9]+$/.test(sha) || /^\d+\.\d+\.\d+/.test(sha) || sha.length < 7) return;
      if (/[0-9a-f]{7,40}/.test(line) && /baseline|baseline:|audit baseline|at b[0-9a-f]{6}|@ [0-9a-f]{7}|exact/i.test(line)) {
        errors.push(`${doc}:${index + 1}: presents a stale active baseline ("${line.trim().slice(0, 90)}")`);
      }
    });
  }
  return errors;
}

/** The ledger must be reconciled last: clean tree, nothing but the ledger changed since generatedFor. */
export function validateHeadBinding(ledger, { git = defaultGit } = {}) {
  const errors = [];
  const generated = typeof ledger?.generatedFor === "string" ? ledger.generatedFor : "";
  if (!/^[0-9a-f]{40}$/.test(generated)) {
    return [`ledger.generatedFor must be a full commit SHA (got ${JSON.stringify(ledger?.generatedFor)})`];
  }
  let head;
  try {
    head = git("rev-parse", ["HEAD"]).trim();
  } catch {
    return ["cannot resolve git HEAD for ledger binding"];
  }
  let clean = "";
  try {
    clean = git("status", ["--porcelain"]).trim();
  } catch {
    return ["cannot check tree cleanliness for ledger binding"];
  }
  if (clean !== "") errors.push("working tree is dirty — reconcile and commit before final closure");
  if (head !== generated) {
    let changed;
    try {
      changed = git("diff", ["--name-only", generated, "HEAD"]).trim().split("\n").filter(Boolean);
    } catch {
      return [...errors, `ledger.generatedFor ${generated} is not reachable from HEAD`];
    }
    const beyondLedger = changed.filter((f) => f !== "completion-ledger.json");
    if (beyondLedger.length > 0) {
      errors.push(`ledger was reconciled at ${generated.slice(0, 7)} but ${beyondLedger.length} non-ledger file(s) changed since: ${beyondLedger.slice(0, 5).join(", ")}${beyondLedger.length > 5 ? "…" : ""}`);
    }
  }
  return errors;
}

function defaultGit(cmd, args) {
  return execFileSync("git", [cmd, ...args], { cwd: REPO_ROOT, encoding: "utf8" });
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

/** Find unresolved todo/skip markers not allowlisted as device-only. */
export function findUnallowlistedSkips(files, { allowlist = SKIP_ALLOWLIST } = {}) {
  const errors = [];
  for (const [relPath, contents] of Object.entries(files)) {
    const normalized = relPath.split(sep).join("/");
    contents.split("\n").forEach((line, index) => {
      if (!SKIP_MARKER.test(line)) return;
      const allowed = allowlist.some((entry) => entry.file === normalized && line.includes(entry.contains));
      if (!allowed) errors.push(`${normalized}:${index + 1}: unallowlisted todo/skip — automate it or allowlist as device-only with an owner`);
    });
  }
  return errors;
}

function walk(dir, files, { testFiles = false } = {}) {
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
      walk(full, files, { testFiles });
    } else if (SCAN_EXTENSIONS.includes(name.slice(name.lastIndexOf(".")))) {
      const isTest = /(?:\.test\.|\.spec\.|__tests__|__mocks__)|(?:^|\/)(?:testing|fixtures|__fixtures__)\//.test(full);
      if (isTest !== testFiles) continue;
      if (!testFiles && SKIP_FILE.test(full)) continue;
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

export function collectTestSources(root = REPO_ROOT) {
  const files = {};
  const dirs = ["apps/mobile/src", "apps/api/src", "services", "packages/shared/src"];
  for (const dir of dirs) walk(resolve(root, dir), files, { testFiles: true });
  return files;
}

export function checkCompletionGate(
  { final = false, release = false, ledger = loadLedger(), files = collectShippedSources(), testFiles = collectTestSources() } = {},
  checkers = {},
) {
  const wantFinal = final || release;
  const errors = [
    ...validateLedger(ledger, { final: wantFinal, release }, checkers),
    ...findUnallowlistedDebt(files),
  ];
  if (wantFinal) errors.push(...findUnallowlistedSkips(testFiles));
  return { passed: errors.length === 0, errors };
}

function printHelp() {
  console.log(`completion-gate: fail-closed completion/release gate

usage:
  node scripts/completion-gate.mjs [--final] [--release] [--json] [--help]

modes:
  default    ledger integrity (manifest, statuses, evidence/blocker presence)
             + no unallowlisted work markers in shipped source (incl. Android)
  --final    every finding closed-or-waived, no blocker on closed items,
             evidence references verified, docs agree with ledger, ledger
             bound to HEAD, todo/skip inventory enforced
  --release  --final plus releaseStatus=READY (refuses to sign on HOLD)

release flow: reconcile completion-ledger.json LAST so the final commit
touches only the ledger, then tag immediately. Any later code commit
invalidates --final until the ledger is reconciled again.

exit codes: 0 pass, 1 gate failure, 2 usage error`);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }
  const known = new Set(["--final", "--release", "--json"]);
  const unknown = args.filter((arg) => arg.startsWith("--") && !known.has(arg));
  if (unknown.length > 0) {
    console.error(`completion-gate: unknown flag(s): ${unknown.join(", ")}`);
    process.exit(2);
  }
  const release = args.includes("--release");
  const final = args.includes("--final") || release;
  const { passed, errors } = checkCompletionGate({ final, release });
  const mode = release ? "release" : final ? "final" : "integrity";
  if (args.includes("--json")) {
    console.log(JSON.stringify({ passed, mode, errors }, null, 2));
  } else {
    for (const error of errors) console.error(`completion-gate: FAIL ${error}`);
    console.log(
      passed
        ? `completion-gate: PASS (${mode} mode)`
        : `completion-gate: FAIL (${mode} mode, ${errors.length} error(s))`,
    );
  }
  process.exit(passed ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
