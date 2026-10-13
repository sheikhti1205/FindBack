#!/usr/bin/env node
/**
 * Tests for the hard Google gate in scripts/check-release-config.mjs
 * (SYNC-3/10/11, SYNC0-D06).
 *
 * Run: `node --test scripts/check-release-config.test.mjs` from repo root.
 * Hermetic: pure validators plus CLI failure branches that exit before the
 * network health check (no network). All fixtures are synthetic; only names
 * appear, never secret values. Importing the preflight runs nothing (main is
 * guarded), so these tests never touch the live project health endpoint.
 */
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import {
  GOOGLE_SECRET_ENV_NAMES,
  checkPackagedGoogleText,
  isSecretShapedGoogleValue,
  readApkDexText,
  validateReleaseGoogleConfig,
} from "./check-release-config.mjs";

const script = resolve("scripts/check-release-config.mjs");
const WEB_CLIENT = "123456789012-abcdefghijklmnop.apps.googleusercontent.com";
const URL = "https://sampleproject.supabase.co";
const KEY = "sb_publishable_abcdefghijklmnopqrstuvwxyz";
const DSN = "https://abcdef123456@o123.ingest.sentry.io/123";
const SHARE = "https://findback.test";

/** CLI env with every non-Google gate satisfied; Google varied per test. */
function cliEnv(overrides = {}) {
  return {
    ...process.env,
    VITE_SUPABASE_URL: URL,
    VITE_SUPABASE_PUBLISHABLE_KEY: KEY,
    VITE_PUBLIC_SHARE_ORIGIN: SHARE,
    VITE_SENTRY_DSN: DSN,
    GOOGLE_WEB_CLIENT_ID: WEB_CLIENT,
    GOOGLE_CLIENT_SECRET: "",
    GOOGLE_WEB_CLIENT_SECRET: "",
    FINDBACK_ENV_DIR: mkdtempSync(join(tmpdir(), "findback-release-env-")),
    ...overrides,
  };
}

function runCli(args, env) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env });
  try {
    rmSync(env.FINDBACK_ENV_DIR, { recursive: true, force: true });
  } catch {
    // Best-effort temp cleanup only.
  }
  return result;
}

test("well-formed Web client IDs pass; missing and malformed fail closed", () => {
  assert.deepEqual(validateReleaseGoogleConfig({ clientId: WEB_CLIENT, env: {} }), {
    ok: true,
    clientId: WEB_CLIENT,
  });
  assert.equal(validateReleaseGoogleConfig({ clientId: "", env: {} }).reason, "missing");
  assert.equal(validateReleaseGoogleConfig({ env: {} }).reason, "missing");
  for (const bad of ["not-a-client-id", "12345-x.apps.googleusercontent.com", "https://example.com"]) {
    const result = validateReleaseGoogleConfig({ clientId: bad, env: {} });
    assert.equal(result.ok, false, `expected reject: ${bad}`);
    assert.equal(result.reason, "malformed");
  }
});

test("client-secret shapes are refused and a secret is never required", () => {
  // The actual Google client-secret prefix plus generic secret shapes.
  for (const bad of [
    "GOCSPX-fixture-secret-material",
    "gocspx-fixture-secret-material",
    "my-secret-value",
    '{"type":"service_account"}',
    "ya29.fixture-access-token",
    "123456789012-abc def.apps.googleusercontent.com",
  ]) {
    assert.equal(isSecretShapedGoogleValue(bad), true, `expected secret-shaped: ${bad}`);
    assert.equal(validateReleaseGoogleConfig({ clientId: bad, env: {} }).reason, "secret-shaped");
  }
  assert.equal(isSecretShapedGoogleValue(WEB_CLIENT), false);
  assert.equal(isSecretShapedGoogleValue(""), false);
  // The gate passes with no secret anywhere: none is ever required.
  assert.deepEqual(GOOGLE_SECRET_ENV_NAMES, ["GOOGLE_CLIENT_SECRET", "GOOGLE_WEB_CLIENT_SECRET"]);
  assert.ok(validateReleaseGoogleConfig({ clientId: WEB_CLIENT, env: {} }).ok);
});

test("any value in a GOOGLE_*_SECRET env var fails closed naming the var only", () => {
  for (const name of GOOGLE_SECRET_ENV_NAMES) {
    const result = validateReleaseGoogleConfig({ clientId: WEB_CLIENT, env: { [name]: "fixture-value" } });
    assert.equal(result.ok, false);
    assert.match(result.reason, new RegExp(`client-secret-env:${name}`));
    assert.ok(!JSON.stringify(result).includes("fixture-value"), "secret value leaked");
  }
});

test("CLI refuses a malformed Google client ID before any network call", () => {
  const result = runCli([], cliEnv({ GOOGLE_WEB_CLIENT_ID: "not-a-client-id" }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /GOOGLE_WEB_CLIENT_ID malformed/);
});

test("CLI refuses a missing Google client ID with an isolated env root", () => {
  const result = runCli([], cliEnv({ GOOGLE_WEB_CLIENT_ID: "" }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /GOOGLE_WEB_CLIENT_ID missing/);
});

test("CLI refuses client-secret material without printing it", () => {
  const secret = "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-print";
  let result = runCli([], cliEnv({ GOOGLE_WEB_CLIENT_ID: secret }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /secret-shaped/);
  assert.ok(!(result.stderr + result.stdout).includes(secret));

  result = runCli([], cliEnv({ GOOGLE_CLIENT_SECRET: "fixture-secret-value" }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /client-secret-env:GOOGLE_CLIENT_SECRET/);
  assert.ok(!(result.stderr + result.stdout).includes("fixture-secret-value"));
});

test("checkPackagedGoogleText proves a non-empty BuildConfig and refuses secrets", () => {
  assert.deepEqual(checkPackagedGoogleText(`field ${WEB_CLIENT} end`, { clientId: WEB_CLIENT }), { ok: true });
  assert.equal(checkPackagedGoogleText("no google strings here", { clientId: WEB_CLIENT }).reason, "google-client-missing");
  assert.equal(
    checkPackagedGoogleText(`field ${WEB_CLIENT} GOCSPX-fixture`, { clientId: WEB_CLIENT }).reason,
    "secret-shaped",
  );
  const other = "999999999999-zzzzzzzzzzzzzzzz.apps.googleusercontent.com";
  assert.equal(
    checkPackagedGoogleText(`field ${other} end`, { clientId: WEB_CLIENT }).reason,
    "client-mismatch",
  );
  // Without an expected value any well-formed packaged ID passes (non-empty proof).
  assert.ok(checkPackagedGoogleText(`field ${other} end`).ok);
});

test("readApkDexText round-trips a real APK's dex through unzip", () => {
  const dir = mkdtempSync(join(tmpdir(), "findback-release-apk-"));
  try {
    const dex = join(dir, "classes.dex");
    writeFileSync(dex, `BuildConfig GOOGLE_WEB_CLIENT_ID=${WEB_CLIENT} end`);
    const apk = join(dir, "app.apk");
    assert.equal(spawnSync("zip", ["-q", "-j", apk, dex]).status, 0);
    const text = readApkDexText(apk);
    assert.ok(text.includes(WEB_CLIENT));
    assert.ok(checkPackagedGoogleText(text, { clientId: WEB_CLIENT }).ok);

    const empty = join(dir, "empty.apk");
    writeFileSync(join(dir, "note.txt"), "no dex here");
    assert.equal(spawnSync("zip", ["-q", "-j", empty, join(dir, "note.txt")]).status, 0);
    assert.throws(() => readApkDexText(empty), /no classes dex/);
    assert.throws(() => readApkDexText(join(dir, "missing.apk")), /cannot inspect APK/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI --apk refuses an artifact whose BuildConfig lacks the client ID", () => {
  const dir = mkdtempSync(join(tmpdir(), "findback-release-cli-apk-"));
  try {
    const dex = join(dir, "classes.dex");
    writeFileSync(dex, "BuildConfig GOOGLE_WEB_CLIENT_ID= end");
    const apk = join(dir, "app.apk");
    assert.equal(spawnSync("zip", ["-q", "-j", apk, dex]).status, 0);
    const result = runCli(["--apk", apk], cliEnv());
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /packaged GOOGLE_WEB_CLIENT_ID google-client-missing/);
    assert.ok(!(result.stderr + result.stdout).includes(KEY));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("release.yml invokes the preflight with no --apk flag (env-gate parity)", () => {
  const yml = execFileSync("git", ["show", "HEAD:.github/workflows/release.yml"], { encoding: "utf8" });
  assert.match(yml, /run: node scripts\/check-release-config\.mjs/);
});
