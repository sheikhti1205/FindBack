#!/usr/bin/env node
/**
 * check-push-config: read-only push-secrets probe (SYNC-13/14/15, SYNC0-D11).
 *
 * Reports PRESENT/ABSENT for the four push-dispatch environment names by
 * reading (never writing, never transmitting) the process environment:
 *   FIREBASE_SERVICE_ACCOUNT_JSON, FCM_PROJECT_ID, PUBLIC_SHARE_ORIGIN,
 *   PUSH_DISPATCH_SECRET
 *
 * Additionally cross-checks that the server `FCM_PROJECT_ID` equals the
 * canonical Firebase *client* project (`FINDBACK_FIREBASE_PROJECT_ID`, the id
 * the Android google-services.json is materialized for). A client/server
 * project mismatch fails preflight (exit 1) because it makes every push
 * silently undeliverable.
 *
 * Secrecy contract (hard rule, covered by tests):
 *   - Output contains variable NAMES and the words PRESENT/ABSENT only.
 *   - Never prints values, substrings of values, value lengths, char counts,
 *     hashes, or any shape derived from a value.
 *   - A value counts as PRESENT only when it is a non-empty string after
 *     trim; anything else is ABSENT.
 *
 * Exit codes: 0 all PRESENT, 1 any ABSENT, 2 usage error.
 *
 * Usage:
 *   node scripts/check-push-config.mjs
 *
 * Pure injectable API (exported for node --test, hermetic):
 *   PUSH_ENV_KEYS, checkPushConfig(env), missingNames(results),
 *   formatPushReport(results), pushConfigExitCode(results)
 * Importing this module has no side effects; the CLI runs on direct execution.
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FINDBACK_FIREBASE_PROJECT_ID } from "./firebase-project-id.mjs";

export const PUSH_ENV_KEYS = [
  "FIREBASE_SERVICE_ACCOUNT_JSON",
  "FCM_PROJECT_ID",
  "PUBLIC_SHARE_ORIGIN",
  "PUSH_DISPATCH_SECRET",
];

/**
 * Probe an injected env object (defaults to process.env at the call site).
 * Returns [{ name, status: "PRESENT" | "ABSENT" }]. Never echoes values.
 */
export function checkPushConfig(env = process.env) {
  const source = env ?? {};
  return PUSH_ENV_KEYS.map((name) => {
    const raw = source[name];
    const present = typeof raw === "string" && raw.trim().length > 0;
    return { name, status: present ? "PRESENT" : "ABSENT" };
  });
}

/** Names (only) of ABSENT entries. */
export function missingNames(results) {
  return results.filter((row) => row.status !== "PRESENT").map((row) => row.name);
}

/** 0 when all PRESENT, else 1. */
export function pushConfigExitCode(results) {
  return missingNames(results).length === 0 ? 0 : 1;
}

/**
 * Cross-check the server `FCM_PROJECT_ID` against the canonical Firebase
 * *client* project (`FINDBACK_FIREBASE_PROJECT_ID`). The Android client built
 * from `materialize-google-services.mjs` mints FCM tokens for that project; if
 * the server service account targets a different project, every push silently
 * fails. Names/status only — the project id is compared, never echoed beyond
 * the canonical constant.
 *
 * Returns { status: "ALIGNED" | "MISMATCH" | "ABSENT" }.
 */
export function checkProjectAlignment(env = process.env, expected = FINDBACK_FIREBASE_PROJECT_ID) {
  const raw = env?.["FCM_PROJECT_ID"];
  const present = typeof raw === "string" && raw.trim().length > 0;
  if (!present) return { status: "ABSENT" };
  return { status: raw.trim() === expected ? "ALIGNED" : "MISMATCH" };
}

/** 0 when the server project is present and matches the client project, else 1. */
export function alignmentExitCode(alignment) {
  return alignment?.status === "ALIGNED" ? 0 : 1;
}

/** Names/status-only alignment line (no secret values). */
export function formatAlignment(alignment) {
  if (alignment.status === "ALIGNED") {
    return `check-push-config: FCM_PROJECT_ID ALIGNED with client project`;
  }
  if (alignment.status === "ABSENT") {
    return `check-push-config: FCM_PROJECT_ID ABSENT (cannot verify client/server project match)`;
  }
  return `check-push-config: FCM_PROJECT_ID MISMATCH — server project != client Firebase project`;
}

/**
 * Names-only table. Contains no values, no lengths, no hashes — only the
 * key names and PRESENT/ABSENT tokens.
 */
export function formatPushReport(results) {
  const lines = ["check-push-config: push secret presence (name | status)"];
  for (const row of results) {
    lines.push(`  ${row.name} | ${row.status}`);
  }
  const missing = missingNames(results);
  if (missing.length === 0) {
    lines.push(`check-push-config: PASS (${results.length}/${results.length} present)`);
  } else {
    lines.push(`check-push-config: FAIL (missing: ${missing.join(", ")})`);
  }
  return lines.join("\n");
}

function isMainModule() {
  const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
  return invoked === fileURLToPath(import.meta.url);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`check-push-config: read-only push-secrets presence probe

usage:
  node scripts/check-push-config.mjs

exit codes: 0 all PRESENT, 1 any ABSENT, 2 usage error`);
    process.exit(0);
  }
  if (args.length > 0) {
    console.error("check-push-config: this probe takes no flags (read-only)");
    process.exit(2);
  }
  const results = checkPushConfig(process.env);
  const alignment = checkProjectAlignment(process.env);
  console.log(formatPushReport(results));
  console.log(formatAlignment(alignment));
  const exit = Math.max(pushConfigExitCode(results), alignmentExitCode(alignment));
  process.exit(exit);
}

if (isMainModule()) {
  main();
}
