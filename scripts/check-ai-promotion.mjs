#!/usr/bin/env node
/**
 * check-ai-promotion: enforce the lab-only runtime promotion policy (WS-D).
 *
 * Lab runtimes (MLC-LLM, ExecuTorch, Neuron) are benchmark harnesses: they
 * may run behind an explicit opt-in, but they are never routable and never
 * promotable to a production path. This script fails closed when:
 *   * LAB_ONLY_RUNTIMES in services/ai/llama/promotionPolicy.ts drifts from
 *     exactly ["mlc-llm", "executorch", "neuron"]
 *   * the lab branch of promotionDecision() stops pinning
 *     { promotable: false, routable: false }
 *   * isPromotable()/isRoutable() stop delegating to promotionDecision()
 *   * licenseGate no longer blocks LFM arms on the bundle/download channels
 *   * a lab-only runtime id appears as a catalogue profile runtime, or an
 *     LFM-licensed profile reaches maturity "default"
 *
 * Static source checks only (the policy modules are TypeScript): no build,
 * no device, no downloads.
 *
 * Usage:
 *   node scripts/check-ai-promotion.mjs [--policy <path>] [--license <path>] [--profiles <path>]
 *   node scripts/check-ai-promotion.mjs --help
 *
 * Exit codes: 0 pass, 1 policy violation, 2 usage error.
 * Pure validators are exported for node --test suites and for
 * scripts/ai-release-gate.mjs. Importing this module has no side effects;
 * the CLI runs only on direct execution.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseModelProfiles } from "./check-ai-manifest.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

const DEFAULT_POLICY = "apps/mobile/src/services/ai/llama/promotionPolicy.ts";
const DEFAULT_LICENSE = "apps/mobile/src/services/ai/llama/licenseGate.ts";
const DEFAULT_PROFILES = "apps/mobile/src/services/ai/modelProfiles.ts";

/** Canonical lab-only runtime set. Order-insensitive; exact membership. */
export const EXPECTED_LAB_ONLY_RUNTIMES = ["mlc-llm", "executorch", "neuron"];

/** Extract the LAB_ONLY_RUNTIMES string list from policy source. */
export function parseLabOnlyRuntimes(policySource) {
  const match = /LAB_ONLY_RUNTIMES\s*=\s*\[([^\]]*)\]/.exec(policySource);
  if (!match) return null;
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

function sameSet(actual, expected) {
  if (actual === null || actual.length !== expected.length) return false;
  return expected.every((item) => actual.includes(item));
}

/**
 * Validate the promotion policy + license gate + catalogue cross-checks.
 * Inputs are source texts. Returns a list of failure strings (empty = pass).
 */
export function validatePromotion({ policySource, licenseSource, profilesSource }) {
  const errors = [];

  const labOnly = parseLabOnlyRuntimes(policySource ?? "");
  if (!sameSet(labOnly, EXPECTED_LAB_ONLY_RUNTIMES)) {
    errors.push(
      `LAB_ONLY_RUNTIMES drift: got [${(labOnly ?? []).join(", ")}], ` +
        `want [${EXPECTED_LAB_ONLY_RUNTIMES.join(", ")}]`,
    );
  }

  const labBranch =
    /if\s*\(\s*isLabOnlyRuntime\(runtime\)\s*\)\s*\{[^}]*promotable:\s*false[^}]*routable:\s*false/s;
  if (!labBranch.test(policySource ?? "")) {
    errors.push("promotionDecision() lab branch must pin { promotable: false, routable: false }");
  }
  if (!/promotionDecision\(runtime\)\.promotable/.test(policySource ?? "")) {
    errors.push("isPromotable() must delegate to promotionDecision()");
  }
  if (!/promotionDecision\(runtime\)\.routable/.test(policySource ?? "")) {
    errors.push("isRoutable() must delegate to promotionDecision()");
  }

  const bundleBlock =
    /channel\s*===\s*"bundle"\s*\|\|\s*channel\s*===\s*"download"[\s\S]{0,400}?allowed:\s*false/;
  if (!bundleBlock.test(licenseSource ?? "")) {
    errors.push('licenseGate must block LFM arms on the bundle/download channels (allowed: false)');
  }
  if (!/LFM_LICENSE_ID\s*=\s*"LFM-1\.0"/.test(licenseSource ?? "")) {
    errors.push('licenseGate must define LFM_LICENSE_ID = "LFM-1.0"');
  }

  if (typeof profilesSource === "string") {
    const profiles = parseModelProfiles(profilesSource);
    for (const profile of profiles) {
      if (EXPECTED_LAB_ONLY_RUNTIMES.includes(profile.runtime ?? "")) {
        errors.push(
          `${profile.id}: lab-only runtime "${profile.runtime}" must never appear in the catalogue`,
        );
      }
      if (typeof profile.license === "string" && /lfm/i.test(profile.license)) {
        if (profile.maturity === "default") {
          errors.push(`${profile.id}: LFM-licensed arm must never reach maturity "default"`);
        }
      }
    }
  }

  return errors;
}

/** Read the three policy files and validate. Returns { errors }. */
export function validatePromotionFiles({ policyPath, licensePath, profilesPath }) {
  const policySource = readFileSync(resolve(REPO_ROOT, policyPath), "utf8");
  const licenseSource = readFileSync(resolve(REPO_ROOT, licensePath), "utf8");
  const profilesSource = readFileSync(resolve(REPO_ROOT, profilesPath), "utf8");
  return { errors: validatePromotion({ policySource, licenseSource, profilesSource }) };
}

function printHelp() {
  console.log(`check-ai-promotion: enforce the lab-only runtime promotion policy

usage:
  node scripts/check-ai-promotion.mjs [--policy <path>] [--license <path>] [--profiles <path>]

options:
  --policy <path>    promotionPolicy.ts (default: ${DEFAULT_POLICY})
  --license <path>   licenseGate.ts (default: ${DEFAULT_LICENSE})
  --profiles <path>  modelProfiles.ts (default: ${DEFAULT_PROFILES})
  --help             print this help and exit 0

exit codes: 0 pass, 1 policy violation, 2 usage error`);
}

function takeValue(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    console.error(`check-ai-promotion: ${flag} requires a path`);
    process.exit(2);
  }
  return value;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }
  const unknown = args.filter((arg, index) => {
    if (arg.startsWith("--") && !["--policy", "--license", "--profiles"].includes(arg)) return true;
    const prev = args[index - 1];
    if (["--policy", "--license", "--profiles"].includes(prev)) return false;
    return false;
  });
  if (unknown.length > 0) {
    console.error(`check-ai-promotion: unknown flag(s): ${unknown.join(", ")}`);
    process.exit(2);
  }
  const paths = {
    policyPath: takeValue(args, "--policy") ?? DEFAULT_POLICY,
    licensePath: takeValue(args, "--license") ?? DEFAULT_LICENSE,
    profilesPath: takeValue(args, "--profiles") ?? DEFAULT_PROFILES,
  };
  let errors;
  try {
    ({ errors } = validatePromotionFiles(paths));
  } catch (error) {
    console.error(`check-ai-promotion: FAIL: cannot read policy file (${error.message})`);
    process.exit(1);
  }
  if (errors.length > 0) {
    console.error(`check-ai-promotion: FAIL (${errors.length} violation(s))`);
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  console.log(
    `check-ai-promotion: PASS (lab-only: ${EXPECTED_LAB_ONLY_RUNTIMES.join(", ")}; ` +
      `never promotable, never routable; LFM bundle/download blocked)`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
