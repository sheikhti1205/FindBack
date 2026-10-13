import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { checkAuthSourceContracts } from "./check-auth-config.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(root, "scripts", "check-auth-config.mjs");

// Mirror the real source subset the checker reads into a temp tree.
function writeSources(dir, overrides = {}) {
  const files = {
    "apps/mobile/src/utils/authRedirect.ts": [
      'export const AUTH_CALLBACK_PATH = "/auth/callback";',
      'export const RECOVERY_PATH = "/recovery";',
      "export function isAllowedAuthOrigin(origin: string) { return !!origin; }",
    ].join("\n"),
    "apps/mobile/src/utils/externalAuthEntry.ts": [
      'import { isAllowedAuthOrigin } from "./authRedirect";',
      "export function capture(w: Window) { w.history.replaceState(null, '', '/'); return isAllowedAuthOrigin('x'); }",
    ].join("\n"),
    "apps/mobile/src/services/auth/googleSignIn.ts": [
      "export async function a() { return supabase.auth.signInWithOAuth({ provider: 'google' }); }",
      "export async function b(t: string, n: string) { return supabase.auth.signInWithIdToken({ provider: 'google', token: t, nonce: n }); }",
      "export async function resolveCurrentGoogleSessionOutcome() {}",
    ].join("\n"),
    "apps/mobile/src/services/supabaseClient.ts": [
      'createClient(url, key, { auth: { detectSessionInUrl: false, flowType: "pkce" } });',
    ].join("\n"),
    "apps/mobile/src/main.tsx": [
      'import { captureExternalAuthEntryFromWindow } from "./utils/externalAuthEntry";',
      "captureExternalAuthEntryFromWindow();",
    ].join("\n"),
  };
  for (const [rel, content] of Object.entries({ ...files, ...overrides })) {
    const path = join(dir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return dir;
}

test("the real auth sources satisfy the contract", () => {
  assert.deepEqual(checkAuthSourceContracts(root), []);
});

test("the contract catches a missing callback path and origin check", () => {
  const dir = mkdtempSync(join(tmpdir(), "findback-authcfg-"));
  try {
    writeSources(dir, {
      "apps/mobile/src/utils/authRedirect.ts": 'export const RECOVERY_PATH = "/recovery";',
    });
    const violations = checkAuthSourceContracts(dir);
    assert.ok(violations.some((v) => /AUTH_CALLBACK_PATH/.test(v)));
    assert.ok(violations.some((v) => /origin allowlist/.test(v)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the contract rejects a Google web client secret or Firebase Auth", () => {
  const dir = mkdtempSync(join(tmpdir(), "findback-authcfg-secret-"));
  try {
    writeSources(dir, {
      "apps/mobile/src/services/auth/googleSignIn.ts": [
        "const GOOGLE_WEB_CLIENT_SECRET = 'x';",
        "firebase.auth().signInWithPopup();",
      ].join("\n"),
    });
    const violations = checkAuthSourceContracts(dir);
    assert.ok(violations.some((v) => /client secret/.test(v)));
    assert.ok(violations.some((v) => /Firebase/.test(v)));
    assert.ok(violations.some((v) => /signInWithOAuth|signInWithIdToken|shared resolver/.test(v)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the contract requires one PKCE strategy and a manual session bridge", () => {
  const dir = mkdtempSync(join(tmpdir(), "findback-authcfg-pkce-"));
  try {
    writeSources(dir, {
      "apps/mobile/src/services/supabaseClient.ts": "createClient(url, key, { auth: {} });",
      "apps/mobile/src/main.tsx": "const x = 1;",
    });
    const violations = checkAuthSourceContracts(dir);
    assert.ok(violations.some((v) => /detectSessionInUrl/.test(v)));
    assert.ok(violations.some((v) => /flowType/.test(v)));
    assert.ok(violations.some((v) => /captureExternalAuthEntryFromWindow/.test(v)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the CLI passes on the real tree and never prints credential values", () => {
  const result = spawnSync("node", [SCRIPT], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /check-auth-config: PASS/);
  assert.doesNotMatch(result.stdout + result.stderr, /sb_secret_|service_role|client_secret/i);
});

test("the source checker never reads or prints any credential file", () => {
  const source = readFileSync(SCRIPT, "utf8");
  assert.doesNotMatch(source, /sb_secret_|service_role/);
  assert.doesNotMatch(source, /Downloads|key\.txt/i);
});
