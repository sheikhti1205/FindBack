#!/usr/bin/env node
/** Inspect the debug APK: forbidden weights, a real DEX/asset secret scan, 16 KiB alignment. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { validateNativePackage, retiredDexOwners, classifyPackageEntry } from "./native-package-policy.mjs";

const strict = process.argv.includes("--strict");
const apkArg = process.argv.slice(2).find((a) => !a.startsWith("--"));
const apk = apkArg ?? "apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk";
if (!fs.existsSync(apk)) { console.error(`scan-apk: APK not found at ${apk}`); process.exit(1); }

const unzip = (args, opts = {}) => execFileSync("unzip", args, { maxBuffer: 256 * 1024 * 1024, ...opts });
const entries = unzip(["-Z1", apk]).toString("utf8").split("\n").filter(Boolean);

const packageErrors = validateNativePackage(entries, { strict });
if (packageErrors.length) { console.error(`scan-apk: ${packageErrors.join("\nscan-apk: ")}`); process.exit(1); }

const secretPrefix = ["sb", "secret"].join("_") + "_";
const serviceRoleName = ["SUPABASE", "SERVICE", "ROLE", "KEY"].join("_");
const SECRETS = [new RegExp(`${secretPrefix}[A-Za-z0-9_-]+`), new RegExp(serviceRoleName), /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/, /sk-or-v1-[A-Za-z0-9]{32,}/, /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/];
const scanEntries = entries.filter((e) => classifyPackageEntry(e).isTextScan);
const secretHits = [];
for (const entry of scanEntries) {
  const text = unzip(["-p", apk, entry]).toString("latin1");
  if (classifyPackageEntry(entry).isDex && retiredDexOwners(text).length) {
    console.error(`scan-apk: retired runtime class ownership in ${entry}`); process.exit(1);
  }
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
