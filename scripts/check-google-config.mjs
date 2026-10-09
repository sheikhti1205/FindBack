#!/usr/bin/env node
/**
 * Google Sign-In build configuration seam (W0).
 *
 * The Android Credential Manager Google-ID audience is the WEB/server OAuth
 * client ID (NOT the Android client ID). It reaches the APK only through
 * `BuildConfig.GOOGLE_WEB_CLIENT_ID`, which the Gradle build reads from the
 * `GOOGLE_WEB_CLIENT_ID` environment variable (see app/build.gradle).
 *
 * This module is the single validator/loader for that value so every local
 * build path (scripts/build-apk.mjs, CI, manual) uses the same rule:
 *   - shell export wins; otherwise the ignored root .env is consulted;
 *   - the value must look like a Web OAuth client ID;
 *   - a client SECRET is never accepted here (this value is public, but we
 *     still refuse obviously-secret material to avoid a wrong paste).
 *
 * Missing value is NOT a build failure: the app is fail-closed at runtime
 * (Google sign-in stays hidden/disabled). `requireGoogleConfig` lets signed
 * device-acceptance builds opt into a hard requirement instead.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WEB_CLIENT_ID = /^[0-9]{6,}-[a-z0-9_-]{6,}\.apps\.googleusercontent\.com$/i;

export function validateGoogleClientId(value) {
  const clientId = (value ?? "").trim();
  if (!clientId) return { ok: false, reason: "missing" };
  if (!WEB_CLIENT_ID.test(clientId)) return { ok: false, reason: "malformed" };
  return { ok: true, clientId };
}

/** Shell export wins; then root .env `GOOGLE_WEB_CLIENT_ID`. */
export function effectiveGoogleConfig(envDir = root) {
  const env = loadEnv("production", envDir, "");
  const raw = (process.env.GOOGLE_WEB_CLIENT_ID ?? "").trim() || (env.GOOGLE_WEB_CLIENT_ID ?? "").trim();
  return validateGoogleClientId(raw);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = effectiveGoogleConfig(process.env.FINDBACK_ENV_DIR || root);
  if (result.ok) console.log(`check-google-config: PROVIDED (${result.clientId.length} chars)`);
  else {
    console.log(`check-google-config: MISSING or INVALID (${result.reason}) — Google sign-in stays fail-closed`);
    if (result.reason === "malformed") process.exitCode = 1;
  }
}
