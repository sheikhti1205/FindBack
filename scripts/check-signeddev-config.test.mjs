import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { checkAppLinksManifest, checkSigneddevConfig, buildProvenanceReport, PROVENANCE_FIELDS, MANIFEST_PATH } from "./check-signeddev-config.mjs";

const script = resolve("scripts/check-signeddev-config.mjs");
const url = "https://sampleproject.supabase.co";
const key = "sb_publishable_abcdefghijklmnopqrstuvwxyz";
const dsn = "https://abcdef123456@o123.ingest.sentry.io/123";
const share = "https://findback.test";
const google = "123456789012-abcdefghijklmnop.apps.googleusercontent.com";
const PIN = "34:11:5A:E9:B5:97:68:27:6B:54:D4:0B:B0:33:68:2A:46:EF:0F:39:18:D5:B7:83:26:3E:A1:83:3A:07:62:4C";

const baseEnv = {
  VITE_SUPABASE_URL: url,
  VITE_SUPABASE_PUBLISHABLE_KEY: key,
  VITE_SENTRY_DSN: dsn,
  VITE_PUBLIC_SHARE_ORIGIN: share,
  GOOGLE_WEB_CLIENT_ID: google,
  ANDROID_SIGNING_CERT_SHA256: "",
};

function run(args, env = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...baseEnv, ...env },
  });
}

function writeStagedAssets(dir) {
  mkdirSync(join(dir, ".well-known"), { recursive: true });
  writeFileSync(join(dir, ".well-known", "assetlinks.json"), JSON.stringify([
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: {
        namespace: "android_app",
        package_name: "com.findback.app",
        sha256_cert_fingerprints: [PIN],
      },
    },
  ]));
  writeFileSync(join(dir, "staticwebapp.config.json"), JSON.stringify({
    navigationFallback: { exclude: ["/.well-known/*", "/assets/*"] },
  }));
  return dir;
}

const validManifest = () => readFileSync(MANIFEST_PATH, "utf8");

test("the shipped AndroidManifest satisfies the App-Links contract", () => {
  assert.equal(checkAppLinksManifest(validManifest()), null);
});

test("the App-Links contract rejects a host that could drift from the share config", () => {
  const hardcoded = validManifest().replaceAll("${findbackShareHost}", "findback.test");
  assert.match(String(checkAppLinksManifest(hardcoded)), /placeholder/);
});

test("the App-Links contract rejects non-https, extra routes, and missing filters", () => {
  const http = validManifest().replaceAll('android:scheme="https"', 'android:scheme="http"');
  assert.match(String(checkAppLinksManifest(http)), /https-only/);

  const wide = validManifest().replaceAll('android:pathPrefix="/r/"', 'android:pathPrefix="/"');
  assert.match(String(checkAppLinksManifest(wide)), /\/r\//);

  const noVerify = validManifest().replaceAll(' android:autoVerify="true"', "");
  assert.match(String(checkAppLinksManifest(noVerify)), /autoVerify/);

  assert.match(String(checkAppLinksManifest("")), /empty/);
});

test("signeddev gate passes the real staged web surface and manifest", () => {
  const dir = mkdtempSync(join(tmpdir(), "findback-signeddev-ok-"));
  try {
    writeStagedAssets(dir);
    const result = run(["--assets", dir]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /PASS/);
    assert.doesNotMatch(result.stdout + result.stderr, /sb_publishable_|@o123|123456789012/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("signeddev gate enforces an exact association pin when one is exported", () => {
  const dir = mkdtempSync(join(tmpdir(), "findback-signeddev-pin-"));
  try {
    writeStagedAssets(dir);
    assert.equal(run(["--assets", dir], { ANDROID_SIGNING_CERT_SHA256: PIN }).status, 0);

    const mismatch = run(["--assets", dir], { ANDROID_SIGNING_CERT_SHA256: "ab".repeat(32) });
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stderr, /does not match release signing pin/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("signeddev gate fails closed on missing provenance config", () => {
  const dir = mkdtempSync(join(tmpdir(), "findback-signeddev-missing-"));
  try {
    writeStagedAssets(dir);
    const noSupabase = run(["--assets", dir], { VITE_SUPABASE_URL: "", SUPABASE_URL: "" });
    assert.notEqual(noSupabase.status, 0);
    assert.match(noSupabase.stderr, /VITE_SUPABASE_URL|Supabase/);

    const noSentry = run(["--assets", dir], { VITE_SENTRY_DSN: "" });
    assert.notEqual(noSentry.status, 0);
    assert.match(noSentry.stderr, /VITE_SENTRY_DSN/);

    const noGoogle = run(["--assets", dir], { GOOGLE_WEB_CLIENT_ID: "not-a-client-id" });
    assert.notEqual(noGoogle.status, 0);
    assert.match(noGoogle.stderr, /GOOGLE_WEB_CLIENT_ID/);

    const noShare = run(["--assets", dir], { VITE_PUBLIC_SHARE_ORIGIN: "" });
    assert.notEqual(noShare.status, 0);
    assert.match(noShare.stderr, /share/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("signeddev gate fails closed on a stale or tampered association", () => {
  const dir = mkdtempSync(join(tmpdir(), "findback-signeddev-tampered-"));
  try {
    mkdirSync(join(dir, ".well-known"), { recursive: true });
    // Tampered: wrong package name.
    writeFileSync(join(dir, ".well-known", "assetlinks.json"), JSON.stringify([
      {
        relation: ["delegate_permission/common.handle_all_urls"],
        target: {
          namespace: "android_app",
          package_name: "com.not.findback.app",
          sha256_cert_fingerprints: [PIN],
        },
      },
    ]));
    writeFileSync(join(dir, "staticwebapp.config.json"), JSON.stringify({
      navigationFallback: { exclude: ["/.well-known/*"] },
    }));
    const tampered = run(["--assets", dir]);
    assert.notEqual(tampered.status, 0);
    assert.match(tampered.stderr, /com\.findback\.app/);

    // Stale: association served as the HTML fallback.
    writeFileSync(join(dir, ".well-known", "assetlinks.json"), JSON.stringify([
      {
        relation: ["delegate_permission/common.handle_all_urls"],
        target: {
          namespace: "android_app",
          package_name: "com.findback.app",
          sha256_cert_fingerprints: [PIN],
        },
      },
    ]));
    writeFileSync(join(dir, "staticwebapp.config.json"), JSON.stringify({
      navigationFallback: { exclude: ["/assets/*"] },
    }));
    const stale = run(["--assets", dir]);
    assert.notEqual(stale.status, 0);
    assert.match(stale.stderr, /fall back to HTML/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkSigneddevConfig reports every failing check, not just the first", () => {
  const dir = mkdtempSync(join(tmpdir(), "findback-signeddev-multi-"));
  const previous = Object.fromEntries(Object.keys(baseEnv).map((name) => [name, process.env[name]]));
  Object.assign(process.env, baseEnv);
  try {
    writeStagedAssets(dir);
    const base = checkSigneddevConfig({ assetsRoot: dir });
    assert.equal(base.ok, true, "the synthetic baseline must pass without a local .env");
    assert.ok(Array.isArray(base.errors));
    for (const error of base.errors) assert.equal(typeof error, "string");

    // Force three independent failures in three different checks, measuring
    // the message each one produces on its own.
    const withBadGoogleId = (fn) => {
      const previous = process.env.GOOGLE_WEB_CLIENT_ID;
      process.env.GOOGLE_WEB_CLIENT_ID = "not-a-client-id";
      try {
        return fn();
      } finally {
        if (previous === undefined) delete process.env.GOOGLE_WEB_CLIENT_ID;
        else process.env.GOOGLE_WEB_CLIENT_ID = previous;
      }
    };
    const missingManifest = join(dir, "missing-manifest.xml");
    const mismatchedPin = "ab".repeat(32);
    const variants = [
      { name: "google", run: (opts) => withBadGoogleId(() => checkSigneddevConfig(opts)) },
      {
        name: "manifest",
        run: (opts) => checkSigneddevConfig({ ...opts, manifestPath: missingManifest }),
      },
      {
        name: "association",
        run: (opts) =>
          checkSigneddevConfig({ ...opts, env: { ANDROID_SIGNING_CERT_SHA256: mismatchedPin } }),
      },
    ];

    const soloFailures = [];
    for (const variant of variants) {
      const result = variant.run({ assetsRoot: dir });
      assert.equal(result.ok, false, `${variant.name}: forced failure did not fail the gate`);
      const added = result.errors.filter((error) => !base.errors.includes(error));
      assert.ok(
        added.length >= 1,
        `${variant.name}: no distinct failure line (got ${JSON.stringify(result.errors)})`,
      );
      soloFailures.push(...added);
    }

    // All three at once: the aggregate must still name every single failure,
    // not just the first. A missing ambient value must not replace a variant.
    const all = withBadGoogleId(() =>
      checkSigneddevConfig({
        assetsRoot: dir,
        manifestPath: missingManifest,
        env: { ANDROID_SIGNING_CERT_SHA256: mismatchedPin },
      }),
    );
    assert.equal(all.ok, false);
    for (const message of soloFailures) {
      assert.ok(
        all.errors.includes(message),
        `aggregation dropped a failing check: ${message}`,
      );
    }
    assert.ok(all.errors.length >= base.errors.length + variants.length);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- FBX-025 (M-a): assembleSigneddev MUST fail — never debug-sign — when the
// canonical release signing env is incomplete. No Android SDK or keystore
// exists in this environment, so assembleSigneddev itself cannot execute here
// (deferred — see the handoff); these tests PROVE the fail-closed semantics in
// the packaging contract instead: the readiness predicate, the null-signer
// else branch, and the task-graph guard that refuses packaging outright.
const buildGradleText = () => readFileSync(resolve("apps/mobile/android/app/build.gradle"), "utf8");

test("M-a: signeddev readiness requires all four canonical signing vars", () => {
  const text = buildGradleText();
  for (const name of ["ANDROID_KEYSTORE_PATH", "ANDROID_KEYSTORE_PASSWORD", "ANDROID_KEY_ALIAS", "ANDROID_KEY_PASSWORD"]) {
    assert.ok(text.includes(`"${name}"`), `signeddev contract lost ${name}`);
  }
  assert.match(text, /def signeddevSigningReady\(\)/);
});

test("M-a: signeddev never falls back to the debug signer", () => {
  const text = buildGradleText();
  assert.doesNotMatch(text, /signingConfigs\.debug/);
  // The else branch drops the debug-inherited signer entirely, so even a path
  // that bypassed the guard below would emit UNSIGNED — never debug-signed.
  assert.match(text, /signingConfig = null/);
  assert.match(text, /signingConfigs\.findbackRelease/);
});

test("M-a: task-graph guard refuses every signeddev packaging entry point", () => {
  const text = buildGradleText();
  assert.match(text, /gradle\.taskGraph\.whenReady/);
  assert.match(text, /signeddevSigningReady\(\)/);
  assert.match(text, /throw new GradleException/);
  assert.match(text, /instead of falling back to the[\s\S]*debug signer/);
  for (const prefix of ["assemble", "bundle", "package", "install"]) {
    assert.ok(text.includes(`"${prefix}"`), `guard lost the ${prefix} entry point`);
  }
});

// --- FBX-026 (M-b): bundled-client + web-provenance verification is attached
// to Signeddev packaging on the DIRECT Gradle path (not just the npm
// wrapper). Proven two ways: the Gradle wiring itself, and the exact script
// invocations Gradle performs against tampered/stale staged assets.
test("M-b: direct Gradle packaging of signeddev runs both verify tasks", () => {
  const text = buildGradleText();
  assert.match(text, /tasks\.register\("verifyBundledClientConfig", Exec\)/);
  assert.match(text, /tasks\.register\("verifySigneddevConfig", Exec\)/);
  assert.match(text, /check-mobile-build-config\.mjs/);
  assert.match(text, /check-signeddev-config\.mjs/);
  // packageSigneddev must be covered by BOTH verify hooks; the bundle hook
  // covers the AAB path too.
  const bundled = text.match(/verifyBundledClientConfig"[\s\S]{0,400}?packageSigneddev/);
  assert.ok(bundled, "packageSigneddev bypasses verifyBundledClientConfig");
  const signeddev = text.match(/verifySigneddevConfig"[\s\S]{0,400}?packageSigneddev/);
  assert.ok(signeddev, "packageSigneddev bypasses verifySigneddevConfig");
  assert.ok(text.includes("packageSigneddevBundle"), "bundle path bypasses signeddev verification");
});

test("M-b: the Gradle-invoked signeddev gate fails an empty staged surface", () => {
  const dir = mkdtempSync(join(tmpdir(), "findback-signeddev-empty-"));
  try {
    // Exactly how verifySigneddevConfig invokes it: --assets <staged-public>.
    // No .well-known association at all must fail, not pass vacuously.
    const result = run(["--assets", dir]);
    assert.notEqual(result.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- FBX-028: the RELEASE path must carry the same public-config + App-Links
// provenance gate as signeddev, so a direct `./gradlew assembleRelease` cannot
// ship a signed APK with GOOGLE_WEB_CLIENT_ID (or other config) missing.
test("FBX-028: direct Gradle packaging of release runs verifyReleaseConfig", () => {
  const text = buildGradleText();
  assert.match(text, /tasks\.register\("verifyReleaseConfig", Exec\)/);
  const release = text.match(/verifyReleaseConfig"[\s\S]{0,600}?packageRelease/);
  assert.ok(release, "packageRelease bypasses verifyReleaseConfig");
  assert.ok(text.includes("packageReleaseBundle"), "release bundle path bypasses verifyReleaseConfig");
  // The new release gate must reuse the signeddev config checker (Google id,
  // map config, App-Links, association) — not a weaker check.
  const gate = text.match(/verifyReleaseConfig", Exec\)[\s\S]{0,300}?check-signeddev-config\.mjs/);
  assert.ok(gate, "verifyReleaseConfig must invoke check-signeddev-config.mjs");
});

// --- FBX-027 wiring: the signeddev gate includes the map build truth, so a
// direct `./gradlew assembleSigneddev` fails on malformed custom map config.
test("signeddev gate fails closed on malformed custom map config", () => {
  const dir = mkdtempSync(join(tmpdir(), "findback-signeddev-map-"));
  const previous = process.env.FINDBACK_MAP_STYLE_URL;
  process.env.FINDBACK_MAP_STYLE_URL = "http://plaintext-tiles-fail-the-gate.example.net/style";
  try {
    writeStagedAssets(dir);
    const result = run(["--assets", dir]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /FINDBACK_MAP_STYLE_URL/);
    assert.doesNotMatch(result.stdout + result.stderr, /plaintext-tiles-fail-the-gate/);
  } finally {
    if (previous === undefined) delete process.env.FINDBACK_MAP_STYLE_URL;
    else process.env.FINDBACK_MAP_STYLE_URL = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- M-c: provenance report is limited to the mandated field set.
test("provenance report carries exactly the mandated fields, never values", () => {
  const report = buildProvenanceReport({
    apkPath: resolve("apps/mobile/android/app/build.gradle"),
    deps: {
      gitSha: () => "abc123def456",
      versionCode: () => 100042,
      appVersion: () => "1.0.0",
      appPackage: () => "com.findback.app",
      sha256File: () => "0".repeat(64),
      signerFingerprint: () => "AB".repeat(32),
      supabase: () => ({ host: "sampleproject.supabase.co", key: "PRESENT" }),
      google: () => "PRESENT",
      maps: () => "ABSENT",
      sentry: () => "PRESENT",
    },
  });
  assert.deepEqual(Object.keys(report).sort(), [...PROVENANCE_FIELDS].sort());
  assert.deepEqual(report, {
    gitSha: "abc123def456",
    package: "com.findback.app",
    version: "1.0.0",
    versionCode: 100042,
    apkSha256: "0".repeat(64),
    signerFingerprint: "AB".repeat(32),
    supabaseHost: "sampleproject.supabase.co",
    supabaseKey: "PRESENT",
    googleWebClient: "PRESENT",
    maps: "ABSENT",
    sentry: "PRESENT",
  });
});

test("provenance CLI reports a synthetic APK with the mandated fields only", () => {
  const dir = mkdtempSync(join(tmpdir(), "findback-provenance-"));
  try {
    writeFileSync(join(dir, "payload.txt"), "not a real apk");
    const apk = join(dir, "app-signeddev.apk");
    assert.equal(spawnSync("zip", ["-q", "-j", apk, join(dir, "payload.txt")]).status, 0);
    const result = spawnSync(process.execPath,
      [resolve("scripts/check-signeddev-config.mjs"), "--provenance", "--apk", apk],
      { encoding: "utf8", env: { ...process.env, ...baseEnv } });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(report).sort(), [...PROVENANCE_FIELDS].sort());
    assert.equal(report.package, "com.findback.app");
    assert.match(report.apkSha256, /^[0-9a-f]{64}$/);
    // No SDK here: fingerprint degrades honestly instead of inventing one.
    assert.ok(report.signerFingerprint === "UNAVAILABLE" || /^[0-9A-F]{64}$/.test(report.signerFingerprint));
    assert.doesNotMatch(result.stdout + result.stderr, /sb_publishable_|123456789012/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("provenance refuses a missing APK instead of inventing a report", () => {
  const result = spawnSync(process.execPath,
    [resolve("scripts/check-signeddev-config.mjs"), "--provenance", "--apk", join(tmpdir(), "no-such.apk")],
    { encoding: "utf8", env: { ...process.env, ...baseEnv } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /APK not found/);
});
