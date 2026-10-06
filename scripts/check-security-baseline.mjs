#!/usr/bin/env node
/**
 * Deterministic dependency-security guard (no network).
 *
 * `npm audit` is the authority for live advisories, but it needs the registry
 * and can be noisy/slow. This tripwire closes the specific high findings that
 * the v0.9.0-beta.1 wave fixed, by parsing `package-lock.json` and failing if
 * any *installed* copy of a patched package is below its fixed version:
 *
 *   * @graphql-tools/utils < 12.0.1  — CVE-2026-104852 / GHSA-7mx3-vvmw-hjmv
 *     (prototype pollution in `mergeDeep`), pulled in through graphql-yoga.
 *   * sharp < 0.35.5 — CVE-2026-96889 / GHSA-wq5f-xc86-pv6w
 *     (librsvg memory-safety), the API's image normalizer.
 *
 * Every installed copy is checked, including nested ones under other
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

/** Advisory baselines closed by this wave. Never remove without re-auditing. */
export const ADVISORIES = [
  {
    package: "@graphql-tools/utils",
    fixedAt: "12.0.1",
    cve: "CVE-2026-104852",
    ghsa: "GHSA-7mx3-vvmw-hjmv",
    reason: "prototype pollution in mergeDeep",
  },
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
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(version.trim());
  if (!match) return null;
  return {
    parts: [Number(match[1]), Number(match[2]), Number(match[3])],
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
 * installed copy that violates an advisory baseline.
 */
export function findViolations(packages, advisories = ADVISORIES) {
  const violations = [];
  if (!packages || typeof packages !== "object") return violations;
  for (const [path, meta] of Object.entries(packages)) {
    if (typeof path !== "string" || !path.includes("node_modules/")) continue;
    if (!meta || typeof meta.version !== "string") continue;
    const name = typeof meta.name === "string" ? meta.name : packageNameFromPath(path);
    if (name === null) continue;
    for (const advisory of advisories) {
      if (name !== advisory.package) continue;
      if (compareVersions(meta.version, advisory.fixedAt) < 0) {
        violations.push({
          path,
          package: name,
          version: meta.version,
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
  let lock;
  try {
    lock = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch (error) {
    console.error(`check-security-baseline: cannot read ${lockPath}: ${error.message}`);
    process.exit(1);
  }
  const violations = findViolations(lock.packages);
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
    `check-security-baseline: PASS (no installed copy below: ${ADVISORIES.map((a) => `${a.package}@${a.fixedAt} [${a.cve}]`).join(", ")})`,
  );
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main();
}
