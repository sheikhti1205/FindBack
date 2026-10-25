#!/usr/bin/env node
/**
 * Deterministic dependency-security guard (no network).
 *
 * `npm audit` is the authority for live advisories, but it needs the registry
 * and can be noisy/slow. This tripwire closes the specific high findings that
 * reviewed security waves fixed, by parsing `package-lock.json` and failing if
 * any locked dependency copy of a patched package is below its fixed version:
 *
 *   * @graphql-tools/utils < 12.0.2 — incremental-result path coercion;
 *     also preserves the earlier 12.0.1 mergeDeep pollution fix.
 *   * sharp < 0.35.5 — CVE-2026-96889 / GHSA-wq5f-xc86-pv6w
 *     (librsvg memory-safety), the API's image normalizer.
 *   * zod, body-parser, multer, undici, vite and vitest/mocker — CF-SECURITY-020.
 * These are the project's chosen supported release floors, not a general
 * advisory range solver for every historical major/backport line.
 *
 * Every locked copy is checked, including nested ones under other
 * `node_modules/` paths, so a re-hoist cannot silently reintroduce the
 * vulnerable version.
 *
 * Usage:
 *   node scripts/check-security-baseline.mjs            # uses package-lock.json
 *   node scripts/check-security-baseline.mjs --lock path/to/package-lock.json
 *
 * Pure Node builtins. Test suite: scripts/check-security-baseline.test.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

/** Supported package floors. Never remove without re-auditing. */
export const ADVISORIES = [
  {
    package: "@graphql-tools/utils",
    fixedAt: "12.0.2",
    cve: "CVE-2026-114604",
    ghsa: "GHSA-c4qx-w738-7hr3",
    reason: "prototype pollution in incremental-result paths (also retains mergeDeep fix)",
  },
  { package: "zod", fixedAt: "4.6.6", cve: "CVE-2023-54404", ghsa: "GHSA-mrhx-c7xc-m3w5", reason: "unbounded collection validation issues" },
  { package: "body-parser", fixedAt: "2.4.0", cve: "CVE-2026-111181", ghsa: "GHSA-27r3-jxmh-p828", reason: "unhandled compressed-body stream errors" },
  { package: "multer", fixedAt: "2.5.0", cve: "CVE-2026-113872", ghsa: "GHSA-q7qp-rjg7-q26m", reason: "pending async file filter after teardown" },
  { package: "undici", fixedAt: "8.12.2", cve: "CVE-2026-109869", ghsa: "GHSA-xjj6-f33q-929c", reason: "orphaned response stream on excessive content encodings" },
  { package: "vite", fixedAt: "8.2.4", cve: "CVE-2026-112946", ghsa: "GHSA-rq7h-c2jc-7f22", reason: "development server filesystem and cross-origin fixes, including bundled editor fixes" },
  { package: "@vitest/mocker", fixedAt: "5.0.3", cve: "CVE-2026-112949", ghsa: "GHSA-qxg6-89mg-rqv8", reason: "development manual mock code injection" },
  { package: "vitest", fixedAt: "5.0.3", cve: "CVE-2026-112949", ghsa: "GHSA-qxg6-89mg-rqv8", reason: "requires patched mocker dependency" },
  {
    package: "sharp",
    fixedAt: "0.35.5",
    cve: "CVE-2026-96889",
    ghsa: "GHSA-wq5f-xc86-pv6w",
    reason: "librsvg memory-safety vulnerability",
  },
];

/** Numeric core of a semver, ignoring build metadata; prerelease sorts lower. */
export function parseVersion(version) {
  if (typeof version !== "string") return null;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version.trim());
  if (!match) return null;
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (!parts.every(Number.isSafeInteger)) return null;
  if (match[4]?.split(".").some(part => /^0\d+$/.test(part))) return null;
  return {
    parts,
    prerelease: match[4] ?? null,
  };
}

/** Compare two semver strings: -1 if a<b, 0 if equal, 1 if a>b. */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === null || right === null) return 0;
  for (let i = 0; i < 3; i += 1) {
    if (left.parts[i] !== right.parts[i]) return left.parts[i] < right.parts[i] ? -1 : 1;
  }
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
  return left.prerelease < right.prerelease ? -1 : 1;
}

/** Package name of a lockfile path: everything after the last node_modules/. */
export function packageNameFromPath(path) {
  const marker = "node_modules/";
  const idx = path.lastIndexOf(marker);
  return idx === -1 ? null : path.slice(idx + marker.length);
}

/**
 * Pure core: given the `packages` map of a package-lock.json, return every
 * locked copy that violates an advisory baseline.
 */
export function findViolations(packages, advisories = ADVISORIES) {
  const violations = [];
  if (!packages || typeof packages !== "object" || Array.isArray(packages)) {
    throw new TypeError("package-lock.json must contain a packages object");
  }
  for (const [path, meta] of Object.entries(packages)) {
    if (typeof path !== "string" || !path.includes("node_modules/")) continue;
    const name = packageNameFromPath(path);
    for (const advisory of advisories) {
      if (name !== advisory.package && meta?.name !== advisory.package) continue;
      if (parseVersion(meta?.version) === null || compareVersions(meta.version, advisory.fixedAt) < 0) {
        violations.push({
          path,
          package: advisory.package,
          version: meta?.version ?? "missing",
          fixedAt: advisory.fixedAt,
          cve: advisory.cve,
          ghsa: advisory.ghsa,
          reason: advisory.reason,
        });
      }
    }
  }
  return violations;
}

function main() {
  const args = process.argv.slice(2);
  const lockIdx = args.indexOf("--lock");
  const lockPath = lockIdx !== -1 ? args[lockIdx + 1] : resolve(REPO_ROOT, "package-lock.json");
  if (!lockPath) {
    console.error("check-security-baseline: --lock requires a path");
    process.exit(1);
  }
  let violations;
  try {
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    violations = findViolations(lock.packages);
  } catch (error) {
    console.error(`check-security-baseline: cannot read ${lockPath}: ${error.message}`);
    process.exit(1);
  }
  if (violations.length > 0) {
    for (const v of violations) {
      console.error(
        `check-security-baseline: FAIL ${v.package}@${v.version} at ${v.path} is below ` +
          `${v.fixedAt} — ${v.cve} (${v.ghsa}: ${v.reason})`,
      );
    }
    process.exit(1);
  }
  console.log(
    `check-security-baseline: PASS (no locked copy below: ${ADVISORIES.map((a) => `${a.package}@${a.fixedAt} [${a.cve}]`).join(", ")})`,
  );
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main();
}
