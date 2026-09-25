#!/usr/bin/env node
/**
 * Cross-platform Android APK build for the Supabase-native app (Block 10K).
 *
 * Usage:
 *   VITE_SUPABASE_URL=https://<ref>.supabase.co \
 *   VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_... \
 *   VITE_SENTRY_DSN=https://<key>@<host>/<project-id> \
 *   npm run apk
 *
 * Only the public Supabase URL + publishable key are baked into the bundle. No
 * API base URL is needed — the app talks exclusively to hosted Supabase (Auth /
 * Data API / Realtime / Storage / Edge Functions). The secret key must never be
 * provided here.
 *
 * Sentry is MANDATORY for installable builds: the preflight below fails closed
 * when no real VITE_SENTRY_DSN is visible. Local env contract: the DSN is
 * embedded from shell exports (highest precedence) or apps/mobile/.env* files
 * (import.meta.env, envDir apps/mobile). A VITE_SENTRY_DSN in the repo-root
 * .env is NOT embedded — root .env only feeds the Supabase `define`s.
 */
import { spawnSync } from "node:child_process";
import { checkEffectiveSentryDsn } from "./check-sentry-config.mjs";

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const publishableKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!supabaseUrl || !publishableKey) {
  console.error(
    "build-apk: set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY (publishable key only).",
  );
  process.exit(1);
}
if (/service_role|sb_secret_/i.test(publishableKey)) {
  console.error("build-apk: refusing to build — that looks like a secret key, not a publishable key.");
  process.exit(1);
}

// Sentry is mandatory for installable builds. Resolved with Vite's own
// loadEnv against apps/mobile (the SAME source vite build embeds into
// import.meta.env); shell exports win over apps/mobile/.env* files.
const sentry = checkEffectiveSentryDsn({ mode: "production" });
if (!sentry.ok) {
  console.error(
    `build-apk: refusing to build — VITE_SENTRY_DSN ${sentry.reason} ` +
      "(export a real https DSN or provide apps/mobile/.env.production).",
  );
  process.exit(1);
}

const npm = (args) => {
  const result = spawnSync("npm", args, {
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

console.log(`build-apk: Supabase = ${supabaseUrl}`);
console.log(`build-apk: Sentry = ${sentry.host} project=${sentry.projectId}`);
npm(["run", "build", "-w", "packages/shared"]);
npm(["run", "build", "-w", "apps/mobile"]);
npm(["run", "apk", "-w", "apps/mobile"]);
