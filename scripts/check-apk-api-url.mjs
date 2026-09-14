#!/usr/bin/env node
/**
 * Preflight guard for Android APK builds.
 *
 * Fails (exit 1) unless VITE_API_URL is set to a reachable http(s) base URL.
 * This prevents silently shipping a device APK that points at
 * `http://localhost:4000` — which on a phone means the phone itself.
 *
 * Run by the `apps/mobile` `apk` script and by `scripts/build-apk.mjs`.
 */
const ALLOW_LOCALHOST = process.env.APK_ALLOW_LOCALHOST === "1";

let resolveApkApiUrl;
try {
  ({ resolveApkApiUrl } = await import("@findback/shared"));
} catch {
  console.error(
    "apk-preflight: could not load @findback/shared. Run `npm run build -w packages/shared` first.",
  );
  process.exit(1);
}

const result = resolveApkApiUrl(process.env.VITE_API_URL, { allowLocalhost: ALLOW_LOCALHOST });
if (!result.ok) {
  console.error(`apk-preflight: ${result.error}`);
  console.error("");
  console.error("Provide a reachable API base for the APK, for example:");
  console.error("  Android emulator : VITE_API_URL=http://10.0.2.2:4000   (or: npm run apk:emulator)");
  console.error("  Physical phone   : VITE_API_URL=http://<computer-LAN-IP>:4000");
  console.error("");
  console.error("`localhost`/`127.0.0.1` is rejected because it resolves to the device itself.");
  process.exit(1);
}

console.log(`apk-preflight: API base = ${result.url}`);
