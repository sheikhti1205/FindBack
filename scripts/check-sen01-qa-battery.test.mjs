#!/usr/bin/env node
/**
 * Worker E (M2 QA/security) — SEN-01 negative battery, node:test harness.
 *
 * Drives the EXISTING gate scripts as a black box (no modifications):
 *  - scripts/check-mobile-build-config.mjs: effectiveSupabaseConfig,
 *    checkAssetDirectory, checkApk (+ --preflight subprocess for the
 *    secret-key rejection + no-credential-leak proof).
 *  - scripts/check-sentry-config.mjs: validateSentryDsn,
 *    checkEffectiveSentryDsn.
 *
 * All cases use isolated temp dirs + synthetic fixtures (key material
 * assembled at runtime so this file never contains a secret-shaped
 * literal). Nothing here depends on repo-root .env contents.
 *
 * Run: `node --test scripts/check-sen01-qa-battery.test.mjs`
 * (no vitest, no vite, no build — light enough to run without heavy.lock,
 * but E runs it under the lock alongside the vitest battery for ordering).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  checkApk,
  checkAssetDirectory,
  effectiveSupabaseConfig,
} from "./check-mobile-build-config.mjs";
import {
  checkEffectiveSentryDsn,
  validateSentryDsn,
} from "./check-sentry-config.mjs";

const URL = "https://sampleproject.supabase.co";
const KEY = "sb_publishable_abcdefghijklmnopqrstuvwxyz";
const DSN = "https://abcdef123456@o123.ingest.sentry.io/123";
const SECRET_PREFIX = ["sb", "secret"].join("_") + "_";

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function withDir(prefix, fn) {
  const dir = tempDir(prefix);
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function expectThrowWith(fn, pattern, label) {
  assert.throws(fn, (error) => {
    assert.match(String(error && error.message), pattern, label);
    // Failure messages must never echo key material.
    assert.doesNotMatch(String(error && error.message), /sb_secret_|sb_publishable_|eyJ/, `${label}: leak`);
    return true;
  }, label);
}

// --- Supabase preflight: missing / placeholder / secret / malformed -------

test("preflight fails closed when config is missing (isolated empty env dir)", () => {
  withDir("sen01-missing-", (dir) => {
    expectThrowWith(() => effectiveSupabaseConfig("production", dir), /VITE_SUPABASE_URL/, "missing url");
  });
});

test("preflight fails closed on placeholder URL and placeholder key", () => {
  withDir("sen01-placeholder-", (dir) => {
    writeFileSync(join(dir, ".env.production"), `VITE_SUPABASE_URL=test\nVITE_SUPABASE_PUBLISHABLE_KEY=${KEY}\n`);
    expectThrowWith(() => effectiveSupabaseConfig("production", dir), /VITE_SUPABASE_URL/, "placeholder url");
    writeFileSync(join(dir, ".env.production"), `VITE_SUPABASE_URL=${URL}\nVITE_SUPABASE_PUBLISHABLE_KEY=changeme\n`);
    expectThrowWith(() => effectiveSupabaseConfig("production", dir), /VITE_SUPABASE_PUBLISHABLE_KEY/, "placeholder key");
  });
});

test("preflight fails closed on secret keys (prefix + service_role JWT)", () => {
  withDir("sen01-secret-", (dir) => {
    writeFileSync(join(dir, ".env.production"), `VITE_SUPABASE_URL=${URL}\nVITE_SUPABASE_PUBLISHABLE_KEY=${SECRET_PREFIX}synthetic0001\n`);
    expectThrowWith(() => effectiveSupabaseConfig("production", dir), /secret key/, "sb_secret prefix");
    const payload = Buffer.from(JSON.stringify({ role: "service_role" })).toString("base64url");
    writeFileSync(join(dir, ".env.production"), `VITE_SUPABASE_URL=${URL}\nVITE_SUPABASE_PUBLISHABLE_KEY=synthetic.${payload}.synthetic\n`);
    expectThrowWith(() => effectiveSupabaseConfig("production", dir), /secret key/, "service_role jwt");
  });
});

test("preflight fails closed on malformed / non-Supabase / query-carrying URLs", () => {
  withDir("sen01-url-", (dir) => {
    for (const [label, url] of [
      ["not-a-url", "not-a-url"],
      ["http scheme", "http://sampleproject.supabase.co"],
      ["wrong host", "https://evil.test/"],
      ["query string", `${URL}/?token=x`],
      ["path", `${URL}/rest/v1/`],
    ]) {
      writeFileSync(join(dir, ".env.production"), `VITE_SUPABASE_URL=${url}\nVITE_SUPABASE_PUBLISHABLE_KEY=${KEY}\n`);
      expectThrowWith(() => effectiveSupabaseConfig("production", dir), /VITE_SUPABASE_URL/, label);
    }
  });
});

test("preflight passes on a synthetic bare project URL + publishable key (shapes only)", () => {
  withDir("sen01-positive-", (dir) => {
    writeFileSync(join(dir, ".env.production"), `VITE_SUPABASE_URL=${URL}\nVITE_SUPABASE_PUBLISHABLE_KEY=${KEY}\n`);
    const config = effectiveSupabaseConfig("production", dir);
    assert.equal(config.host, "sampleproject.supabase.co");
    assert.equal(config.url, URL);
    assert.equal(typeof config.key.length, "number");
  });
});

// --- Sentry DSN validation ---------------------------------------------------

test("validateSentryDsn: missing / malformed / placeholder fail; synthetic passes", () => {
  assert.deepEqual(validateSentryDsn(undefined), { ok: false, reason: "missing" });
  assert.deepEqual(validateSentryDsn("   "), { ok: false, reason: "missing" });
  assert.equal(validateSentryDsn("http://k@h/1").ok, false);
  assert.equal(validateSentryDsn("https:///1").ok, false);
  for (const dsn of [
    "https://test@o123.ingest.sentry.io/123",
    "https://abcdef123456@example/123",
    "https://abcdef123456@o123.ingest.sentry.io/test",
    "https://changeme@o123.ingest.sentry.io/123",
    "https://xxx@o123.ingest.sentry.io/123",
  ]) {
    assert.equal(validateSentryDsn(dsn).ok, false, `placeholder not rejected: ${dsn}`);
  }
  const good = validateSentryDsn(DSN);
  assert.equal(good.ok, true);
  assert.equal(good.host, "o123.ingest.sentry.io");
  assert.equal(good.projectId, "123");
});

test("checkEffectiveSentryDsn reads an isolated mobile env dir", () => {
  withDir("sen01-dsn-", (dir) => {
    assert.equal(checkEffectiveSentryDsn({ mode: "production", mobileDir: dir }).ok, false);
    writeFileSync(join(dir, ".env.production"), `VITE_SENTRY_DSN=${DSN}\n`);
    const good = checkEffectiveSentryDsn({ mode: "production", mobileDir: dir });
    assert.equal(good.ok, true);
  });
});

// --- Assets boundary ----------------------------------------------------------

test("checkAssetDirectory fails closed: empty dir, missing URL/key/host", () => {
  const config = { url: URL, key: KEY, host: "sampleproject.supabase.co" };
  const sentryHost = "o123.ingest.sentry.io";
  withDir("sen01-assets-empty-", (dir) => {
    assert.throws(() => checkAssetDirectory(dir, config, sentryHost), /no JavaScript assets/);
  });
  const matrix = [
    ["missing-url", `var k="${KEY}";var s="${sentryHost}";`, /Supabase URL/],
    ["missing-key", `var u="${URL}";var s="${sentryHost}";`, /publishable key/],
    ["missing-sentry", `var u="${URL}";var k="${KEY}";`, /Sentry DSN host/],
  ];
  for (const [name, js, pattern] of matrix) {
    withDir(`sen01-assets-${name}-`, (dir) => {
      writeFileSync(join(dir, "index-abc.js"), js);
      assert.throws(() => checkAssetDirectory(dir, config, sentryHost), pattern, name);
    });
  }
});

test("checkAssetDirectory passes when bundle carries URL + key + Sentry host", () => {
  const config = { url: URL, key: KEY, host: "sampleproject.supabase.co" };
  const previous = process.env.VITE_PUBLIC_SHARE_ORIGIN;
  const origin = "https://findback.test";
  process.env.VITE_PUBLIC_SHARE_ORIGIN = origin;
  try {
    withDir("sen01-assets-ok-", (dir) => {
      // Exercise the real share-origin gate with explicit synthetic config,
      // including in a clean checkout that has no local .env file.
      writeFileSync(join(dir, "index-abc.js"), `var u="${URL}";var k="${KEY}";var s="o123.ingest.sentry.io";var o="${origin}";`);
      checkAssetDirectory(dir, config, "o123.ingest.sentry.io");
    });
  } finally {
    if (previous === undefined) delete process.env.VITE_PUBLIC_SHARE_ORIGIN;
    else process.env.VITE_PUBLIC_SHARE_ORIGIN = previous;
  }
});

// --- APK boundary ---------------------------------------------------------------

test("checkApk fails closed on a missing/unreadable APK (never passes blind)", () => {
  const config = { url: URL, key: KEY, host: "sampleproject.supabase.co" };
  assert.throws(
    () => checkApk(join(tmpdir(), "sen01-does-not-exist.apk"), config, "o123.ingest.sentry.io"),
    /cannot inspect APK/,
  );
});

// --- Subprocess black box: --preflight rejects secrets without leaking -------

test("subprocess --preflight rejects an explicit secret key and never echoes it", () => {
  const script = resolve(dirname(fileURLToPath(import.meta.url)), "check-mobile-build-config.mjs");
  const canary = `${SECRET_PREFIX}syntheticE000000000000000000001`;
  const result = spawnSync(
    process.execPath,
    [script, "--preflight"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        VITE_SUPABASE_URL: URL,
        VITE_SUPABASE_PUBLISHABLE_KEY: canary,
        SUPABASE_URL: "",
        SUPABASE_PUBLISHABLE_KEY: "",
      },
    },
  );
  assert.notEqual(result.status, 0, "secret key must fail preflight");
  const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  assert.match(combined, /secret key/);
  assert.doesNotMatch(combined, new RegExp(canary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "stderr leaked key");
});
