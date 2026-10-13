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

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
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

/**
 * X7 post-build proof: does the emitted JavaScript actually carry the key?
 * Pure over injected chunks. Reads the value ONLY to compare; the boolean is
 * the only thing reported (never the value, its length, or a hash).
 */
export function klipyBundleCarriesKey(chunks, key) {
  if (typeof key !== "string" || key.trim().length === 0) return false;
  return chunks.some((chunk) => typeof chunk === "string" && chunk.includes(key));
}

function readAssetChunks(dir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".js"))
    .map((name) => readFileSync(join(dir, name), "utf8"));
}

function readApkChunks(path) {
  const listing = spawnSync("unzip", ["-Z", "-1", path], { encoding: "utf8" });
  if (listing.status !== 0) throw new Error("cannot inspect APK (unzip -Z -1 failed)");
  const files = listing.stdout
    .split("\n")
    .filter((name) => /^assets\/public\/assets\/[^/]+\.js$/.test(name));
  return files.map((name) => {
    const file = spawnSync("unzip", ["-p", path, name], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (file.status !== 0) throw new Error("cannot inspect packaged JavaScript");
    return file.stdout;
  });
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`check-klipy-config: KLIPY adapter presence probe (names only)

usage:
  node scripts/check-klipy-config.mjs [--require] [--assets PATH | --apk PATH]

  --require         exit 1 when ${KLIPY_ENV_KEY} is DISABLED
  --assets PATH     assert the emitted JS in a dist directory carries the key
  --apk PATH        assert the JS packaged inside an APK carries the key

exit codes: 0 ENABLED (or DISABLED without --require), 1 required-missing or
bundle-missing, 2 usage error`);
    process.exit(0);
  }

  const valueFlags = new Map();
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--assets" || arg === "--apk") {
      valueFlags.set(arg, args[i + 1]);
      i += 1;
    } else if (arg === "--require") {
      valueFlags.set(arg, true);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length > 0) {
    console.error(`check-klipy-config: unknown argument(s): ${positional.join(", ")} (read-only probe)`);
    process.exit(2);
  }
  const assetsPath = valueFlags.get("--assets");
  const apkPath = valueFlags.get("--apk");
  if (assetsPath && apkPath) {
    console.error("check-klipy-config: choose --assets OR --apk, not both");
    process.exit(2);
  }
  if ((valueFlags.has("--assets") && !assetsPath) || (valueFlags.has("--apk") && !apkPath)) {
    console.error("check-klipy-config: --assets/--apk require a path");
    process.exit(2);
  }

  const requireEnabled = valueFlags.get("--require") === true;
  const status = klipyStatus(process.env);
  console.log(formatKlipyReport(status, { require: requireEnabled }));

  if (!assetsPath && !apkPath) {
    process.exit(klipyExitCode(status, { require: requireEnabled }));
  }

  if (status === "DISABLED") {
    // Nothing to look for; the adapter is intentionally inert.
    process.exit(klipyExitCode(status, { require: requireEnabled }));
  }

  try {
    const chunks = assetsPath ? readAssetChunks(assetsPath) : readApkChunks(apkPath);
    const where = assetsPath ? "assets" : "APK";
    if (!klipyBundleCarriesKey(chunks, process.env[KLIPY_ENV_KEY] ?? "")) {
      console.error(`check-klipy-config: FAIL: ${KLIPY_ENV_KEY} missing from ${where}`);
      process.exit(1);
    }
    console.log(`check-klipy-config: PASS: ${KLIPY_ENV_KEY} present in ${where}`);
    process.exit(0);
  } catch {
    console.error("check-klipy-config: cannot read build assets");
    process.exit(1);
  }
}

if (isMainModule()) {
  main();
}
