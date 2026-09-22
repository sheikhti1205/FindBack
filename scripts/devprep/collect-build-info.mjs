#!/usr/bin/env node
// Shared build-identity collector for devprep device-day runs.
// Read-only: git SHA/branch, versionName from apps/mobile/package.json,
// versionCode derivation RULE (apps/mobile/android/app/build.gradle
// gitVersionCode — deterministic from git history, never a literal), and the
// pinned catalogue identities. No device, no network, no secrets.
// Usage: node scripts/devprep/collect-build-info.mjs [--out <dir>]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
function flagValue(name, fallback) {
  const hit = args.find((a) => a.startsWith(`${name}=`));
  if (hit) return hit.slice(name.length + 1);
  const idx = args.indexOf(name);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return fallback;
}

function gitFact(cmd) {
  try {
    return execFileSync("git", cmd, { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

const root = process.cwd();
const mobilePkg = JSON.parse(
  fs.readFileSync(path.join(root, "apps/mobile/package.json"), "utf8"),
);
const catalogue = JSON.parse(
  fs.readFileSync(
    path.join(root, "docs/specs/model-library/catalogue.v1.json"),
    "utf8",
  ),
);

function entryPin(id) {
  const entry = (catalogue.entries ?? []).find((e) => e.id === id);
  if (!entry) return { id, found: false };
  return {
    id,
    found: true,
    revision: entry.revision ?? null,
    installedBytes: entry.installedBytes ?? null,
    installedSha256: entry.installedSha256 ?? null,
    distribution: entry.distribution ?? null,
  };
}

const info = {
  capturedAt: new Date().toISOString(),
  gitSha: gitFact(["rev-parse", "HEAD"]),
  gitBranch: gitFact(["rev-parse", "--abbrev-ref", "HEAD"]),
  gitStatus: gitFact(["status", "--short"]),
  versionName: mobilePkg.version,
  // versionCode is minted by gitVersionCode() in app/build.gradle at build
  // time; record the rule here and the minted value on device day from the
  // APK (aapt dump badging) or the About screen (native versionCode).
  versionCodeRule: "gitVersionCode() in apps/mobile/android/app/build.gradle",
  versionCode: null,
  pins: {
    smolvlm2: entryPin("smolvlm2-500m-litert-int4"),
    qwen: entryPin("qwen3-0.6b-litert-dynamic-int4"),
  },
};

const outDir = flagValue("--out", "test-evidence/devprep/shared");
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, "build-info.json");
const tmpPath = `${outPath}.tmp`;
fs.writeFileSync(tmpPath, `${JSON.stringify(info, null, 2)}\n`);
fs.renameSync(tmpPath, outPath);
console.log(`collect-build-info: sha=${info.gitSha} versionName=${info.versionName} -> ${outPath}`);
