#!/usr/bin/env node
// X6 — auth/callback configuration contract (web Google OAuth + recovery).
//
// Two halves:
//   1. Environment: the values a web build needs for browser auth (Supabase
//      URL + publishable key + share origin). Reuses the mobile build-config
//      rules so a placeholder or secret key fails here too.
//   2. Source: the invariants that make the external callback bridge safe and
//      coherent (allowlisted paths, one PKCE strategy, no Google web client
//      secret, no Firebase Auth). Static — never reads credentials, never
//      prints values.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { effectiveSupabaseConfig } from "./check-mobile-build-config.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  throw new Error(`check-auth-config: ${message}`);
}

/**
 * Verify the source-level auth contract. Returns the list of violations
 * (empty = pass). Values in messages are file paths and symbols only.
 */
export function checkAuthSourceContracts(baseDir = root) {
  const violations = [];
  const read = (rel) => readFileSync(join(baseDir, rel), "utf8");

  const redirect = read("apps/mobile/src/utils/authRedirect.ts");
  if (!/AUTH_CALLBACK_PATH\s*=\s*"\/auth\/callback"/.test(redirect)) {
    violations.push("authRedirect.ts must define AUTH_CALLBACK_PATH = /auth/callback");
  }
  if (!/RECOVERY_PATH\s*=\s*"\/recovery"/.test(redirect)) {
    violations.push("authRedirect.ts must define RECOVERY_PATH = /recovery");
  }
  if (!/isAllowedAuthOrigin/.test(redirect)) {
    violations.push("authRedirect.ts must expose an origin allowlist check");
  }

  const entry = read("apps/mobile/src/utils/externalAuthEntry.ts");
  if (!/isAllowedAuthOrigin/.test(entry)) {
    violations.push("externalAuthEntry.ts must validate origins via isAllowedAuthOrigin");
  }
  if (!/replaceState/.test(entry)) {
    violations.push("externalAuthEntry.ts must strip the credential-bearing query with replaceState");
  }

  const google = read("apps/mobile/src/services/auth/googleSignIn.ts");
  if (!/signInWithOAuth/.test(google)) {
    violations.push("googleSignIn.ts must start the browser flow with signInWithOAuth");
  }
  if (!/signInWithIdToken/.test(google)) {
    violations.push("googleSignIn.ts must keep the native signInWithIdToken path");
  }
  if (!/resolveCurrentGoogleSessionOutcome|resolveOutcomeForCurrentSession/.test(google)) {
    violations.push("googleSignIn.ts must resolve both entry points through one shared resolver");
  }
  if (/client_secret|GOOGLE_WEB_CLIENT_SECRET/i.test(google)) {
    violations.push("googleSignIn.ts must not reference a Google web client secret");
  }
  if (/firebase/i.test(google)) {
    violations.push("googleSignIn.ts must not introduce Firebase Auth");
  }

  const client = read("apps/mobile/src/services/supabaseClient.ts");
  if (!/detectSessionInUrl\s*:\s*false/.test(client)) {
    violations.push("supabaseClient.ts must keep detectSessionInUrl: false (bridged manually)");
  }
  if (!/flowType\s*:\s*"pkce"/.test(client)) {
    violations.push("supabaseClient.ts must pin flowType: pkce (one explicit auth-code strategy)");
  }

  const main = read("apps/mobile/src/main.tsx");
  if (!/captureExternalAuthEntryFromWindow/.test(main)) {
    violations.push("main.tsx must call captureExternalAuthEntryFromWindow before the router mounts");
  }

  return violations;
}

export function checkAuthEnv(opts = {}) {
  const { mode = "production", envDir = root } = opts;
  const config = effectiveSupabaseConfig(mode, envDir);
  return { host: config.host, keyLen: config.key.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const violations = checkAuthSourceContracts();
    if (violations.length > 0) {
      for (const v of violations) console.error(`check-auth-config: ${v}`);
      process.exitCode = 1;
    } else if (process.argv.includes("--env")) {
      const { host, keyLen } = checkAuthEnv({ envDir: process.env.FINDBACK_ENV_DIR || root });
      console.log(`check-auth-config: PASS (source contracts + env; host=${host}; key_len=${keyLen})`);
    } else {
      console.log("check-auth-config: PASS (source contracts)");
    }
  } catch (error) {
    console.error(
      /^check-auth-config:/.test(error.message) ? error.message : "check-auth-config: cannot read auth sources",
    );
    process.exitCode = 1;
  }
}
