#!/usr/bin/env node
/**
 * deploy-required-edge-functions: SAFE, canonical orchestration for the
 * production Edge Function deploy set (CLOSEOUT section 3).
 *
 * Contract (enforced by tests + CLI guards):
 *   - Deploys ONLY the required production set, in order:
 *       ai-help              → JWT verify ON (no flag)
 *       reply-comment        → --no-verify-jwt
 *       push-dispatch        → --no-verify-jwt   (after push-config PASS)
 *       cleanup-comment-media→ --no-verify-jwt   (ONLY after migration
 *                                                20261013020000 is live)
 *   - NEVER deploys `delete-account` (owner-side, separate auth review). A
 *     `delete-account` token anywhere in the args is a hard error.
 *   - STOPS on missing configuration: the push-dispatch deploy is refused
 *     unless `check-push-config.mjs` reports all PRESENT and the server
 *     project is ALIGNED with the client project.
 *   - DRY-RUN by default. Real deploys require `--execute`.
 *   - Prints function NAMES and flags only — never secret values.
 *   - Optionally runs `check-edge-parity.mjs --manifest <path>` afterwards.
 *
 * Usage:
 *   node scripts/deploy-required-edge-functions.mjs                 # dry-run plan
 *   node scripts/deploy-required-edge-functions.mjs --migrations-live
 *   SUPABASE_PROJECT_REF=<ref> node scripts/deploy-required-edge-functions.mjs \
 *       --execute --migrations-live [--manifest <live-manifest.json>]
 *
 * Pure injectable API (for node --test, no I/O):
 *   REQUIRED_FUNCTIONS, FORBIDDEN_FUNCTIONS,
 *   buildDeploymentPlan({ cleanupMigrationsLive }), deployArgs(step),
 *   formatPlan(plan), assertNoForbidden(names), preflightBlockers({ plan, pushOk })
 */

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(import.meta.url);

/** Required production deploy set. Order is the deploy order. */
export const REQUIRED_FUNCTIONS = [
  { name: "ai-help", verifyJwt: true },
  { name: "reply-comment", verifyJwt: false },
  { name: "push-dispatch", verifyJwt: false, requiresPushConfig: true },
  {
    name: "cleanup-comment-media",
    verifyJwt: false,
    requiresMigrationsLive: "20261013020000",
  },
];

/** Never deployed by this orchestration (owner-side, separate auth review). */
export const FORBIDDEN_FUNCTIONS = ["delete-account"];

/** Build the ordered plan, dropping gated steps whose gate is unmet. */
export function buildDeploymentPlan({ cleanupMigrationsLive = false } = {}) {
  return REQUIRED_FUNCTIONS.filter(
    (fn) => !fn.requiresMigrationsLive || cleanupMigrationsLive,
  );
}

/** `supabase functions deploy <name> [--no-verify-jwt]` argv (minus the binary). */
export function deployArgs(step) {
  const args = ["functions", "deploy", step.name];
  if (!step.verifyJwt) args.push("--no-verify-jwt");
  return args;
}

/** Threat-model guard: reject any forbidden function name anywhere in inputs. */
export function assertNoForbidden(names) {
  const hit = (names ?? []).filter((n) => FORBIDDEN_FUNCTIONS.includes(n));
  if (hit.length > 0) {
    throw new Error(
      `deploy-required-edge-functions: refusing to deploy forbidden function(s): ${hit.join(", ")} (owner-side only)`,
    );
  }
}

/**
 * Preflight blockers. Returns [] when deployable, else the reason names.
 * pushOk: boolean — whether check-push-config reported PRESENT + ALIGNED.
 */
export function preflightBlockers({ plan, pushOk }) {
  const blockers = [];
  if (plan.some((fn) => fn.requiresPushConfig) && !pushOk) {
    blockers.push("push-config not PASS (server secrets missing or client/server project mismatch)");
  }
  return blockers;
}

/** Names-only, value-free plan rendering. */
export function formatPlan(plan) {
  const lines = ["deploy-required-edge-functions: plan (name | jwt-verify)"];
  for (const step of plan) {
    lines.push(`  ${step.name} | ${step.verifyJwt ? "ON" : "OFF"}`);
  }
  lines.push(
    `deploy-required-edge-functions: ${plan.length} function(s); delete-account NEVER included`,
  );
  return lines.join("\n");
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { stdio: "inherit", ...opts });
}

/** Runs check-push-config.mjs; true when it exits 0 (PRESENT + ALIGNED). */
function pushConfigPasses() {
  const result = spawnSync("node", [resolve(HERE, "..", "check-push-config.mjs")], {
    stdio: "pipe",
    encoding: "utf8",
  });
  if (result.stdout) process.stderr.write(result.stdout);
  return result.status === 0;
}

function parseArgs(args) {
  const parsed = { execute: false, migrationsLive: false, manifest: null, ref: process.env.SUPABASE_PROJECT_REF ?? "" };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--execute") parsed.execute = true;
    else if (arg === "--migrations-live") parsed.migrationsLive = true;
    else if (arg === "--manifest") parsed.manifest = args[++i];
    else if (arg === "--project-ref") parsed.ref = args[++i];
    else parsed.unknown = [...(parsed.unknown ?? []), arg];
  }
  return parsed;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`deploy-required-edge-functions: safe Edge deploy orchestration

usage:
  node scripts/deploy-required-edge-functions.mjs [--execute] [--migrations-live] [--manifest <path>] [--project-ref <ref>]

  (default: dry-run plan; --execute performs real deploys)
  (--migrations-live required to include cleanup-comment-media)
  delete-account is NEVER deployed by this script.`);
    process.exit(0);
  }
  const parsed = parseArgs(args);
  if (parsed.unknown?.length) {
    console.error(`deploy-required-edge-functions: unknown flag(s): ${parsed.unknown.join(", ")}`);
    process.exit(2);
  }
  try {
    assertNoForbidden(Object.values(parsed).flat().filter((v) => typeof v === "string"));
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }

  const plan = buildDeploymentPlan({ cleanupMigrationsLive: parsed.migrationsLive });
  console.log(formatPlan(plan));

  const needsPushConfig = plan.some((fn) => fn.requiresPushConfig);
  const pushOk = needsPushConfig ? pushConfigPasses() : true;
  const blockers = preflightBlockers({ plan, pushOk });
  if (blockers.length > 0) {
    for (const blocker of blockers) console.error(`deploy-required-edge-functions: BLOCKED — ${blocker}`);
    process.exit(1);
  }

  if (!parsed.execute) {
    console.log("deploy-required-edge-functions: dry-run (pass --execute to deploy)");
    process.exit(0);
  }

  if (!parsed.ref.trim()) {
    console.error("deploy-required-edge-functions: SUPABASE_PROJECT_REF (or --project-ref) is required to execute");
    process.exit(2);
  }
  const link = run("supabase", ["link", "--project-ref", parsed.ref]);
  if (link.status !== 0) {
    console.error("deploy-required-edge-functions: supabase link failed");
    process.exit(link.status ?? 1);
  }
  for (const step of plan) {
    console.log(`deploy-required-edge-functions: deploying ${step.name}`);
    const result = run("supabase", deployArgs(step));
    if (result.status !== 0) {
      console.error(`deploy-required-edge-functions: deploy failed for ${step.name}`);
      process.exit(result.status ?? 1);
    }
  }
  if (parsed.manifest) {
    const parity = run("node", [resolve(HERE, "..", "check-edge-parity.mjs"), "--manifest", parsed.manifest]);
    if (parity.status !== 0) {
      console.error("deploy-required-edge-functions: edge parity not all CURRENT after deploy");
      process.exit(parity.status ?? 1);
    }
  }
  console.log("deploy-required-edge-functions: done");
}

function isMainModule() {
  const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
  return invoked === resolve(HERE);
}

if (isMainModule()) {
  main();
}
