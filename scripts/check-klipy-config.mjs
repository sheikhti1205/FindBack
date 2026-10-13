#!/usr/bin/env node
/**
 * check-klipy-config — KLIPY cross-environment parity probe (X7).
 *
 * `apps/mobile/src/services/klipy.ts` enables the GIF/sticker adapter iff
 * `VITE_KLIPY_API_KEY` is non-empty (blank => picker hidden, graceful, no
 * error surface). This checker is the build-lane eye for that one seam: it
 * reports ENABLED/DISABLED for the env NAME and nothing else.
 *
 * Secrecy contract (hard rule, covered by tests):
 *   - Output contains the env NAME and the words ENABLED/DISABLED only.
 *   - Never prints the value, a substring, a length, a count, a hash, or any
 *     shape derived from the value.
 *   - A value counts as ENABLED only when it is a non-empty string after trim.
 *
 * Exit codes: 0 ENABLED, or DISABLED without `--require`; 1 DISABLED with
 * `--require`; 2 usage error.
 *
 * Usage:
 *   node scripts/check-klipy-config.mjs [--require]
 *
 * Pure injectable API (exported for node --test, hermetic):
 *   KLIPY_ENV_KEY, klipyStatus(env), klipyExitCode(status, {require}),
 *   formatKlipyReport(status, {require})
 * Importing this module has no side effects; the CLI runs on direct execution.
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The single build-config env name that enables the adapter. */
export const KLIPY_ENV_KEY = "VITE_KLIPY_API_KEY";

/**
 * Status for an injected env object. Non-empty (after trim) => ENABLED.
 * Never inspects or reports the value beyond emptiness.
 */
export function klipyStatus(env = {}) {
  const source = env ?? {};
  const raw = source[KLIPY_ENV_KEY];
  const enabled = typeof raw === "string" && raw.trim().length > 0;
  return enabled ? "ENABLED" : "DISABLED";
}

/**
 * Exit code for a status. DISABLED fails only when the caller opts in with
 * `require` (i.e. a lane that MUST have the key baked).
 */
export function klipyExitCode(status, { require: requireEnabled = false } = {}) {
  if (status === "ENABLED") return 0;
  return requireEnabled ? 1 : 0;
}

/** Names/status-only line. Contains no value, length, or derived shape. */
export function formatKlipyReport(status, { require: requireEnabled = false } = {}) {
  if (status === "ENABLED") {
    return `check-klipy-config: ${KLIPY_ENV_KEY} ENABLED`;
  }
  if (requireEnabled) {
    return `check-klipy-config: FAIL: ${KLIPY_ENV_KEY} DISABLED (--require; set the repo secret to bake the picker)`;
  }
  return `check-klipy-config: ${KLIPY_ENV_KEY} DISABLED (picker hidden; acceptable)`;
}

function isMainModule() {
  const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
  return invoked === fileURLToPath(import.meta.url);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`check-klipy-config: KLIPY adapter presence probe (names only)

usage:
  node scripts/check-klipy-config.mjs [--require]

  --require   exit 1 when ${KLIPY_ENV_KEY} is DISABLED

exit codes: 0 ENABLED (or DISABLED without --require), 1 DISABLED with --require, 2 usage error`);
    process.exit(0);
  }
  const unknown = args.filter((arg) => arg !== "--require");
  if (unknown.length > 0) {
    console.error(`check-klipy-config: unknown argument(s): ${unknown.join(", ")} (read-only probe)`);
    process.exit(2);
  }
  const requireEnabled = args.includes("--require");
  const status = klipyStatus(process.env);
  console.log(formatKlipyReport(status, { require: requireEnabled }));
  process.exit(klipyExitCode(status, { require: requireEnabled }));
}

if (isMainModule()) {
  main();
}
