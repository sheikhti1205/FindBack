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
 *     artifacts: [{ file, sha256, bytes, kind, packageName?, signingChannel?,
 *                   signerSha256?, abis?, minSdk?, targetSdk?,
 *                   versionName?, versionCode? }] }
 *
 * `--facts` merges the per-APK facts that verify-release-apks.sh proved on the
 * signed binaries (package, signer digest, ABI set, SDK levels). Without it the
 * manifest still records bytes/hashes, but a release built that way must not be
 * offered as an update: the catalogue rejects artifacts with no verified facts.
 *
 * Usage:
 *   node scripts/generate-release-manifest.mjs \
 *     --tag v0.1.0-beta.1 --apk-dir <dir> --aab <file> \
 *     --version-code 123456 --git-sha abc123 \
 *     --min-sdk 24 --target-sdk 36 --out release-manifest.json \
 *     [--facts verified-facts.json --signing-channel beta]
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
 * gitSha must be the FULL 40-char commit SHA (provenance); short SHAs are
 * rejected so a truncated identity can never ship in a release manifest.
 */
const SHA256_HEX = /^[0-9a-f]{64}$/i;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** A verified facts row proves ONE APK's identity on the signed bytes. */
function validateFacts(facts, expected) {
  if (!Array.isArray(facts) || facts.length === 0) {
    throw new Error("generate-release-manifest: --facts must contain at least one verified APK");
  }
  const rows = facts.map((row, index) => {
    const at = `--facts[${index}]`;
    if (row === null || typeof row !== "object") throw new Error(`generate-release-manifest: ${at} must be an object`);
    if (typeof row.abi !== "string" || row.abi.trim() === "") throw new Error(`generate-release-manifest: ${at}.abi is empty`);
    if (!Array.isArray(row.abis) || row.abis.length === 0) throw new Error(`generate-release-manifest: ${at}.abis is empty`);
    for (const abi of row.abis) {
      if (typeof abi !== "string" || abi.trim() === "") throw new Error(`generate-release-manifest: ${at}.abis has an empty entry`);
    }
    if (typeof row.packageName !== "string" || !/^[A-Za-z0-9._]+$/.test(row.packageName)) {
      throw new Error(`generate-release-manifest: ${at}.packageName is not a package id`);
    }
    if (typeof row.versionName !== "string" || !SEMVER.test(row.versionName)) {
      throw new Error(`generate-release-manifest: ${at}.versionName is not SemVer`);
    }
    if (!Number.isInteger(row.versionCode) || row.versionCode <= 0) {
      throw new Error(`generate-release-manifest: ${at}.versionCode must be a positive integer`);
    }
    if (!Number.isInteger(row.minSdk) || !Number.isInteger(row.targetSdk) || row.minSdk > row.targetSdk) {
      throw new Error(`generate-release-manifest: ${at} has an invalid SDK range`);
    }
    if (typeof row.signerSha256 !== "string" || !SHA256_HEX.test(row.signerSha256)) {
      throw new Error(`generate-release-manifest: ${at}.signerSha256 must be 64 hex characters`);
    }
    return {
      abi: row.abi,
      abis: [...row.abis],
      packageName: row.packageName,
      versionName: row.versionName,
      versionCode: row.versionCode,
      minSdk: row.minSdk,
      targetSdk: row.targetSdk,
      signerSha256: row.signerSha256.toLowerCase(),
    };
  });

  const first = rows[0];
  const keys = new Set();
  for (const row of rows) {
    if (keys.has(row.abi)) throw new Error(`generate-release-manifest: --facts repeats ${row.abi}`);
    keys.add(row.abi);
    // One release is ONE build. Mixed identity/SDK rows would let the manifest
    // describe two binaries as one artifact set.
    for (const field of ["packageName", "versionName", "versionCode", "minSdk", "targetSdk", "signerSha256"]) {
      if (row[field] !== first[field]) {
        throw new Error(`generate-release-manifest: --facts disagrees on ${field} (${row.abi})`);
      }
    }
  }
  if (first.versionName !== expected.versionName) {
    throw new Error(`generate-release-manifest: --facts versionName ${first.versionName} != package.json ${expected.versionName}`);
  }
  if (first.versionCode !== expected.versionCode) {
    throw new Error(`generate-release-manifest: --facts versionCode ${first.versionCode} != --version-code ${expected.versionCode}`);
  }
  return rows;
}

export function buildManifest({
  versionName,
  versionCode,
  gitSha,
  tag,
  minSdk,
  targetSdk,
  files,
  facts,
  signingChannel,
}) {
  if (!/^[0-9a-f]{40}$/i.test(gitSha ?? "")) {
    throw new Error("generate-release-manifest: --git-sha must be a full 40-char commit SHA");
  }
  if ((facts === undefined) !== (signingChannel === undefined)) {
    throw new Error("generate-release-manifest: --facts and --signing-channel are required together");
  }
  if (signingChannel !== undefined && (typeof signingChannel !== "string" || signingChannel.trim() === "")) {
    throw new Error("generate-release-manifest: --signing-channel must be a non-empty owner label");
  }
  const rows = facts === undefined ? null : validateFacts(facts, { versionName, versionCode });
  const consumed = new Set();

  const artifacts = files.map((file) => {
    const bytes = statSync(file).size;
    const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
    const name = basename(file);
    if (!name.endsWith(".apk")) {
      return { file: name, sha256, bytes, kind: "bundle" };
    }
    if (rows === null) return { file: name, sha256, bytes, kind: "apk" };
    // Staged names are `<prefix>-<tag>-<abi|universal>.apk`; match the verified
    // row by its ABI suffix rather than trusting the filename's version part.
    const matches = rows.filter((row) => name.endsWith(`-${row.abi}.apk`));
    if (matches.length !== 1) {
      throw new Error(`generate-release-manifest: ${name} has no single verified facts row`);
    }
    const row = matches[0];
    consumed.add(row.abi);
    return {
      file: name,
      sha256,
      bytes,
      kind: "apk",
      packageName: row.packageName,
      signingChannel: signingChannel.trim(),
      signerSha256: row.signerSha256,
      abis: row.abis,
      minSdk: row.minSdk,
      targetSdk: row.targetSdk,
      versionName: row.versionName,
      versionCode: row.versionCode,
    };
  });
  if (rows !== null) {
    for (const row of rows) {
      if (!consumed.has(row.abi)) {
        throw new Error(`generate-release-manifest: verified facts for ${row.abi} match no APK`);
      }
    }
  }
  artifacts.sort((a, b) => (a.file < b.file ? -1 : 1));
  return {
    versionName,
    versionCode,
    gitSha,
    tag,
    minSdk,
    targetSdk,
    ...(rows === null ? {} : { packageName: rows[0].packageName, signingChannel: signingChannel.trim() }),
    artifacts,
  };
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
    const factsPath = args.includes("--facts") ? resolve(argValue(args, "--facts")) : undefined;
    const signingChannel = args.includes("--signing-channel")
      ? argValue(args, "--signing-channel")
      : undefined;
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

    const facts = factsPath === undefined ? undefined : JSON.parse(readFileSync(factsPath, "utf8"));
    const manifest = buildManifest({
      versionName,
      versionCode,
      gitSha,
      tag,
      minSdk,
      targetSdk,
      files: [...apks, aab],
      facts,
      signingChannel,
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
