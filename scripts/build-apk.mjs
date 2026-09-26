#!/usr/bin/env node
/**
 * Cross-platform Android APK build for the Supabase-native app (Block 10K).
 *
 * Usage: set VITE_SENTRY_DSN for installable builds and either export
 * VITE_SUPABASE_URL/VITE_SUPABASE_PUBLISHABLE_KEY or use the canonical
 * SUPABASE_URL/SUPABASE_PUBLISHABLE_KEY in the ignored root .env.
 * Then run `npm run apk`.
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
import { effectiveSupabaseConfig } from "./check-mobile-build-config.mjs";

let config;
try {
  config = effectiveSupabaseConfig();
} catch {
  console.error("build-apk: refusing to build — valid VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY required (shell or root .env).");
  process.exit(1);
}
// Pass the exact validated values to all subprocesses; Vite's root envDir and
// the Android asset gate then compare against the same effective config.
process.env.VITE_SUPABASE_URL = config.url;
process.env.VITE_SUPABASE_PUBLISHABLE_KEY = config.key;

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

console.log(`build-apk: Supabase host = ${config.host}`);
console.log(`build-apk: Sentry = ${sentry.host} project=${sentry.projectId}`);
npm(["run", "build", "-w", "packages/shared"]);
npm(["run", "build", "-w", "apps/mobile"]);
npm(["run", "apk", "-w", "apps/mobile"]);
