#!/usr/bin/env node
/** Inspect the debug APK: forbidden weights, a real DEX/asset secret scan, 16 KiB alignment. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const strict = process.argv.includes("--strict");
const apkArg = process.argv.slice(2).find((a) => !a.startsWith("--"));
const apk = apkArg ?? "apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk";
if (!fs.existsSync(apk)) { console.error(`scan-apk: APK not found at ${apk}`); process.exit(1); }

const unzip = (args, opts = {}) => execFileSync("unzip", args, { maxBuffer: 256 * 1024 * 1024, ...opts });
const entries = unzip(["-Z1", apk]).toString("utf8").split("\n").filter(Boolean);

const useAsset = "assets/models/use/universal_sentence_encoder.tflite";
const forbidden = entries.filter((e) => /\.(litertlm|tflite)$/i.test(e) && e !== useAsset);
if (forbidden.length) { console.error(`scan-apk: forbidden model asset(s): ${forbidden.join(", ")}`); process.exit(1); }
if (strict) {
  if (!entries.includes(useAsset)) { console.error(`scan-apk: required USE asset missing: ${useAsset}`); process.exit(1); }
  for (const abi of ["arm64-v8a", "x86_64"]) {
    if (!entries.some((e) => e.startsWith(`lib/${abi}/liblitertlm`))) { console.error(`scan-apk: ${abi} litertlm JNI missing`); process.exit(1); }
  }
}

const secretPrefix = ["sb", "secret"].join("_") + "_";
const serviceRoleName = ["SUPABASE", "SERVICE", "ROLE", "KEY"].join("_");
const SECRETS = [new RegExp(`${secretPrefix}[A-Za-z0-9_-]+`), new RegExp(serviceRoleName), /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/];
const scanEntries = entries.filter((e) => /^classes\d*\.dex$/.test(e) || e.startsWith("assets/") || e.startsWith("res/raw/"));
const secretHits = [];
for (const entry of scanEntries) {
  const text = unzip(["-p", apk, entry]).toString("latin1");
  for (const pattern of SECRETS) if (pattern.test(text)) secretHits.push(`${entry}: ${pattern}`);
}
if (secretHits.length) { console.error(`scan-apk: embedded secret hit(s):\n${secretHits.join("\n")}`); process.exit(1); }

function resolveZipalign() {
  const roots = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT];
  const localProps = "apps/mobile/android/local.properties";
  if (fs.existsSync(localProps)) {
    const m = /sdk\.dir\s*=\s*(.+)/.exec(fs.readFileSync(localProps, "utf8"));
    if (m) roots.push(m[1].trim());
  }
  for (const root of roots.filter(Boolean)) {
    const buildTools = path.join(root, "build-tools");
    if (!fs.existsSync(buildTools)) continue;
    const versions = fs.readdirSync(buildTools).sort().reverse();
    for (const v of versions) {
      const candidate = path.join(buildTools, v, "zipalign");
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

const zipalign = resolveZipalign();
if (!zipalign) { console.error("scan-apk: zipalign not found; install Android build-tools and retry"); process.exit(1); }
execFileSync(zipalign, ["-c", "-P", "16", "-v", "4", apk], { stdio: "inherit" });
console.log(`scan-apk: clean (${path.basename(apk)}, ${entries.length} entries, 16 KiB aligned)`);
