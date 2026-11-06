#!/usr/bin/env node
/**
 * Write the public Android update catalogue from one verified build.
 *
 * Input is the `apk-facts.json` that scripts/verify-release-apks.sh produced for
 * the signed APKs — package, versionName/versionCode, ABI set, SDK levels and
 * the signing-certificate digest, all proven on the actual bytes. This script
 * never invents a fact: a missing ABI row or a facts/file mismatch fails closed.
 *
 * The catalogue is what the app reads at launch:
 *   https://github.com/<owner>/<repo>/releases/download/<tag>/catalogue.v1.json
 * and every artifact URL points at a file in that same rolling release, so the
 * download always matches the catalogue that offered it.
 *
 * Usage:
 *   node scripts/write-android-catalogue.mjs \
 *     --facts apk-facts.json --apk-dir release-stage \
 *     --repo sheikhti1205/Norfold --tag android-latest \
 *     --release-id v0.14.0-beta.1+abc123def456 \
 *     --version-name 0.14.0-beta.1 --version-code 100123 \
 *     --git-sha <40 hex> --published-at 2026-11-06T10:00:00Z \
 *     --summary "What changed in this build." --out catalogue.v1.json
 *
 * Pure Node builtins.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const PACKAGE_NAME = "com.findback.app";
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA256_HEX = /^[0-9a-f]{64}$/i;
const COMMIT_SHA = /^[0-9a-f]{40}$/i;
const ABI = /^[a-z0-9_]+(-[a-z0-9_]+)*$/;
const MAX_VERSION_CODE = 2_100_000_000;

function fail(message) {
  throw new Error(`write-android-catalogue: ${message}`);
}

function argValue(args, name) {
  const index = args.indexOf(name);
  if (index === -1 || !args[index + 1]) fail(`${name} requires a value`);
  return args[index + 1];
}

function required(args, name) {
  const value = argValue(args, name).trim();
  if (value === "") fail(`${name} is empty`);
  return value;
}

function integer(value, name, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) fail(`${name} must be an integer in [${min}, ${max}]`);
  return parsed;
}

function hex(value, name, pattern) {
  const trimmed = value.trim().toLowerCase();
  if (!pattern.test(trimmed)) fail(`${name} is not a ${name.includes("sha256") ? "SHA-256 digest" : "commit SHA"}`);
  return trimmed;
}

/** One verified fact row, exactly as verify-release-apks.sh writes it. */
function factRow(row, index) {
  const at = `--facts[${index}]`;
  if (row === null || typeof row !== "object" || Array.isArray(row)) fail(`${at} must be an object`);
  if (typeof row.abi !== "string" || row.abi.trim() === "") fail(`${at}.abi is empty`);
  if (!Array.isArray(row.abis) || row.abis.length === 0) fail(`${at}.abis is empty`);
  for (const abi of row.abis) {
    if (typeof abi !== "string" || !ABI.test(abi.trim())) fail(`${at}.abis has an invalid entry`);
  }
  if (row.packageName !== PACKAGE_NAME) fail(`${at}.packageName is not ${PACKAGE_NAME}`);
  if (typeof row.versionName !== "string" || !SEMVER.test(row.versionName)) fail(`${at}.versionName is not SemVer`);
  if (!Number.isInteger(row.versionCode) || row.versionCode < 1) fail(`${at}.versionCode is not a positive integer`);
  if (typeof row.signerSha256 !== "string" || !SHA256_HEX.test(row.signerSha256)) fail(`${at}.signerSha256 is not a digest`);
  if (!Number.isInteger(row.minSdk) || row.minSdk < 21) fail(`${at}.minSdk is not an API level`);
  if (!Number.isInteger(row.targetSdk) || row.targetSdk < row.minSdk) fail(`${at}.targetSdk is below minSdk`);
  return {
    abi: row.abi.trim(),
    abis: [...row.abis].map((abi) => abi.trim()),
    packageName: row.packageName,
    versionName: row.versionName,
    versionCode: row.versionCode,
    minSdk: row.minSdk,
    targetSdk: row.targetSdk,
    signerSha256: row.signerSha256.toLowerCase(),
  };
}

/** The one APK in the staged dir that carries this ABI. */
function apkFor(abi, files) {
  const matches = files.filter((name) => name.toLowerCase().endsWith(".apk") && name.toLowerCase().includes(abi.toLowerCase()));
  if (matches.length !== 1) fail(`expected exactly one staged APK for ${abi}, found ${matches.length}`);
  return matches[0];
}

/** Keep changelogs, not stale install offers. Retaining bytes in the rolling
 * release alone cannot establish that an older download is still installable. */
function historyRecord(raw, fromRelease = false) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id.trim()
    || !SEMVER.test(raw.versionName) || Number.isNaN(Date.parse(raw.publishedAt))
    || typeof raw.summary !== 'string' || !raw.summary.trim()
    || (!fromRelease && !['none', 'unverified'].includes(raw.downloadStatus))) fail('invalid prior history');
  return { id:raw.id, versionName:raw.versionName, publishedAt:raw.publishedAt,
    summary:raw.summary.trim().slice(0,600), downloadStatus:fromRelease ? 'unverified' : raw.downloadStatus };
}

function retainedHistory(options) {
  const baseline=(options.baseline?.history ?? []).map(row=>historyRecord(row));
  const canonicalIds=new Set(baseline.map(row=>row.id));
  const prior=options.previous;
  const records=[...(prior?.history ?? []).map(row=>historyRecord(row)),
    ...(prior?.releases ?? []).map(row=>historyRecord(row,true))];
  const unique=new Map(records.map(row=>[row.id,row]));
  unique.delete(options.releaseId);
  for(const id of canonicalIds) unique.delete(id);
  const rolling=[...unique.values()].sort((a,b)=>Date.parse(b.publishedAt)-Date.parse(a.publishedAt)).slice(0,100);
  return [...baseline.filter(row=>row.id!==options.releaseId),...rolling];
}

export function buildCatalogue(options) {
  if (!Array.isArray(options.facts) || options.facts.length === 0) fail("no verified APK facts");
  const rows = options.facts.map(factRow);
  const keys = new Set();
  for (const row of rows) {
    if (keys.has(row.abi)) fail(`--facts repeats ${row.abi}`);
    keys.add(row.abi);
  }
  // One release is ONE build: mixed identity or SDK rows would describe two
  // different binaries under one version.
  const first = rows[0];
  for (const row of rows) {
    if (row.packageName !== first.packageName || row.versionName !== first.versionName || row.versionCode !== first.versionCode) {
      fail(`--facts mixes builds (${row.abi} disagrees on package/version)`);
    }
    if (row.minSdk !== first.minSdk || row.targetSdk !== first.targetSdk) fail(`--facts mixes SDK levels (${row.abi})`);
    if (row.signerSha256 !== first.signerSha256) fail("--facts mixes signing identities");
  }
  // Argument validation first, so a malformed call reports its own defect rather
  // than a confusing disagreement with the facts.
  const versionCode = integer(options.versionCode, "--version-code", 1, MAX_VERSION_CODE);
  if (!SEMVER.test(options.versionName)) fail("--version-name is not SemVer");
  const gitSha = hex(options.gitSha, "--git-sha", COMMIT_SHA);
  if (Number.isNaN(Date.parse(options.publishedAt))) fail("--published-at is not a timestamp");
  if (options.summary.trim() === "") fail("--summary is empty");
  if (/\s/.test(options.tag)) fail("--tag must not contain whitespace");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repo)) fail("--repo must be owner/name");
  if (!/^[A-Za-z0-9_.-]+$/.test(options.signingChannel)) fail("--signing-channel must be a plain label");

  if (first.versionName !== options.versionName) fail(`--version-name ${options.versionName} disagrees with the verified APKs (${first.versionName})`);
  if (first.versionCode !== options.versionCode) fail(`--version-code ${options.versionCode} disagrees with the verified APKs (${first.versionCode})`);

  const base = `https://github.com/${options.repo}/releases/download/${options.tag}`;
  // A device installs one ABI-specific APK; the universal build would only add
  // a larger download for the same bytes, so it is never offered.
  const artifacts = rows
    .filter((row) => row.abis.length === 1)
    .sort((a, b) => a.abi.localeCompare(b.abi))
    .map((row) => {
      const file = apkFor(row.abi, options.files);
      const bytes = readFileSync(join(options.apkDir, file));
      if (bytes.length === 0) fail(`staged APK ${file} is empty`);
      return {
        url: `${base}/${encodeURIComponent(file)}`,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        packageName: row.packageName,
        signingChannel: options.signingChannel,
        signerSha256: row.signerSha256,
        abis: row.abis,
        minSdk: row.minSdk,
        targetSdk: row.targetSdk,
      };
    });
  if (artifacts.length === 0) fail("no single-ABI APK was verified; nothing could be installed");

  return {
    schemaVersion: 1,
    releases: [
      {
        id: options.releaseId,
        platform: "android",
        versionName: options.versionName,
        versionCode,
        gitSha,
        tag: options.tag,
        publishedAt: new Date(options.publishedAt).toISOString(),
        summary: options.summary.trim(),
        accepted: true,
        artifacts,
      },
    ],
    history: retainedHistory(options),
    features: options.baseline?.features ?? [],
  };
}

function main(argv) {
  const args = argv.slice(2);
  const apkDir = resolve(required(args, "--apk-dir"));
  const factsPath = resolve(required(args, "--facts"));
  let facts;
  try {
    facts = JSON.parse(readFileSync(factsPath, "utf8"));
  } catch {
    fail(`--facts could not be read: ${factsPath}`);
  }
  if (!Array.isArray(facts) || facts.length === 0) fail("--facts contains no verified APKs");
  if (facts.length > 8) fail("--facts has more rows than any real build");
  const catalogue = buildCatalogue({
    baseline: JSON.parse(readFileSync(new URL('../apps/mobile/public/updates/catalogue.v1.json',import.meta.url),'utf8')),
    previous: args.includes('--previous') ? JSON.parse(readFileSync(resolve(required(args,'--previous')),'utf8')) : undefined,
    facts,
    apkDir,
    files: readdirSync(apkDir).filter((name) => statSync(join(apkDir, name)).isFile()),
    repo: required(args, "--repo"),
    tag: required(args, "--tag"),
    releaseId: required(args, "--release-id"),
    versionName: required(args, "--version-name"),
    versionCode: Number(argValue(args, "--version-code")),
    gitSha: required(args, "--git-sha"),
    publishedAt: required(args, "--published-at"),
    summary: argValue(args, "--summary"),
    signingChannel: required(args, "--signing-channel"),
  });
  const out = resolve(required(args, "--out"));
  writeFileSync(out, `${JSON.stringify(catalogue, null, 2)}\n`);
  const artifacts = catalogue.releases[0].artifacts;
  console.log(`write-android-catalogue: ${basename(out)} describes ${artifacts.length} artifact(s) for ${catalogue.releases[0].id}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main(process.argv);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
