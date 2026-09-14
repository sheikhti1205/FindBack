#!/usr/bin/env node
/**
 * Cross-platform Android APK build for the Supabase-native app (Block 10K).
 *
 * Usage:
 *   VITE_SUPABASE_URL=https://<ref>.supabase.co \
 *   VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_... \
 *   npm run apk
 *
 * Only the public Supabase URL + publishable key are baked into the bundle. No
 * API base URL is needed — the app talks exclusively to hosted Supabase (Auth /
 * Data API / Realtime / Storage / Edge Functions). The secret key must never be
 * provided here.
 */
import { spawnSync } from "node:child_process";

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

const npm = (args) => {
  const result = spawnSync("npm", args, {
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

console.log(`build-apk: Supabase = ${supabaseUrl}`);
npm(["run", "build", "-w", "packages/shared"]);
npm(["run", "build", "-w", "apps/mobile"]);
npm(["run", "apk", "-w", "apps/mobile"]);
