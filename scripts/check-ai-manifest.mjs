#!/usr/bin/env node
/**
 * check-ai-manifest: validate on-device model-profile pins (WS-D).
 *
 * Parses apps/mobile/src/services/ai/modelProfiles.ts WITHOUT compiling
 * TypeScript (regex/brace scanner over the MODEL_PROFILES literal) and
 * fails closed when any profile:
 *   * lacks a revision pin (hex, 7-40 chars; no TBD/placeholder)
 *   * lacks a modelSha256 pin (64 hex chars; no placeholder)
 *   * declares an unknown runtime / format / maturity
 *   * carries an LFM license without catalogOnly: true
 *     (LFM Open License v1.0 arms are benchmark/eval-only catalogue
 *     entries — they must never be bundled or offered as downloads)
 *   * duplicates another profile id, or the catalogue is empty
 *
 * Usage:
 *   node scripts/check-ai-manifest.mjs [--file <path>]
 *   node scripts/check-ai-manifest.mjs --help
 *
 * Exit codes: 0 pass, 1 validation failure, 2 usage error.
 * Pure validators (parseModelProfiles, validateProfiles) are exported for
 * node --test suites and for scripts/ai-release-gate.mjs. Importing this
 * module has no side effects; the CLI runs only on direct execution.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const DEFAULT_FILE = "apps/mobile/src/services/ai/modelProfiles.ts";

const KNOWN_RUNTIMES = new Set(["litert-lm", "llama-cpp", "needle-cact"]);
const KNOWN_FORMATS = new Set(["litertlm", "gguf", "cact"]);
const KNOWN_MATURITIES = new Set(["default", "experimental", "eval-only"]);
const HEX_REV_RE = /^[0-9a-f]{7,40}$/i;
const HEX_SHA_RE = /^[0-9a-f]{64}$/i;

/** Split the MODEL_PROFILES array literal into its top-level object blocks. */
export function splitProfileBlocks(source) {
  const anchor = source.indexOf("MODEL_PROFILES");
  if (anchor === -1) return [];
  const assign = source.indexOf("=", anchor);
  if (assign === -1) return [];
  const open = source.indexOf("[", assign);
  if (open === -1) return [];
  const blocks = [];
  let i = open + 1;
  while (i < source.length) {
    const start = source.indexOf("{", i);
    if (start === -1) break;
    // Bail at the array close if no further object opens before it.
    const close = source.indexOf("]", i);
    if (close !== -1 && close < start) break;
    let depth = 0;
    let inStr = null;
    let escaped = false;
    let j = start;
    for (; j < source.length; j += 1) {
      const ch = source[j];
      if (inStr) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === inStr) {
          inStr = null;
        }
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        inStr = ch;
      } else if (ch === "{") {
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          blocks.push(source.slice(start, j + 1));
          break;
        }
      }
    }
    i = j + 1;
  }
  return blocks;
}

function stringField(block, name) {
  const match = new RegExp(`${name}\\s*:\\s*"([^"]*)"`).exec(block);
  return match ? match[1] : undefined;
}

function boolField(block, name) {
  const match = new RegExp(`${name}\\s*:\\s*(true|false)`).exec(block);
  return match ? match[1] === "true" : undefined;
}

/** Parse profile records from modelProfiles.ts source text. */
export function parseModelProfiles(source) {
  return splitProfileBlocks(source).map((block) => ({
    id: stringField(block, "id"),
    corpusLabel: stringField(block, "corpusLabel"),
    modelSha256: stringField(block, "modelSha256"),
    runtime: stringField(block, "runtime"),
    format: stringField(block, "format"),
    revision: stringField(block, "revision"),
    maturity: stringField(block, "maturity"),
    license: stringField(block, "license"),
    catalogOnly: boolField(block, "catalogOnly"),
  }));
}

/**
 * Validate parsed profiles. Returns a list of failure strings (empty = pass).
 * LFM-licensed arms must be catalogOnly (bundle/download forbidden).
 */
export function validateProfiles(profiles) {
  const errors = [];
  if (profiles.length === 0) {
    return ["no model profiles found in MODEL_PROFILES"];
  }
  const seen = new Set();
  for (const profile of profiles) {
    const label = profile.id ?? "<missing id>";
    if (!profile.id) {
      errors.push("profile with missing id");
      continue;
    }
    if (seen.has(profile.id)) {
      errors.push(`${label}: duplicate profile id`);
    }
    seen.add(profile.id);
    if (!profile.revision || !HEX_REV_RE.test(profile.revision)) {
      errors.push(`${label}: missing or unpinned revision (expected 7-40 hex chars)`);
    }
    if (!profile.modelSha256 || !HEX_SHA_RE.test(profile.modelSha256)) {
      errors.push(`${label}: missing modelSha256 pin (expected 64 hex chars)`);
    }
    if (!KNOWN_RUNTIMES.has(profile.runtime)) {
      errors.push(`${label}: unknown runtime ${profile.runtime ?? "<missing>"}`);
    }
    if (!KNOWN_FORMATS.has(profile.format)) {
      errors.push(`${label}: unknown format ${profile.format ?? "<missing>"}`);
    }
    if (!KNOWN_MATURITIES.has(profile.maturity)) {
      errors.push(`${label}: unknown maturity ${profile.maturity ?? "<missing>"}`);
    }
    if (typeof profile.license === "string" && /lfm/i.test(profile.license)) {
      if (profile.catalogOnly !== true) {
        errors.push(
          `${label}: LFM-licensed arm must set catalogOnly: true (bundle/download forbidden)`,
        );
      }
    }
  }
  return errors;
}

/** Read + validate one modelProfiles.ts file. Returns { profiles, errors }. */
export function validateAiManifestFile(absolutePath) {
  const source = readFileSync(absolutePath, "utf8");
  const profiles = parseModelProfiles(source);
  return { profiles, errors: validateProfiles(profiles) };
}

function printHelp() {
  console.log(`check-ai-manifest: validate on-device model-profile pins

usage:
  node scripts/check-ai-manifest.mjs [--file <path>]

options:
  --file <path>  modelProfiles.ts to validate (default: ${DEFAULT_FILE})
  --help         print this help and exit 0

exit codes: 0 pass, 1 validation failure, 2 usage error`);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }
  let file = DEFAULT_FILE;
  const fileFlag = args.indexOf("--file");
  if (fileFlag !== -1) {
    file = args[fileFlag + 1];
    if (!file) {
      console.error("check-ai-manifest: --file requires a path");
      process.exit(2);
    }
  }
  const unknown = args.filter((arg, index) => {
    if (arg === "--file" || index === fileFlag + 1) return false;
    return arg.startsWith("--");
  });
  if (unknown.length > 0) {
    console.error(`check-ai-manifest: unknown flag(s): ${unknown.join(", ")}`);
    process.exit(2);
  }
  const absolute = resolve(REPO_ROOT, file);
  let result;
  try {
    result = validateAiManifestFile(absolute);
  } catch (error) {
    console.error(`check-ai-manifest: FAIL: cannot read ${file} (${error.message})`);
    process.exit(1);
  }
  if (result.errors.length > 0) {
    console.error(`check-ai-manifest: FAIL (${result.errors.length} error(s))`);
    for (const error of result.errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  const lfm = result.profiles.filter((p) => typeof p.license === "string" && /lfm/i.test(p.license));
  console.log(
    `check-ai-manifest: PASS (${result.profiles.length} profiles pinned: ` +
      `${result.profiles.map((p) => p.id).join(", ")}; ` +
      `LFM catalogOnly arms: ${lfm.map((p) => p.id).join(", ") || "none"})`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
