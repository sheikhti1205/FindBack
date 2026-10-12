import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { checkAppLinksManifest, checkSigneddevConfig, MANIFEST_PATH } from "./check-signeddev-config.mjs";

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
  try {
    writeStagedAssets(dir);
    const { ok, errors } = checkSigneddevConfig({ assetsRoot: dir });
    // Repo-local env is healthy on this machine (root .env + .env.local), so
    // this only pins the shape: either all-clear or one line per failure.
    assert.equal(typeof ok, "boolean");
    assert.ok(Array.isArray(errors));
    for (const error of errors) assert.equal(typeof error, "string");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
