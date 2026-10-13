#!/usr/bin/env node
/**
 * Canonical build-context owner (SYNC-1, SYNC-8, SYNC0-D12).
 *
 * Five peer config owners (check-mobile-build-config, check-sentry-config,
 * check-google-config, check-map-config, check-share-config) previously each
 * derived git identity / app version / Sentry release-dist / trace-rate
 * policy on their own; the runbook maximum-tracing rate (1.0) drifted from
 * the code-conservative default (0.1) with no single validator. This module
 * is the ONE canonical owner every gate imports from.
 *
 * Every function is pure and injectable (the git runner and the file reader
 * are parameters), so tests are deterministic, hermetic, and never shell
 * out. Policy pinned here:
 * - Sentry release: `<namespace>@<version>+<short12>` with namespace
 *   `findback-mobile` (default) or `findback-web`. Mirrors
 *   apps/mobile/src/services/monitoring/release.ts (shape owned there).
 * - Sentry dist: exactly one of android-debug | android-signeddev |
 *   android-release | web-production | docker-reference.
 * - Trace rate: a number in [0, 1]. Empty means the code-conservative
 *   default 0.1 — never 1.0 in code; 1.0 arrives only via env/repo-variable
 *   (see docs/runbooks/sentry-max-logging.md). NaN and out-of-range REJECT
 *   (fail closed), unlike the clamping runtime fallback in sentry.ts.
 *
 * Reports print PRESENT/ABSENT, names, lengths, SHAs, release strings —
 * NEVER secret values. This module handles no secrets at all.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Code-conservative default. The 1.0 maximum comes from env, never code. */
export const SENTRY_DEFAULT_TRACES_SAMPLE_RATE = 0.1;
/**
 * THE single Sentry release namespace. Every lane (local variants, CI,
 * release, web, docker-reference) mints `findback-mobile@<version>+<short12>`;
 * lanes differ by dist, never by namespace. A second namespace MUST NOT be
 * introduced — web uses dist `web-production` under this same namespace.
 */
export const SENTRY_RELEASE_MOBILE_NAMESPACE = "findback-mobile";
/** Closed lane mapping: build variant -> Sentry dist. */
export const SENTRY_DIST_VALUES = Object.freeze([
  "android-debug",
  "android-signeddev",
  "android-release",
  "web-production",
  "docker-reference",
]);

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

const FULL_SHA_RE = /^[0-9a-f]{40}$/i;
const SHORT12_RE = /^[0-9a-f]{12}$/i;
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const PLACEHOLDER_RE =
  /^(placeholder|example|test|dummy|unknown|null|undefined|your[-_].*|changeme)$/i;

function fail(message) {
  throw new Error(`build-context: ${message}`);
}

function defaultGit(args) {
  return execFileSync("git", args, { encoding: "utf8", cwd: REPO_ROOT });
}

function defaultRead(path) {
  return readFileSync(path, "utf8");
}

/**
 * Derive { fullSha, short12 } via the injected git runner
 * (default: `git rev-parse HEAD`). The 12-char short SHA matches the
 * `git rev-parse --short=12 HEAD` identity the release workflow mints.
 * Refuses malformed output without echoing it.
 */
export function deriveGitIdentity({ git = defaultGit } = {}) {
  let raw;
  try {
    raw = String(git(["rev-parse", "HEAD"])).trim();
  } catch {
    fail("cannot derive git identity (git rev-parse HEAD failed)");
  }
  if (!FULL_SHA_RE.test(raw)) {
    fail(`refusing malformed git SHA (${raw.length} chars, value withheld)`);
  }
  return { fullSha: raw, short12: raw.slice(0, 12) };
}

/**
 * Read the root + apps/mobile package.json versions via the injected
 * reader (default: fs) and assert they are present and in sync.
 * Returns { version }. Shape validation lives in sentryRelease.
 */
export function deriveAppVersion({ read = defaultRead, rootDir = REPO_ROOT } = {}) {
  let rootPkg;
  let mobilePkg;
  try {
    rootPkg = JSON.parse(read(resolve(rootDir, "package.json")));
    mobilePkg = JSON.parse(read(resolve(rootDir, "apps/mobile/package.json")));
  } catch {
    fail("cannot read package.json pair (root + apps/mobile)");
  }
  const rootVersion = String(rootPkg?.version ?? "").trim();
  const mobileVersion = String(mobilePkg?.version ?? "").trim();
  if (!rootVersion) fail("root package.json has no version");
  if (!mobileVersion) fail("apps/mobile/package.json has no version");
  if (rootVersion !== mobileVersion) {
    fail(`version mismatch: root package.json is ${rootVersion} but apps/mobile/package.json is ${mobileVersion}`);
  }
  return { version: mobileVersion };
}

/**
 * Mint the canonical Sentry release string. Throws on empty, placeholder,
 * or malformed inputs (fail closed — never mint a release that cannot match
 * the sourcemap upload). Failure messages carry lengths, never values.
 * The namespace is pinned, not parameterized: one scheme everywhere.
 */
export function sentryRelease({ version, short12, namespace } = {}) {
  if (namespace !== undefined) {
    fail("release namespace is pinned to findback-mobile (lanes differ by dist, never by namespace)");
  }
  const cleanVersion = String(version ?? "").trim();
  const cleanSha = String(short12 ?? "").trim();
  if (!cleanVersion || !VERSION_RE.test(cleanVersion) || PLACEHOLDER_RE.test(cleanVersion)) {
    fail(`refusing bad release version (${cleanVersion.length} chars, value withheld)`);
  }
  if (!SHORT12_RE.test(cleanSha)) {
    fail(`refusing bad release sha (${cleanSha.length} chars, value withheld)`);
  }
  return `${SENTRY_RELEASE_MOBILE_NAMESPACE}@${cleanVersion}+${cleanSha}`;
}

/**
 * Validate a dist lane. Returns { ok: true, dist } or
 * { ok: false, reason: "missing" | "unknown-dist" }.
 */
export function resolveSentryDist(raw) {
  const dist = String(raw ?? "").trim();
  if (!dist) return { ok: false, reason: "missing" };
  if (!SENTRY_DIST_VALUES.includes(dist)) return { ok: false, reason: "unknown-dist" };
  return { ok: true, dist };
}

/**
 * Canonical trace-rate validator. Empty means the code-conservative default
 * 0.1 (source "default"); an explicit 0..1 value keeps source "explicit".
 * NaN and out-of-range values REJECT with a reason code — no clamping, so
 * a bad repo variable fails the preflight instead of shipping silently.
 */
export function validateTraceRate(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return { ok: true, rate: SENTRY_DEFAULT_TRACES_SAMPLE_RATE, source: "default" };
  }
  const parsed = typeof raw === "number" ? raw : Number.parseFloat(String(raw).trim());
  if (!Number.isFinite(parsed)) return { ok: false, reason: "nan" };
  if (parsed < 0 || parsed > 1) return { ok: false, reason: "out-of-range" };
  return { ok: true, rate: parsed, source: "explicit" };
}

/** PRESENT when a value is configured, else ABSENT — never the value. */
export function presence(raw) {
  return String(raw ?? "").trim() ? "PRESENT" : "ABSENT";
}

function isMainModule() {
  const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
  return invoked === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  try {
    const distFlag = process.argv.find((arg) => arg.startsWith("--dist="));
    const { short12 } = deriveGitIdentity();
    const { version } = deriveAppVersion();
    const release = sentryRelease({ version, short12 });
    const distRaw = distFlag ? distFlag.slice("--dist=".length) : (process.env.SENTRY_DIST ?? "");
    let distLabel = "ABSENT";
    if (distRaw.trim()) {
      const dist = resolveSentryDist(distRaw);
      if (!dist.ok) fail(`sentry dist ${dist.reason} (expected one of ${SENTRY_DIST_VALUES.join(" | ")})`);
      distLabel = dist.dist;
    }
    const rate = validateTraceRate(process.env.VITE_SENTRY_TRACES_SAMPLE_RATE);
    if (!rate.ok) {
      fail(
        `VITE_SENTRY_TRACES_SAMPLE_RATE ${rate.reason} ` +
          `(expected 0..1; empty defaults to ${SENTRY_DEFAULT_TRACES_SAMPLE_RATE})`,
      );
    }
    console.log(
      `build-context: PASS (release=${release} dist=${distLabel} traces=${rate.rate} (${rate.source}) git=${short12} version=${version})`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message.startsWith("build-context:") ? message : `build-context: ${message}`);
    process.exitCode = 1;
  }
}
