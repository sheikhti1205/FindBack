import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { effectiveSupabaseConfig } from "./check-mobile-build-config.mjs";

const script = resolve("scripts/check-mobile-build-config.mjs");
const url = "https://sampleproject.supabase.co";
const key = "sb_publishable_abcdefghijklmnopqrstuvwxyz";
const dsn = "https://abcdef123456@o123.ingest.sentry.io/123";

function run(args, env = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      VITE_SUPABASE_URL: "",
      VITE_SUPABASE_PUBLISHABLE_KEY: "",
      SUPABASE_URL: "",
      SUPABASE_PUBLISHABLE_KEY: "",
      VITE_SENTRY_DSN: dsn,
      ...env,
    },
  });
}

test("preflight rejects a build without a Supabase URL even if Sentry is present", () => {
  const result = run(["--preflight"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /VITE_SUPABASE_URL/);
});

test("preflight derives local public values from the canonical Supabase env source", () => {
  const dir = mkdtempSync(join(tmpdir(), "findback-canonical-env-"));
  try {
    writeFileSync(join(dir, ".env.production"),
      `SUPABASE_URL=${url}\nSUPABASE_PUBLISHABLE_KEY=${key}\nVITE_SUPABASE_URL=\nVITE_SUPABASE_PUBLISHABLE_KEY=\n`);
    assert.equal(effectiveSupabaseConfig("production", dir).host, "sampleproject.supabase.co");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("preflight rejects a secret-shaped publishable key without printing its value", () => {
  // Assembled at runtime, never as a source literal: `npm run scan:secrets`
  // fails the repo on `sb_secret_<chars>`, and a committed canary would be
  // exactly the shape the scan exists to reject. Same construction the scan
  // itself uses. Behaviour is unchanged — still a real secret-shaped key.
  const secret = ["sb", "secret"].join("_") + "_keep-this-out-of-logs";
  const result = run(["--preflight"], {
    VITE_SUPABASE_URL: url,
    VITE_SUPABASE_PUBLISHABLE_KEY: secret,
  });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stderr + result.stdout, /keep-this-out-of-logs/);
});

test("installable assets reject the exact CI failure: Sentry present, Supabase absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "findback-bundle-gate-"));
  try {
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "assets", "index-test.js"), `const dsn="o123.ingest.sentry.io";`);
    const result = run(["--assets", join(dir, "assets")], {
      VITE_SUPABASE_URL: url,
      VITE_SUPABASE_PUBLISHABLE_KEY: key,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Supabase URL missing from assets/);

    writeFileSync(join(dir, "assets", "index-test.js"),
      `const u="${url}",k="${key}",dsn="o123.ingest.sentry.io";`);
    const good = run(["--assets", join(dir, "assets")], {
      VITE_SUPABASE_URL: url,
      VITE_SUPABASE_PUBLISHABLE_KEY: key,
    });
    assert.equal(good.status, 0, good.stderr);
    assert.doesNotMatch(good.stdout, /sb_publishable_/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("final APK gate examines packaged JavaScript, not the build directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "findback-apk-gate-"));
  const assets = join(dir, "assets", "public", "assets");
  const apk = join(dir, "test.apk");
  try {
    mkdirSync(assets, { recursive: true });
    const js = join(assets, "index-test.js");
    writeFileSync(js, `const dsn="o123.ingest.sentry.io";`);
    const pack = () => spawnSync("zip", ["-q", "-r", "-FS", apk, "assets"], { cwd: dir });
    assert.equal(pack().status, 0);
    const env = { VITE_SUPABASE_URL: url, VITE_SUPABASE_PUBLISHABLE_KEY: key };
    const missing = run(["--apk", apk], env);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /Supabase URL missing from APK/);

    writeFileSync(js, `const u="${url}",k="${key}",dsn="o123.ingest.sentry.io";`);
    assert.equal(pack().status, 0);
    const valid = run(["--apk", apk], env);
    assert.equal(valid.status, 0, valid.stderr);
    assert.doesNotMatch(valid.stdout, /sb_publishable_/);
    const wrongKey = run(["--apk", apk], { ...env, VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_a_different_project_key" });
    assert.notEqual(wrongKey.status, 0);
    assert.match(wrongKey.stderr, /publishable key missing from APK/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
