import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  CANONICAL_RELEASE_SHA1,
  GOOGLE_ANDROID_PACKAGE,
  checkAndroidPackageAlignment,
  checkGoogleBuildWiring,
  effectiveGoogleConfig,
  requireGoogleConfig,
  validateGoogleClientId,
  verifyApkGoogleBake,
} from "./check-google-config.mjs";

const script = resolve("scripts/check-google-config.mjs");
const web = "961478941021-samplewebclient0000000000000.apps.googleusercontent.com";

test("rejects missing and malformed client IDs", () => {
  assert.equal(validateGoogleClientId("").ok, false);
  assert.equal(validateGoogleClientId("not-a-client-id").ok, false);
  assert.equal(validateGoogleClientId("961478941021-x.apps.googleusercontent.com").ok, false);
});

test("accepts a well-formed web OAuth client ID", () => {
  const result = validateGoogleClientId(web);
  assert.equal(result.ok, true);
  assert.equal(result.clientId, web);
});

test("shell export wins over root .env", () => {
  const dir = mkdtempSync(join(tmpdir(), "findback-google-env-"));
  try {
    writeFileSync(join(dir, ".env.production"), "GOOGLE_WEB_CLIENT_ID=from-file.apps.googleusercontent.com\n");
    const saved = process.env.GOOGLE_WEB_CLIENT_ID;
    process.env.GOOGLE_WEB_CLIENT_ID = web;
    try {
      assert.equal(effectiveGoogleConfig(dir).clientId, web);
    } finally {
      if (saved === undefined) delete process.env.GOOGLE_WEB_CLIENT_ID;
      else process.env.GOOGLE_WEB_CLIENT_ID = saved;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI reports MISSING without failing and never prints a secret-shaped value", () => {
  const result = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: { ...process.env, GOOGLE_WEB_CLIENT_ID: "", FINDBACK_ENV_DIR: tmpdir() },
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /MISSING/);
});

test("refuses secret-shaped material outright (never required, never baked)", () => {
  assert.equal(validateGoogleClientId("GOCSPX-testsecretvalue123456").ok, false);
  assert.equal(validateGoogleClientId("GOCSPX-testsecretvalue123456").reason, "secret_material");
  assert.equal(validateGoogleClientId('{"client_secret":"x"}').ok, false);
  // Default CLI treats secret-shaped as a hard failure, not a silent skip.
  const result = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: { ...process.env, GOOGLE_WEB_CLIENT_ID: "GOCSPX-testsecretvalue123456", FINDBACK_ENV_DIR: tmpdir() },
  });
  assert.equal(result.status, 1);
});

test("requireGoogleConfig fails closed unless PROVIDED", () => {
  const dir = mkdtempSync(join(tmpdir(), "findback-google-require-"));
  try {
    assert.throws(() => requireGoogleConfig(dir), /GOOGLE_WEB_CLIENT_ID missing/);
    const saved = process.env.GOOGLE_WEB_CLIENT_ID;
    process.env.GOOGLE_WEB_CLIENT_ID = web;
    try {
      assert.equal(requireGoogleConfig(dir), web);
    } finally {
      if (saved === undefined) delete process.env.GOOGLE_WEB_CLIENT_ID;
      else process.env.GOOGLE_WEB_CLIENT_ID = saved;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI --require exits non-zero when the ID is missing", () => {
  const result = spawnSync(process.execPath, [script, "--require"], {
    encoding: "utf8",
    env: { ...process.env, GOOGLE_WEB_CLIENT_ID: "", FINDBACK_ENV_DIR: tmpdir() },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /FAIL/);
});

test("checkGoogleBuildWiring proves the env→BuildConfig→bridge seam", () => {
  const read = (path) => {
    if (path.endsWith("build.gradle")) {
      return 'def googleWebClientId = System.getenv("GOOGLE_WEB_CLIENT_ID") ?: ""\nbuildConfigField "String", "GOOGLE_WEB_CLIENT_ID", "x"';
    }
    if (path.endsWith("GoogleAuthPlugin.java")) {
      return "String id = BuildConfig.GOOGLE_WEB_CLIENT_ID;";
    }
    throw new Error(`unexpected ${path}`);
  };
  assert.equal(checkGoogleBuildWiring({ read }).ok, true);

  const missingEnv = (path) =>
    path.endsWith("build.gradle")
      ? 'buildConfigField "String", "GOOGLE_WEB_CLIENT_ID", "x"'
      : "String id = BuildConfig.GOOGLE_WEB_CLIENT_ID;";
  assert.match(checkGoogleBuildWiring({ read: missingEnv }).errors.join(";"), /env/);

  const hardcoded = (path) =>
    path.endsWith("build.gradle")
      ? `${missingEnv(path)}\n// 961478941021-samplewebclient0000000000000.apps.googleusercontent.com`
      : "String id = BuildConfig.GOOGLE_WEB_CLIENT_ID;";
  assert.match(checkGoogleBuildWiring({ read: hardcoded }).errors.join(";"), /hard-codes/);
});

test("checkAndroidPackageAlignment pins the canonical package", () => {
  assert.equal(GOOGLE_ANDROID_PACKAGE, "com.findback.app");
  assert.match(CANONICAL_RELEASE_SHA1, /^([0-9A-F]{2}:){19}[0-9A-F]{2}$/);
  const read = () => 'namespace = "com.findback.app"\napplicationId "com.findback.app"';
  assert.equal(checkAndroidPackageAlignment({ read }).ok, true);
  const wrong = () => 'namespace = "com.example.other"\napplicationId "com.example.other"';
  assert.equal(checkAndroidPackageAlignment({ read: wrong }).ok, false);
});

test("verifyApkGoogleBake fails closed on every misconfiguration", () => {
  const dexWith = (text) => Buffer.from(`(ImageViewClassInfo ${text} BuildConfig)`, "utf8");
  const goodDex = dexWith(web);
  const noApk = verifyApkGoogleBake("/nonexistent/app.apk", { clientId: web });
  assert.equal(noApk.ok, false);

  const missing = verifyApkGoogleBake(script, {
    clientId: web,
    dexBytes: dexWith("no google here"),
    signerSha1: "00".repeat(20),
  });
  assert.deepEqual(missing.errors, ["google-client-missing"]);

  const mismatch = verifyApkGoogleBake(script, {
    clientId: web,
    dexBytes: dexWith("111111111111-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.apps.googleusercontent.com"),
    signerSha1: "00".repeat(20),
  });
  assert.deepEqual(mismatch.errors, ["google-client-missing"]);

  const ambiguous = verifyApkGoogleBake(script, {
    clientId: web,
    dexBytes: dexWith(`${web} and 222222222222-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.apps.googleusercontent.com`),
    signerSha1: "00".repeat(20),
  });
  assert.deepEqual(ambiguous.errors, ["google-client-ambiguous"]);

  const secret = verifyApkGoogleBake(script, {
    clientId: web,
    dexBytes: dexWith(`${web} GOCSPX-leakedsecret`),
    signerSha1: "00".repeat(20),
  });
  assert.deepEqual(secret.errors, ["secret-shaped"]);

  const badSigner = verifyApkGoogleBake(script, {
    clientId: web,
    dexBytes: goodDex,
    signerSha1: "00".repeat(20),
  });
  assert.deepEqual(badSigner.errors, ["signer-mismatch"]);

  const unverified = verifyApkGoogleBake(script, {
    clientId: web,
    dexBytes: goodDex,
    signerSha1: "UNAVAILABLE",
  });
  assert.deepEqual(unverified.errors, ["signer-unverified"]);

  const good = verifyApkGoogleBake(script, {
    clientId: web,
    dexBytes: goodDex,
    signerSha1: CANONICAL_RELEASE_SHA1.replaceAll(":", ""),
  });
  assert.equal(good.ok, true);
});
