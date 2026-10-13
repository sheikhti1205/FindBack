#!/usr/bin/env node
// FINDBACK CROSS-ENVIRONMENT CLOSURE — the runtime/deployment readiness matrix.
//
// This is the ENVIRONMENT + RUNTIME CLOSURE lane's source of truth (NOT the
// capability matrix in cross-environment-matrix.mjs, which answers a different
// question: "does the product feature exist on this lane"). Here we answer
// "is this lane actually closed yet", using ONLY the owner verdict vocabulary.
//
// Hard rules enforced mechanically (fail closed):
//   - the row set is EXACTLY the 18 owner rows (no extras, no omissions);
//   - every verdict is one of the allowed set;
//   - PASS requires a committed evidence artifact that exists, is non-empty,
//     and records a `baselineSha` reachable from HEAD (anti-staleness);
//   - FAIL / FAIL_EXTERNAL require a `blocker`;
//   - DEFERRED_* require an `ownerAction`;
//   - READY_FOR_RUNTIME_PROOF requires a `proofCommand`.
//
// Nothing is ever PASS merely because the slug exists. No secrets are read.
//
// CLI:
//   node scripts/cross-environment-closure.mjs            # check + summary
//   node scripts/cross-environment-closure.mjs --markdown # render the table
//   node scripts/cross-environment-closure.mjs --json     # machine shape
//   node scripts/cross-environment-closure.mjs --scaffold # evidence templates
//
// Pure API (node --test, hermetic): VERDICTS, ROWS, CLOSURE, checkClosure,
// renderClosureMarkdown, closureToJson, scaffoldEvidence.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

export const VERDICTS = [
  "PASS",
  "READY_FOR_RUNTIME_PROOF",
  "DEFERRED_OWNER_CONFIG",
  "DEFERRED_OWNER",
  "DEFERRED_PHYSICAL_DEVICE",
  "FAIL_EXTERNAL",
  "FAIL",
];

/** The 18 owner rows, in owner order. */
export const ROWS = [
  "REPO_IMPLEMENTATION",
  "LIVE_DATABASE",
  "EDGE_FUNCTIONS",
  "SENTRY_LOCAL",
  "SENTRY_CI",
  "SENTRY_RELEASE",
  "SENTRY_WEB",
  "SENTRY_DOCKER",
  "GOOGLE_BUILD_CONFIG",
  "GOOGLE_RUNTIME",
  "FCM_CLIENT",
  "FCM_SERVER",
  "KLIPY",
  "MAPLIBRE",
  "REMOTE_CI",
  "EMULATOR",
  "PHYSICAL_DEVICE",
  "RELEASE",
];

/**
 * The declared closure. `baselineSha` is the product HEAD this matrix was
 * computed against; it must be reachable from HEAD so the doc can never be a
 * forward-stale claim. `evidence` on a PASS row is a repo-relative path to a
 * committed artifact (shape checked below).
 */
export const CLOSURE = {
  baselineSha: "0154a9b9dcc68319c3219d9bcce824c0e4fbfd61",
  baselineNote:
    "Re-baselined off 790f456 to the owner-observed HEAD 0154a9b (web Google OAuth + callback bridge, capability validators, Sentry cross-lane proof, KLIPY wiring/UI, cleanup scheduler, recovery/touch fixes).",
  rows: {
    REPO_IMPLEMENTATION: {
      verdict: "PASS",
      evidence: "docs/evidence/repo-implementation.json",
      detail:
        "Source, scripts and tests for the X-wave are complete; local gates green (see evidence).",
    },
    LIVE_DATABASE: {
      verdict: "PASS",
      evidence: "docs/evidence/live-database.json",
      detail:
        "Applied the 3 pending migrations in order; live head 20261013020000 == BACKEND_SCHEMA_VERSION; 19/19 verify probes pass (see evidence).",
    },
    EDGE_FUNCTIONS: {
      verdict: "PASS",
      evidence: "docs/evidence/edge-functions.json",
      detail:
        "Deployed ai-help v9 / push-dispatch v6 (REACTION) / cleanup-comment-media v1; reply-comment v3 already CURRENT; byte-identical parity + live auth guards proven (see evidence).",
    },
    SENTRY_LOCAL: {
      verdict: "READY_FOR_RUNTIME_PROOF",
      proofCommand:
        "FINDBACK_SENTRY_UPLOAD=true node scripts/build-apk.mjs --variant=signeddev",
      detail: "Wiring + parity gates complete; needs a real DSN/token and one symbolicated event.",
    },
    SENTRY_CI: {
      verdict: "READY_FOR_RUNTIME_PROOF",
      proofCommand: "node scripts/sentry-cross-lane-proof.mjs --asset <dist-dir>",
      detail: "Upload step is wired in the workflows; needs SENTRY_AUTH_TOKEN/ORG/PROJECT.",
    },
    SENTRY_RELEASE: {
      verdict: "READY_FOR_RUNTIME_PROOF",
      proofCommand: "node scripts/check-sentry-release-parity.mjs",
      detail: "One release/dist contract proven mechanically; release artifacts not yet produced.",
    },
    SENTRY_WEB: {
      verdict: "READY_FOR_RUNTIME_PROOF",
      proofCommand: "node scripts/sentry-cross-lane-proof.mjs --asset apps/mobile/dist",
      detail: "Web lane carries the same contract; needs DSN + upload + event.",
    },
    SENTRY_DOCKER: {
      verdict: "READY_FOR_RUNTIME_PROOF",
      proofCommand: "node scripts/sentry-cross-lane-proof.mjs",
      detail: "Docker reference lane carries the same contract; needs DSN + event.",
    },
    GOOGLE_BUILD_CONFIG: {
      verdict: "PASS",
      evidence: "docs/evidence/google-build-config.json",
      detail:
        "Static config parity: package com.findback.app, callback paths, web bridge, provider expectations, audience format (see evidence).",
    },
    GOOGLE_RUNTIME: {
      verdict: "READY_FOR_RUNTIME_PROOF",
      proofCommand: "adb -s <device> logcat | grep -i 'GoogleAuth|CredentialManager'",
      detail:
        "Needs canonical-release-key signed device proof: Credential Manager → ID token → signInWithIdToken → profile state. Never Firebase Auth.",
    },
    FCM_CLIENT: {
      verdict: "READY_FOR_RUNTIME_PROOF",
      proofCommand: "node scripts/check-push-config.mjs",
      detail: "Android client push wiring present; needs materialized google-services + a device.",
    },
    FCM_SERVER: {
      verdict: "READY_FOR_RUNTIME_PROOF",
      proofCommand:
        "curl -X POST <fn-url>/push-dispatch -H 'x-findback-dispatch-secret: $PUSH_DISPATCH_SECRET' -d '{\"type\":\"REACTION\",\"reaction_kind\":\"LOVE\",...}'",
      detail:
        "Live secrets present (SERVICE_ACCOUNT_JSON/PROJECT_ID/PUSH_DISPATCH_SECRET/PUBLIC_SHARE_ORIGIN) and push-dispatch v6 deployed + 401-guarded. Needs a real device token for end-to-end delivery across REACTION kinds/COMMENT/MENTION/STATUS/reply.",
    },
    KLIPY: {
      verdict: "READY_FOR_RUNTIME_PROOF",
      proofCommand: "node scripts/check-klipy-config.mjs --assets <dist-dir>",
      detail:
        "Implementation + bundle-presence gate complete; needs the key set in the lane and a live trending/search/select/reload run.",
    },
    MAPLIBRE: {
      verdict: "READY_FOR_RUNTIME_PROOF",
      proofCommand: "node scripts/check-map-provider.mjs",
      detail:
        "MapLibre Native keyless final (no Google Maps key required); needs emulator/device MAP-11 proof.",
    },
    REMOTE_CI: {
      verdict: "FAIL_EXTERNAL",
      blocker:
        "Exact-HEAD workflow runs complete/failure in ~3s (Actions billing signature) — no commit statuses returned. Workflows are NOT weakened.",
      ownerAction: "Restore Actions billing, then rerun the exact-final-SHA matrix.",
    },
    EMULATOR: {
      verdict: "DEFERRED_OWNER",
      ownerAction:
        "Run the Norfold_API36 emulator MAP-11 / Google / KLIPY / push harness (no Android SDK/emulator in the agent env).",
      blocker: "No Android SDK / Gradle / adb / emulator available to the agent.",
    },
    PHYSICAL_DEVICE: {
      verdict: "DEFERRED_PHYSICAL_DEVICE",
      ownerAction:
        "Install the canonical signeddev APK on the physical phone and capture device evidence.",
      blocker: "Physical-device acceptance is owner-only evidence.",
    },
    RELEASE: {
      verdict: "DEFERRED_OWNER",
      ownerAction:
        "No release this wave. Gate on every row above closing; then version + tag + publish.",
      blocker: "Release is forbidden until runtime/deployment lanes close.",
    },
  },
};

/** Evidence artifact parse: must be non-empty JSON with a 40-hex baselineSha. */
function checkEvidenceShape(path, { exists, read, isAncestor }) {
  if (!exists(path)) return `evidence missing: ${path}`;
  let raw;
  try {
    raw = read(path);
  } catch {
    return `evidence unreadable: ${path}`;
  }
  if (!raw || raw.trim().length === 0) return `evidence empty: ${path}`;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return `evidence not JSON: ${path}`;
  }
  const sha = parsed?.baselineSha;
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) {
    return `evidence ${path} must record a 40-hex baselineSha`;
  }
  if (!isAncestor(sha)) return `evidence ${path} baselineSha ${sha.slice(0, 7)} is not reachable from HEAD`;
  return null;
}

/**
 * Validate a closure. Injectable fs/git seams keep it hermetic for tests.
 * Returns { problems, verdictCounts, passRows, nonPassRows }.
 */
export function checkClosure(closure = CLOSURE, seams = {}) {
  const exists = seams.exists ?? ((p) => existsSync(resolve(REPO_ROOT, p)));
  const read = seams.read ?? ((p) => readFileSync(resolve(REPO_ROOT, p), "utf8"));
  const isAncestor = seams.isAncestor ?? (() => true);

  const problems = [];
  const declared = Object.keys(closure?.rows ?? {});
  const missing = ROWS.filter((r) => !declared.includes(r));
  const extra = declared.filter((r) => !ROWS.includes(r));
  if (missing.length) problems.push(`missing rows: ${missing.join(", ")}`);
  if (extra.length) problems.push(`unknown rows: ${extra.join(", ")}`);

  const verdictCounts = Object.fromEntries(VERDICTS.map((v) => [v, 0]));
  const passRows = [];
  const nonPassRows = [];
  for (const row of ROWS) {
    const entry = closure?.rows?.[row];
    if (!entry) continue;
    const { verdict } = entry;
    if (!VERDICTS.includes(verdict)) {
      problems.push(`row ${row} has unknown verdict: ${String(verdict)}`);
      continue;
    }
    verdictCounts[verdict] += 1;
    (verdict === "PASS" ? passRows : nonPassRows).push(row);

    if (verdict === "PASS") {
      if (!entry.evidence) problems.push(`row ${row} is PASS without an evidence path`);
      else {
        const bad = checkEvidenceShape(entry.evidence, { exists, read, isAncestor });
        if (bad) problems.push(`row ${row}: ${bad}`);
      }
    }
    if (verdict === "FAIL" || verdict === "FAIL_EXTERNAL") {
      if (!entry.blocker || entry.blocker.trim().length < 10) {
        problems.push(`row ${row} is ${verdict} without a blocker`);
      }
    }
    if (verdict.startsWith("DEFERRED_")) {
      if (!entry.ownerAction || entry.ownerAction.trim().length < 10) {
        problems.push(`row ${row} is ${verdict} without an ownerAction`);
      }
    }
    if (verdict === "READY_FOR_RUNTIME_PROOF") {
      if (!entry.proofCommand || entry.proofCommand.trim().length < 3) {
        problems.push(`row ${row} is READY_FOR_RUNTIME_PROOF without a proofCommand`);
      }
    }
  }
  if (closure?.baselineSha && !/^[0-9a-f]{40}$/.test(closure.baselineSha)) {
    problems.push(`closure baselineSha must be 40-hex: ${String(closure.baselineSha)}`);
  } else if (closure?.baselineSha && !isAncestor(closure.baselineSha)) {
    problems.push(`closure baselineSha ${closure.baselineSha.slice(0, 7)} is not reachable from HEAD`);
  }
  return { problems, verdictCounts, passRows, nonPassRows };
}

export function renderClosureMarkdown(closure = CLOSURE) {
  const lines = ["| Lane | Verdict | Why / next action |", "|---|---|---|"];
  for (const row of ROWS) {
    const e = closure.rows[row];
    if (!e) {
      lines.push(`| ${row} | UNKNOWN | — |`);
      continue;
    }
    const why =
      e.detail || e.blocker || e.ownerAction || e.proofCommand || "—";
    lines.push(`| ${row} | ${e.verdict} | ${why} |`);
  }
  return lines.join("\n");
}

export function closureToJson(closure = CLOSURE) {
  return JSON.stringify(
    {
      baselineSha: closure.baselineSha,
      baselineNote: closure.baselineNote,
      rows: ROWS.map((id) => ({ id, ...closure.rows[id] })),
    },
    null,
    2,
  );
}

/** The required evidence artifact template for every PASS row. */
export function scaffoldEvidence(closure = CLOSURE) {
  const out = {};
  for (const row of ROWS) {
    const e = closure.rows[row];
    if (e?.verdict !== "PASS") continue;
    out[e.evidence] = {
      row,
      baselineSha: "<40-hex product HEAD>",
      recordedAt: "<ISO-8601>",
      command: "<exact command(s) run>",
      summary: "<what the output proved>",
    };
  }
  return out;
}

function defaultIsAncestor(sha) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", sha, "HEAD"], {
      cwd: REPO_ROOT,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { problems, verdictCounts } = checkClosure(CLOSURE, { isAncestor: defaultIsAncestor });
  if (process.argv.includes("--markdown")) console.log(renderClosureMarkdown());
  else if (process.argv.includes("--json")) console.log(closureToJson());
  else if (process.argv.includes("--scaffold")) console.log(JSON.stringify(scaffoldEvidence(), null, 2));

  if (problems.length > 0) {
    for (const p of problems) console.error(`cross-environment-closure: ${p}`);
    process.exitCode = 1;
  } else if (!process.argv.slice(2).some((a) => ["--markdown", "--json", "--scaffold"].includes(a))) {
    const summary = Object.entries(verdictCounts)
      .filter(([, n]) => n > 0)
      .map(([v, n]) => `${v}=${n}`)
      .join(" ");
    console.log(`cross-environment-closure: OK (${ROWS.length} rows; ${summary})`);
  }
}
