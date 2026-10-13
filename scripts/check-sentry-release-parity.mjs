#!/usr/bin/env node
/**
 * check-sentry-release-parity.mjs — ONE Sentry release/dist contract, proven
 * mechanically (CLOSEOUT-8). Static, read-only, no network: it imports the
 * canonical script modules and regex-scans the lanes that cannot be imported
 * (TypeScript, YAML, Dockerfile), then asserts they all agree on:
 *
 *   1. release mint sameness (build-context vs build-apk produce the IDENTICAL
 *      string for the same inputs — the exact string the SDK embeds and the
 *      upload passes as --release);
 *   2. exactly-12 SHA policy everywhere (no {7,40} remnant);
 *   3. single namespace (no findback-web@ mint outside this file's own docs);
 *   4. closed dist set sameness (build-context set vs build-apk variant map);
 *   5. sentry-cli pin sameness (build-apk pin vs every workflow upload);
 *   6. trace-rate default 0.1 (code default + Dockerfile + compose fallback);
 *   7. upload-token hygiene (no VITE_SENTRY_AUTH_TOKEN in build surfaces).
 *
 * `checkParity(root)` is exported for tests (inject a fixture root for red
 * cases). CLI: exit 0 all-CURRENT + PASS line, exit 1 any mismatch with
 * file:line evidence (shapes only — never secret values). Run from root:
 *   node scripts/check-sentry-release-parity.mjs
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SENTRY_DEFAULT_TRACES_SAMPLE_RATE,
  SENTRY_DIST_VALUES,
  SENTRY_RELEASE_MOBILE_NAMESPACE,
  sentryRelease,
} from "./build-context.mjs";
import {
  DIST_FOR_VARIANT,
  SENTRY_CLI_PIN,
  SENTRY_RELEASE_RE,
  buildSentryRelease,
} from "./build-apk.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

function walkTs(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walkTs(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) out.push(full);
  }
  return out;
}

/** Pure audit over a repo root. Returns failure strings (file:line + cause). */
export function checkParity(root = REPO_ROOT) {
  const failures = [];
  const fail = (where, what) => failures.push(`${where}: ${what}`);
  const read = (rel) => readFileSync(join(root, rel), "utf8");

  // 1. Mint sameness.
  {
    const version = "1.0.0";
    const short12 = "790f45698fb4";
    const a = sentryRelease({ version, short12 });
    const b = buildSentryRelease(version, short12);
    if (a !== b) fail("scripts/build-context.mjs:115+scripts/build-apk.mjs:134", "mint sameness (canonical vs local minter differ)");
    if (!SENTRY_RELEASE_RE.test(a)) fail("scripts/build-apk.mjs:96", "minted canonical release fails SENTRY_RELEASE_RE");
    if (!a.startsWith(`${SENTRY_RELEASE_MOBILE_NAMESPACE}@`)) fail("scripts/build-context.mjs:36", "minted release uses unexpected namespace");
  }

  // 2. Exactly-12 policy.
  {
    if (!SENTRY_RELEASE_RE.source.includes("{12}")) fail("scripts/build-apk.mjs:96", "SENTRY_RELEASE_RE is not exactly-12");
    const releaseTs = read("apps/mobile/src/services/monitoring/release.ts");
    const shaRe = /const SHA_RE = \/(.+)\/[a-z]*;/i.exec(releaseTs)?.[1] ?? "";
    if (!shaRe.includes("{12}")) fail("apps/mobile/src/services/monitoring/release.ts:32", "SHA_RE is not exactly-12");
    for (const wf of ["release.yml", "ci.yml", "web.yml"]) {
      const text = read(`.github/workflows/${wf}`);
      const checks = [...text.matchAll(/\+\[0-9a-f\]\{(\d+(?:,\d+)?)\}/g)].map((m) => m[1]);
      if (checks.length === 0) fail(`.github/workflows/${wf}`, "no release shape check found");
      for (const c of checks) {
        if (c !== "12") fail(`.github/workflows/${wf}`, `release shape check allows {${c}} instead of {12}`);
      }
    }
  }

  // 3. Single namespace (this parity file's own doc comment is the one
  // allowed mention — it is excluded from the scan by construction).
  {
    const scanned = [
      "scripts/build-context.mjs",
      "scripts/build-apk.mjs",
      "scripts/check-sentry-config.mjs",
      "scripts/check-release-config.mjs",
      "scripts/check-mobile-build-config.mjs",
      ".github/workflows/release.yml",
      ".github/workflows/ci.yml",
      ".github/workflows/web.yml",
      "Dockerfile",
      "docker-compose.yml",
      "apps/mobile/vite.config.ts",
      ...walkTs(join(root, "apps/mobile/src")).map((p) => p.slice(root.length + 1)),
    ];
    for (const rel of scanned) {
      if (read(rel).includes("findback-web@")) fail(rel, "second release namespace minted outside the parity doc");
    }
  }

  // 4. Closed dist set.
  {
    const expected = { debug: "android-debug", signeddev: "android-signeddev", release: "android-release" };
    for (const [variant, dist] of Object.entries(expected)) {
      if (DIST_FOR_VARIANT[variant] !== dist) fail("scripts/build-apk.mjs:88", `DIST_FOR_VARIANT.${variant} drifted`);
    }
    for (const dist of Object.values(DIST_FOR_VARIANT)) {
      if (!SENTRY_DIST_VALUES.includes(dist)) fail("scripts/build-context.mjs:38", `variant dist outside canonical set (${dist.length} chars)`);
    }
    for (const [file, dist] of [
      [".github/workflows/ci.yml", "android-debug"],
      [".github/workflows/release.yml", "android-release"],
      [".github/workflows/web.yml", "web-production"],
    ]) {
      if (!read(file).includes(`--dist ${dist}`)) fail(file, `upload --dist ${dist} missing`);
    }
    if (!read("Dockerfile").includes('VITE_SENTRY_DIST="docker-reference"')) fail("Dockerfile:38", "docker-reference default missing");
  }

  // 5. CLI pin sameness.
  {
    for (const wf of ["release.yml", "ci.yml", "web.yml"]) {
      const pins = [...read(`.github/workflows/${wf}`).matchAll(/@sentry\/cli@([0-9.]+)/g)].map((m) => m[1]);
      const distinct = [...new Set(pins)];
      if (distinct.length === 0) fail(`.github/workflows/${wf}`, "no sentry-cli pin found");
      for (const pin of distinct) {
        if (`@sentry/cli@${pin}` !== SENTRY_CLI_PIN) fail(`.github/workflows/${wf}`, `cli pin drift (@sentry/cli@${pin} vs canonical)`);
      }
    }
  }

  // 6. Trace-rate default 0.1.
  {
    if (SENTRY_DEFAULT_TRACES_SAMPLE_RATE !== 0.1) fail("scripts/build-context.mjs:34", "code default drifted from 0.1");
    if (!read("Dockerfile").includes('ARG VITE_SENTRY_TRACES_SAMPLE_RATE="0.1"')) fail("Dockerfile:36", "docker default drifted from 0.1");
    if (!read("docker-compose.yml").includes("0.1")) fail("docker-compose.yml", "compose fallback drifted from 0.1");
  }

  // 7. Upload-token hygiene (never a VITE_ name in build surfaces).
  {
    const surfaces = [
      "Dockerfile",
      "docker-compose.yml",
      "apps/mobile/vite.config.ts",
      "scripts/build-context.mjs",
      "scripts/build-apk.mjs",
      "scripts/check-sentry-config.mjs",
      "scripts/check-mobile-build-config.mjs",
      ".github/workflows/release.yml",
      ".github/workflows/ci.yml",
      ".github/workflows/web.yml",
      ...walkTs(join(root, "apps/mobile/src")).map((p) => p.slice(root.length + 1)),
    ];
    for (const rel of surfaces) {
      if (read(rel).includes("VITE_SENTRY_AUTH_TOKEN")) fail(rel, "upload token would bake into the bundle via VITE_ prefix");
    }
  }

  return failures;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const failures = checkParity();
  if (failures.length > 0) {
    for (const f of failures) console.error(`check-sentry-release-parity: FAIL (${f})`);
    process.exit(1);
  }
  console.log("check-sentry-release-parity: PASS (one release scheme, one dist map, one cli pin)");
}
