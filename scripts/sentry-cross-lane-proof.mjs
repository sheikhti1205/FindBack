#!/usr/bin/env node
/**
 * sentry-cross-lane-proof — one-line, credential-free proof that a lane's
 * Sentry identity is coherent (X12).
 *
 * Given a lane's env (+ an optional built-asset path) it prints ONLY:
 *   - `release`      the canonical `findback-mobile@<version>+<short12>`
 *   - `dist`         one of the CLOSED dist set (build-context owner)
 *   - `dsn-host`     the DSN HOSTNAME only (never the key/credential)
 *   - `maps`         count of `.map` files under the asset path
 *   - `upload`       derived upload readiness (READY | NO-MAPS | NO-TOKEN)
 *
 * Secrecy contract (hard rule, covered by tests):
 *   - SENTRY_AUTH_TOKEN is only ever tested for PRESENCE; its value never
 *     appears in any output, error, or derived shape.
 *   - The DSN is reduced to its hostname via the canonical
 *     `validateSentryDsn` (check-sentry-config.mjs) — the key never surfaces.
 *   - Release/dist are validated by the canonical owners (build-context.mjs):
 *     release is exactly-12 hex, dist is from the closed set.
 *
 * Pure injectable API (exported for node --test, hermetic):
 *   SENTRY_RELEASE_SHAPE, resolveRelease, resolveLaneDist, resolveDsnHost,
 *   countSourcemaps, uploadStatus, buildCrossLaneProof, formatProof
 * Importing has no side effects; the CLI runs on direct execution.
 *
 * Usage:
 *   node scripts/sentry-cross-lane-proof.mjs [--asset <path>]
 *
 * Exit codes: 0 proof coherent, 1 any incoherence (details on stderr).
 */

import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SENTRY_DIST_VALUES,
  deriveAppVersion,
  deriveGitIdentity,
  resolveSentryDist,
  sentryRelease,
} from "./build-context.mjs";
import { validateSentryDsn } from "./check-sentry-config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

/** Canonical release shape: namespace@version+exactly-12-hex. */
export const SENTRY_RELEASE_SHAPE = /^findback-mobile@\d+\.\d+\.\d+[-+0-9A-Za-z.]*\+[0-9a-f]{12}$/i;

/** Re-export the closed dist set for callers/tests. */
export { SENTRY_DIST_VALUES };

function defaultListFiles(dir) {
  try {
    return readdirSync(dir, { recursive: true }).filter(
      (name) => typeof name === "string" && name.endsWith(".map"),
    );
  } catch {
    return [];
  }
}

/**
 * Resolve the canonical release. A baked `SENTRY_RELEASE`/`VITE_SENTRY_RELEASE`
 * (the SDK value) is trusted only when it matches SENTRY_RELEASE_SHAPE; else it
 * is derived from the injected version + short12 via the build-context owner.
 */
export function resolveRelease({ env = {}, version, short12 } = {}) {
  const source = env ?? {};
  const baked = String(source.SENTRY_RELEASE ?? source.VITE_SENTRY_RELEASE ?? "").trim();
  if (baked !== "") {
    if (!SENTRY_RELEASE_SHAPE.test(baked)) return { ok: false, reason: "malformed" };
    return { ok: true, release: baked, source: "baked" };
  }
  if (!version || !short12) return { ok: false, reason: "missing-identity" };
  try {
    return { ok: true, release: sentryRelease({ version, short12 }), source: "derived" };
  } catch {
    return { ok: false, reason: "invalid-identity" };
  }
}

/** Resolve the lane dist from an explicit value or env (`SENTRY_DIST`). */
export function resolveLaneDist({ env = {}, dist } = {}) {
  const source = env ?? {};
  const raw = String(dist ?? source.SENTRY_DIST ?? source.VITE_SENTRY_DIST ?? "").trim();
  const resolved = resolveSentryDist(raw);
  return resolved.ok ? { ok: true, dist: resolved.dist } : { ok: false, reason: resolved.reason };
}

/** Reduce a DSN to its hostname via the canonical validator. Never the key. */
export function resolveDsnHost(dsn) {
  const result = validateSentryDsn(dsn);
  return result.ok ? { ok: true, host: result.host } : { ok: false, reason: result.reason };
}

/** Count `.map` files under a directory (injectable lister; never throws). */
export function countSourcemaps(dir, { listFiles } = {}) {
  if (!dir) return { count: 0, dir: null };
  const lister = listFiles ?? defaultListFiles;
  try {
    return { count: lister(dir).length, dir };
  } catch {
    return { count: 0, dir };
  }
}

/** Derived upload readiness from token PRESENCE + map count (no values). */
export function uploadStatus(tokenPresent, maps) {
  if (!tokenPresent) return "NO-TOKEN";
  return maps > 0 ? "READY" : "NO-MAPS";
}

/**
 * Assemble the credential-free proof. Returns only safe fields plus an
 * `errors` list. A baked-vs-derived release mismatch is reported when both
 * are available (the cross-lane guarantee).
 */
export function buildCrossLaneProof({
  env = {},
  artifactPath = null,
  lane,
  version,
  short12,
  listFiles,
} = {}) {
  const source = env ?? {};
  const errors = [];

  const release = resolveRelease({ env: source, version, short12 });
  if (!release.ok) errors.push(`release ${release.reason}`);

  const baked = String(source.SENTRY_RELEASE ?? source.VITE_SENTRY_RELEASE ?? "").trim();
  if (baked !== "" && version && short12 && release.ok) {
    try {
      if (sentryRelease({ version, short12 }) !== baked) {
        errors.push("release mismatch (baked != derived)");
      }
    } catch {
      // Identity invalidity is already surfaced by resolveRelease above.
    }
  }

  const dist = resolveLaneDist({ env: source, dist: lane });
  if (!dist.ok) errors.push(`dist ${dist.reason}`);

  const dsn = resolveDsnHost(source.VITE_SENTRY_DSN ?? source.SENTRY_DSN ?? source.DSN);
  if (!dsn.ok) errors.push(`dsn ${dsn.reason}`);

  const maps = countSourcemaps(artifactPath, { listFiles });
  const tokenPresent =
    typeof source.SENTRY_AUTH_TOKEN === "string" && source.SENTRY_AUTH_TOKEN.trim() !== "";

  return {
    release: release.ok ? release.release : null,
    dist: dist.ok ? dist.dist : null,
    dsnHost: dsn.ok ? dsn.host : null,
    maps: maps.count,
    uploadStatus: uploadStatus(tokenPresent, maps.count),
    errors,
  };
}

/** Format ONLY the five safe fields (no token, no DSN credential). */
export function formatProof(proof) {
  return [
    "sentry-cross-lane-proof:",
    `  release: ${proof.release ?? "ABSENT"}`,
    `  dist: ${proof.dist ?? "ABSENT"}`,
    `  dsn-host: ${proof.dsnHost ?? "ABSENT"}`,
    `  maps: ${proof.maps}`,
    `  upload: ${proof.uploadStatus}`,
  ].join("\n");
}

function parseAssetArg(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--asset") return args[i + 1] ?? "";
    if (arg.startsWith("--asset=")) return arg.slice("--asset=".length);
  }
  return resolve(REPO_ROOT, "apps/mobile/dist");
}

function isMainModule() {
  const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
  return invoked === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`sentry-cross-lane-proof: credential-free Sentry lane proof

usage:
  node scripts/sentry-cross-lane-proof.mjs [--asset <path>]

prints: release, dist, dsn-host, maps count, upload status.
exit codes: 0 coherent, 1 any incoherence (details on stderr).`);
    process.exit(0);
  }
  const artifactPath = parseAssetArg(args) || null;
  let version;
  let short12;
  try {
    version = deriveAppVersion().version;
  } catch {
    version = undefined;
  }
  try {
    short12 = deriveGitIdentity().short12;
  } catch {
    short12 = undefined;
  }
  const proof = buildCrossLaneProof({ env: process.env, artifactPath, version, short12 });
  console.log(formatProof(proof));
  if (proof.errors.length > 0) {
    for (const line of proof.errors) console.error(`sentry-cross-lane-proof: FAIL (${line})`);
    process.exit(1);
  }
  process.exit(0);
}
