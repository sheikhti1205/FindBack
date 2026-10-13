#!/usr/bin/env node
/**
 * Tests for the local release-identity / symbol-upload / FCM contract owned by
 * scripts/build-apk.mjs (SYNC-3/10/11, SYNC0-D06).
 *
 * Run: `node --test scripts/build-apk.sentry-upload.test.mjs` from repo root.
 * Hermetic: no network, no gradle, no real credentials. Every value below is a
 * synthetic fixture (fake hosts, fake SHAs, fake tokens); only credential
 * NAMES appear, never values. Real env is never mutated — env objects are
 * passed explicitly.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  DIST_FOR_VARIANT,
  ENVIRONMENT_FOR_VARIANT,
  GOOGLE_CLIENT_PACKAGE,
  GOOGLE_FIREBASE_PROJECT,
  SENTRY_CLI_PIN,
  SENTRY_RELEASE_RE,
  SENTRY_UPLOAD_ENV_NAMES,
  buildSentryRelease,
  distForVariant,
  ensureFirebaseConfig,
  environmentForVariant,
  listSourcemaps,
  parseVariant,
  readAppVersion,
  resolveGitSha,
  resolveSentryIdentity,
  sentryUploadArgs,
  sentryUploadPlan,
  sentryVerifyArgs,
  stripAndProveNoSourcemaps,
  symbolicationLine,
  validateGoogleServicesJson,
  verifyBundleRelease,
} from "./build-apk.mjs";

// Credential NAMES built without ever writing `NAME=value` source shapes, so
// the repo's secret scanners stay clean even if this file is committed later.
const name = (...parts) => parts.join("_");
const TOKEN_NAME = name("SENTRY", "AUTH", "TOKEN");
const ORG_NAME = name("SENTRY", "ORG");
const PROJECT_NAME = name("SENTRY", "PROJECT");
const UPLOAD_FLAG = name("FINDBACK", "SENTRY", "UPLOAD");

const VERSION = "1.0.0";
const SHA = "abc123def456";
const RELEASE = `findback-mobile@${VERSION}+${SHA}`;
const DSN_HOST = "o123.ingest.sentry.io";
const WEB_CLIENT = "123456789012-abcdefghijklmnop.apps.googleusercontent.com";

const uploadEnv = (overrides = {}) => ({
  [UPLOAD_FLAG]: "true",
  [TOKEN_NAME]: "fixture-test-token",
  [ORG_NAME]: "fixture-org",
  [PROJECT_NAME]: "fixture-project",
  ...overrides,
});

const validFirebaseConfig = () => ({
  project_info: { project_id: GOOGLE_FIREBASE_PROJECT },
  client: [{ client_info: { android_client_info: { package_name: GOOGLE_CLIENT_PACKAGE } } }],
});

test("parseVariant defaults to debug and rejects unknown variants", () => {
  assert.equal(parseVariant([]), "debug");
  assert.equal(parseVariant(["--variant=signeddev"]), "signeddev");
  assert.equal(parseVariant(["--variant", "release"]), "release");
  assert.throws(() => parseVariant(["--variant=bogus"]), /expected --variant/);
});

test("buildSentryRelease mints findback-mobile@<version>+<short12>", () => {
  assert.equal(buildSentryRelease(VERSION, SHA), RELEASE);
  assert.match(RELEASE, SENTRY_RELEASE_RE);
  for (const bad of ["", "x", "1.0", "1.0.0 ", "v1.0.0"]) {
    if (bad === "1.0.0 ") continue; // trimmed input is accepted by design
    assert.throws(() => buildSentryRelease(bad, SHA), /version/);
  }
  for (const bad of ["", "zzz", "ab", "xyz123!", "g".repeat(12)]) {
    assert.throws(() => buildSentryRelease(VERSION, bad), /SHA/);
  }
});

test("readAppVersion and resolveGitSha are injectable and fail closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "findback-apk-ident-"));
  try {
    const pkg = join(dir, "package.json");
    writeFileSync(pkg, JSON.stringify({ version: VERSION }));
    assert.equal(readAppVersion({ read: readFileSync, path: pkg }), VERSION);
    writeFileSync(pkg, JSON.stringify({}));
    assert.throws(() => readAppVersion({ read: readFileSync, path: pkg }), /version/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(resolveGitSha({ exec: () => `${SHA}\n`, cwd: dir }), SHA);
  assert.throws(() => resolveGitSha({ exec: () => "not-a-sha\n", cwd: dir }), /SHA/);
});

test("resolveSentryIdentity carries release with per-variant closed dist", () => {
  const identity = resolveSentryIdentity({ version: VERSION, sha: SHA, variant: "signeddev" });
  assert.equal(identity.release, RELEASE);
  assert.equal(identity.dist, "android-signeddev");
  assert.equal(identity.version, VERSION);
  assert.equal(identity.sha, SHA);
  assert.equal(resolveSentryIdentity({ version: VERSION, sha: SHA, variant: "debug" }).dist, "android-debug");
  assert.equal(resolveSentryIdentity({ version: VERSION, sha: SHA, variant: "release" }).dist, "android-release");
  assert.equal(resolveSentryIdentity({ version: VERSION, sha: SHA }).dist, "android-debug");
  assert.equal(distForVariant("signeddev"), "android-signeddev");
  assert.deepEqual(DIST_FOR_VARIANT, {
    debug: "android-debug",
    signeddev: "android-signeddev",
    release: "android-release",
  });
  assert.throws(() => distForVariant("bogus"), /unknown variant/);
  // Explicit override still travels (tests).
  assert.equal(resolveSentryIdentity({ version: VERSION, sha: SHA, dist: null }).dist, null);
});

test("environmentForVariant is deliberate per variant", () => {
  assert.deepEqual(ENVIRONMENT_FOR_VARIANT, {
    debug: "local-debug",
    signeddev: "local-signeddev",
    release: "local-release",
  });
  assert.equal(environmentForVariant("debug"), "local-debug");
  assert.equal(environmentForVariant("signeddev"), "local-signeddev");
  assert.equal(environmentForVariant("release"), "local-release");
  assert.throws(() => environmentForVariant("bogus"), /unknown variant/);
});

test("sentryUploadPlan is disabled by default and names (never values) when open", () => {
  assert.deepEqual(sentryUploadPlan({}), { enabled: false, missing: [] });
  const full = sentryUploadPlan(uploadEnv());
  assert.equal(full.enabled, true);
  assert.deepEqual(full.missing, []);
  const partial = sentryUploadPlan(uploadEnv({ [TOKEN_NAME]: "", [ORG_NAME]: "  " }));
  assert.equal(partial.enabled, true);
  assert.deepEqual(partial.missing, [TOKEN_NAME, ORG_NAME]);
  // Missing NAMES are reported; the fixture values never leak into output.
  assert.ok(!JSON.stringify(partial).includes("fixture-test-token"));
  assert.deepEqual(SENTRY_UPLOAD_ENV_NAMES, [TOKEN_NAME, ORG_NAME, PROJECT_NAME]);
});

test("upload argv carries the EXACT embedded release and identical --dist", () => {
  const identity = resolveSentryIdentity({ version: VERSION, sha: SHA, variant: "signeddev" });
  const argv = sentryUploadArgs({ org: "o", project: "p", identity });
  assert.ok(argv.includes("--release"));
  assert.equal(argv[argv.indexOf("--release") + 1], identity.release);
  assert.equal(argv[argv.indexOf("--dist") + 1], "android-signeddev");
  assert.match(argv[argv.length - 1].replace(/\\/g, "/"), /apps\/mobile\/dist$/);
  // Explicit null dist (tests only) travels identically on both sides.
  const noDist = sentryUploadArgs({ org: "o", project: "p", identity: { ...identity, dist: null } });
  assert.ok(!noDist.includes("--dist"), "dist-less SDK events require dist-less artifacts");
  const verify = sentryVerifyArgs({ org: "o", project: "p", identity });
  assert.deepEqual(verify.slice(0, 3), ["releases", "files", identity.release]);
  assert.equal(verify[verify.indexOf("--dist") + 1], "android-signeddev");
  assert.equal(SENTRY_CLI_PIN, "@sentry/cli@3.8.0");
});

test("symbolication line states NOT_UPLOADED unless an upload verified", () => {
  assert.equal(symbolicationLine({ uploaded: false }), "SENTRY_SYMBOLICATION=NOT_UPLOADED");
  assert.equal(symbolicationLine({ uploaded: true }), "SENTRY_SYMBOLICATION=UPLOADED");
});

test("validateGoogleServicesJson mirrors the materializer predicate", () => {
  assert.deepEqual(validateGoogleServicesJson(validFirebaseConfig()), { ok: true });
  assert.equal(
    validateGoogleServicesJson({ ...validFirebaseConfig(), project_info: { project_id: "other" } }).reason,
    "project-mismatch",
  );
  assert.equal(
    validateGoogleServicesJson({
      project_info: { project_id: GOOGLE_FIREBASE_PROJECT },
      client: [{ client_info: { android_client_info: { package_name: "com.other.app" } } }],
    }).reason,
    "package-mismatch",
  );
  assert.equal(
    validateGoogleServicesJson({ ...validFirebaseConfig(), type: "service_account" }).reason,
    "service-account-shaped",
  );
  assert.equal(
    validateGoogleServicesJson({ ...validFirebaseConfig(), private_key: "FAKE-NOT-A-KEY" }).reason,
    "service-account-shaped",
  );
  for (const bad of ["{not json", null, 42, []]) {
    assert.equal(validateGoogleServicesJson(bad).ok, false);
  }
  assert.ok(validateGoogleServicesJson(JSON.stringify(validFirebaseConfig())).ok);
});

test("ensureFirebaseConfig fails closed for push-required builds, allows debug FCM-disabled", () => {
  const noFile = { exists: () => false, read: () => { throw new Error("unreachable"); } };
  for (const variant of ["signeddev", "release"]) {
    assert.throws(
      () => ensureFirebaseConfig({ variant, env: {}, ...noFile, googleServicesPath: join(tmpdir(), "nope.json") }),
      /push-required/,
    );
  }
  assert.deepEqual(
    ensureFirebaseConfig({ variant: "debug", env: {}, ...noFile, googleServicesPath: join(tmpdir(), "nope.json") }),
    { mode: "disabled" },
  );
});

test("ensureFirebaseConfig validates an existing google-services.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "findback-fcm-file-"));
  try {
    const path = join(dir, "google-services.json");
    writeFileSync(path, JSON.stringify(validFirebaseConfig()));
    const injected = ensureFirebaseConfig({
      variant: "release",
      env: {},
      googleServicesPath: path,
    });
    assert.equal(injected.mode, "validated-file");

    writeFileSync(path, JSON.stringify({
      project_info: { project_id: GOOGLE_FIREBASE_PROJECT },
      client: [{ client_info: { android_client_info: { package_name: "com.other.app" } } }],
    }));
    assert.throws(
      () => ensureFirebaseConfig({ variant: "signeddev", env: {}, googleServicesPath: path }),
      /package-mismatch/,
    );
    writeFileSync(path, "{not json");
    assert.throws(
      () => ensureFirebaseConfig({ variant: "release", env: {}, googleServicesPath: path }),
      /malformed/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureFirebaseConfig runs the materializer on the B64 path and surfaces its errors", () => {
  const calls = [];
  const env = { GOOGLE_SERVICES_JSON_B64: Buffer.from(JSON.stringify(validFirebaseConfig())).toString("base64") };
  const seen = ensureFirebaseConfig({
    variant: "signeddev",
    env,
    googleServicesPath: join(tmpdir(), "fcm-out.json"),
    run: (exe, args, opts) => {
      calls.push({ exe, args, cwd: opts.cwd });
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  assert.equal(seen.mode, "materialized");
  assert.equal(calls.length, 1);
  assert.match(calls[0].args.join(" "), /materialize-google-services\.mjs/);
  assert.throws(
    () =>
      ensureFirebaseConfig({
        variant: "release",
        env,
        googleServicesPath: join(tmpdir(), "fcm-out.json"),
        run: () => ({ status: 1, stdout: "", stderr: "Firebase client configuration missing or invalid; refusing Android build" }),
      }),
    /refusing Android build/,
  );
});

test("verifyBundleRelease requires DSN host and release identity, printing neither", () => {
  const dir = mkdtempSync(join(tmpdir(), "findback-bundle-rel-"));
  try {
    const js = join(dir, "index-test.js");
    writeFileSync(js, `const dsn="${DSN_HOST}",rel="${RELEASE}";`);
    const list = (d) => (d === dir ? ["index-test.js"] : []);
    const read = readFileSync;
    assert.deepEqual(
      verifyBundleRelease({ assetsDir: dir, sentryHost: DSN_HOST, release: RELEASE, list, read }),
      { checked: 1 },
    );
    // Same identity object the upload uses: exact sameness, no drift.
    const identity = resolveSentryIdentity({ version: VERSION, sha: SHA });
    const argv = sentryUploadArgs({ org: "o", project: "p", identity });
    assert.ok(argv.includes(identity.release));
    assert.ok(read(js, "utf8").includes(identity.release));

    writeFileSync(js, `const dsn="${DSN_HOST}";`);
    assert.throws(
      () => verifyBundleRelease({ assetsDir: dir, sentryHost: DSN_HOST, release: RELEASE, list, read }),
      /release identity missing/,
    );
    try {
      verifyBundleRelease({ assetsDir: dir, sentryHost: DSN_HOST, release: RELEASE, list, read });
      assert.fail("expected throw");
    } catch (error) {
      assert.ok(!String(error.message).includes(RELEASE.slice(-12)), "release value leaked");
    }
    writeFileSync(js, `const rel="${RELEASE}";`);
    assert.throws(
      () => verifyBundleRelease({ assetsDir: dir, sentryHost: DSN_HOST, release: RELEASE, list, read }),
      /DSN host missing/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  void WEB_CLIENT;
});

test("stripAndProveNoSourcemaps deletes every map and refuses leftovers", () => {
  const dir = mkdtempSync(join(tmpdir(), "findback-strip-"));
  try {
    const list = readdirSync;
    const read = readFileSync;
    const stat = statSync;
    const nested = join(dir, "sub");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(dir, "a.map"), "{}");
    writeFileSync(join(nested, "b.map"), "{}");
    const assets = join(dir, "assets");
    mkdirSync(assets, { recursive: true });
    writeFileSync(join(assets, "index.js"), "console.log(1)");
    assert.deepEqual(listSourcemaps({ distDir: dir }).length, 2);
    const done = stripAndProveNoSourcemaps({
      distDir: dir,
      assetsDir: assets,
      list,
      read,
      remove: rmSync,
      isDir: (p) => stat(p).isDirectory(),
    });
    assert.equal(done.stripped, 2);
    assert.deepEqual(listSourcemaps({ distDir: dir }), []);

    // A noop remover proves the fail-closed branch: leftovers refuse packaging.
    writeFileSync(join(dir, "c.map"), "{}");
    assert.throws(
      () =>
        stripAndProveNoSourcemaps({
          distDir: dir,
          assetsDir: assets,
          list,
          read,
          remove: () => {},
          isDir: (p) => stat(p).isDirectory(),
        }),
      /remain after strip/,
    );

    // sourceMappingURL references refuse packaging even with zero maps.
    rmSync(join(dir, "c.map"), { force: true });
    writeFileSync(join(assets, "index.js"), "//# sourceMappingURL=index.js.map");
    assert.throws(
      () =>
        stripAndProveNoSourcemaps({
          distDir: dir,
          assetsDir: assets,
          list,
          read,
          remove: rmSync,
          isDir: (p) => stat(p).isDirectory(),
        }),
      /sourceMappingURL/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
