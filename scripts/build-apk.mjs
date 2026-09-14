#!/usr/bin/env node
/**
 * Cross-platform Android APK build with an explicit, validated API base URL.
 *
 * Usage:
 *   VITE_API_URL=http://192.168.x.x:4000 npm run apk    # physical phone (LAN IP)
 *   npm run apk:emulator                                # Android emulator (10.0.2.2)
 *
 * Refuses to build when VITE_API_URL is missing or points at the device itself
 * (localhost / 127.0.0.1), unless APK_ALLOW_LOCALHOST=1 is set explicitly.
 */
import { spawnSync } from "node:child_process";

const emulator = process.argv.includes("--emulator");
const allowLocalhost = process.env.APK_ALLOW_LOCALHOST === "1";

const npm = (args, env) => {
  const result = spawnSync("npm", args, {
    stdio: "inherit",
    env,
    shell: process.platform === "win32",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

// Build the shared package first so @findback/shared resolves for validation.
npm(["run", "build", "-w", "packages/shared"], process.env);

const { resolveApkApiUrl } = await import("@findback/shared");

let apiUrl = process.env.VITE_API_URL;
if (!apiUrl && emulator) apiUrl = "http://10.0.2.2:4000";

const result = resolveApkApiUrl(apiUrl, { allowLocalhost });
if (!result.ok) {
  console.error(`build-apk: ${result.error}`);
  console.error("Set VITE_API_URL, or run `npm run apk:emulator` for the Android emulator.");
  process.exit(1);
}

console.log(`build-apk: API base = ${result.url}`);
const env = { ...process.env, VITE_API_URL: result.url };

npm(["run", "build", "-w", "apps/mobile"], env);
npm(["run", "apk", "-w", "apps/mobile"], env);
