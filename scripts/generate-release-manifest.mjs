#!/usr/bin/env node
/**
 * Generate release-manifest.json for a signed release.
 *
 * Auto-generated shape only — every artifact entry comes from a file that
 * actually exists on disk (no invented entries, no hardcoded ABI list: APKs
 * are discovered by glob). Versions are read, never bumped.
 *
 * Shape:
 *   { versionName, versionCode, gitSha, tag, minSdk, targetSdk,
 *     artifacts: [{ file, sha256, bytes }] }
 *
 * Usage:
 *   node scripts/generate-release-manifest.mjs \
 *     --tag v0.1.0-beta.1 --apk-dir <dir> --aab <file> \
 *     --version-code 123456 --git-sha abc123 \
 *     --min-sdk 24 --target-sdk 36 --out release-manifest.json
 *
 * Pure Node builtins.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

function argValue(args, name) {
  const idx = args.indexOf(name);
  if (idx === -1 || !args[idx + 1]) throw new Error(`generate-release-manifest: ${name} requires a value`);
  return args[idx + 1];
}

/**
 * Build the manifest object from explicit inputs + files on disk.
 * Throws when a listed file is missing (fail closed, never invent entries).
 */
export function buildManifest({ versionName, versionCode, gitSha, tag, minSdk, targetSdk, files }) {
  const artifacts = files.map((file) => {
    const bytes = statSync(file).size;
    const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
    return { file: basename(file), sha256, bytes };
  });
  artifacts.sort((a, b) => (a.file < b.file ? -1 : 1));
  return { versionName, versionCode, gitSha, tag, minSdk, targetSdk, artifacts };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const args = process.argv.slice(2);
    const tag = argValue(args, "--tag");
    const apkDir = resolve(argValue(args, "--apk-dir"));
    const aab = resolve(argValue(args, "--aab"));
    const out = resolve(argValue(args, "--out"));
    const versionCode = Number(argValue(args, "--version-code"));
    const gitSha = argValue(args, "--git-sha");
    const minSdk = Number(argValue(args, "--min-sdk"));
    const targetSdk = Number(argValue(args, "--target-sdk"));
    if (!Number.isInteger(versionCode)) throw new Error("generate-release-manifest: --version-code must be an integer");
    if (!Number.isInteger(minSdk) || !Number.isInteger(targetSdk)) {
      throw new Error("generate-release-manifest: --min-sdk/--target-sdk must be integers");
    }

    const mobilePkg = JSON.parse(readFileSync(resolve(REPO_ROOT, "apps/mobile/package.json"), "utf8"));
    const versionName = mobilePkg.version;
    if (!versionName) throw new Error("generate-release-manifest: apps/mobile/package.json has no version");

    // Dynamic ABI discovery: whatever per-ABI + universal APKs Gradle emitted.
    const apks = readdirSync(apkDir)
      .filter((name) => name.endsWith(".apk"))
      .map((name) => resolve(apkDir, name));
    if (apks.length === 0) throw new Error(`generate-release-manifest: no APKs in ${apkDir}`);

    const manifest = buildManifest({
      versionName,
      versionCode,
      gitSha,
      tag,
      minSdk,
      targetSdk,
      files: [...apks, aab],
    });
    writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(
      `generate-release-manifest: wrote ${out} (${manifest.artifacts.length} artifacts, version ${versionName})`,
    );
  } catch (error) {
    console.error(
      error.message.startsWith("generate-release-manifest:")
        ? error.message
        : `generate-release-manifest: ${error.message}`,
    );
    process.exit(1);
  }
}
