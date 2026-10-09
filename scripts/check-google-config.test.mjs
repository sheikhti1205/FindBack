import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { effectiveGoogleConfig, validateGoogleClientId } from "./check-google-config.mjs";

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
