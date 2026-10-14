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
 *       delete-account       → JWT verify ON (no flag; gateway-enforced AND
 *                              function-enforced 401 — see source review in
 *                              supabase/functions/delete-account/index.ts),
 *                              ONLY after migration 20261014010000 (the
 *                              storage write fence) is live — the function's
 *                              first RPC call is gated on it and would fail
 *                              closed with 503 otherwise.
 *   - The old `delete-account` exclusion is RETIRED: source review proves the
 *     function is JWT-uid-only (no uid parameter, cross-user deletion
 *     impossible by construction), storage purge covers every registered
 *     user-bytes namespace, and unauthenticated calls fail closed with 401.
 *     Deploying the code is non-destructive — deletion only ever runs for a
 *     valid session JWT, and live destructive proof stays a disposable-
 *     account owner step, never CI.
 *   - STOPS on missing configuration: the push-dispatch deploy is refused
 *     unless `check-push-config.mjs` reports all PRESENT and the server
 *     project is ALIGNED with the client project.
 *   - DRY-RUN by default. Real deploys require `--execute`.
 *   - Prints function NAMES and flags only — never secret values.
 *   - Optionally runs `check-edge-parity.mjs --manifest <path>` afterwards
 *     (covers delete-account: CURRENT/STALE/MISSING by source sha256).
 *   - Optionally runs a NON-DESTRUCTIVE unauthenticated 401 probe via
 *     `--prove-401 <function-url>` (POST with NO credentials; expects 401;
 *     never sends a token, never deletes anything). Owner-runner only.
 *
 * Usage:
 *   node scripts/deploy-required-edge-functions.mjs                 # dry-run plan
 *   node scripts/deploy-required-edge-functions.mjs --migrations-live   # (= --migration 20261013020000)
 *   SUPABASE_PROJECT_REF=<ref> node scripts/deploy-required-edge-functions.mjs \
 *       --execute --migration 20261013020000 --migration 20261014010000 \
 *       [--manifest <live-manifest.json>]
 *   node scripts/deploy-required-edge-functions.mjs \
 *       --prove-401 https://<ref>.functions.supabase.co/delete-account
 *
 * Pure injectable API (for node --test, no I/O):
 *   REQUIRED_FUNCTIONS, FORBIDDEN_FUNCTIONS,
 *   buildDeploymentPlan({ liveMigrations, cleanupMigrationsLive }), deployArgs(step),
 *   formatPlan(plan), assertNoForbidden(names, forbidden),
 *   preflightBlockers({ plan, pushOk }),
 *   classifyAuthGuardProbe({ status }), probeDeleteAccountAuthGuard(fetchFn, url)
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
  {
    // JWT-verify ON, and GATED: the fence RPC (findback_begin_account_deletion)
    // ships in 20261014010000, so deploying the function before the migration
    // would fail closed with 503 on every delete attempt.
    name: "delete-account",
    verifyJwt: true,
    requiresMigrationsLive: "20261014010000",
  },
];

/**
 * Functions this orchestration must never deploy. Retired the old
 * `delete-account` entry after source review + 401 proof closed the live
 * gap; the mechanism stays so a future exclusion needs one line, not a
 * redesign. Empty means: every required function is deployable.
 */
export const FORBIDDEN_FUNCTIONS = [];

/** Build the ordered plan, dropping gated steps whose migration gate is unmet. */
export function buildDeploymentPlan({ liveMigrations, cleanupMigrationsLive = false } = {}) {
  const live = new Set(liveMigrations ?? []);
  if (cleanupMigrationsLive) live.add("20261013020000");
  return REQUIRED_FUNCTIONS.filter((fn) => !fn.requiresMigrationsLive || live.has(fn.requiresMigrationsLive));
}

/** `supabase functions deploy <name> [--no-verify-jwt]` argv (minus the binary). */
export function deployArgs(step) {
  const args = ["functions", "deploy", step.name];
  if (!step.verifyJwt) args.push("--no-verify-jwt");
  return args;
}

/** Threat-model guard: reject any forbidden function name anywhere in inputs. */
export function assertNoForbidden(names, forbidden = FORBIDDEN_FUNCTIONS) {
  const hit = (names ?? []).filter((n) => (forbidden ?? []).includes(n));
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
    `deploy-required-edge-functions: ${plan.length} function(s); delete-account included (JWT-verify ON, fail-closed 401 without a session JWT)`,
  );
  return lines.join("\n");
}

/**
 * Pure classification of an unauthenticated delete-account probe.
 * The fail-closed contract: no credentials MUST yield 401 (never 200 with
 * a deletion body, never 500 leaking internals to an anonymous caller).
 */
export function classifyAuthGuardProbe({ status }) {
  if (status === 401) return { ok: true };
  return { ok: false, reason: `expected 401, got ${status}` };
}

/**
 * Non-destructive live probe (owner-runner only): POST with NO credentials
 * and expect the 401 guard. Sends no Authorization header, no apikey, no
 * body with identity — nothing that could delete. fetchFn is injected so
 * unit tests run hermetic; the CLI passes globalThis.fetch.
 */
export async function probeDeleteAccountAuthGuard(fetchFn, url) {
  const response = await fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  return classifyAuthGuardProbe({ status: response?.status });
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
  const parsed = { execute: false, migrationsLive: false, migrations: [], manifest: null, prove401Url: null, ref: process.env.SUPABASE_PROJECT_REF ?? "" };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--execute") parsed.execute = true;
    else if (arg === "--migrations-live") parsed.migrationsLive = true;
    else if (arg === "--migration") parsed.migrations.push(args[++i]);
    else if (arg === "--manifest") parsed.manifest = args[++i];
    else if (arg === "--prove-401") parsed.prove401Url = args[++i];
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
  node scripts/deploy-required-edge-functions.mjs [--execute] [--migration <version> ...] [--migrations-live] [--manifest <path>] [--project-ref <ref>] [--prove-401 <function-url>]

  (default: dry-run plan; --execute performs real deploys)
  (--migration <version> marks a migration live so its gated step is included;
   repeatable. --migrations-live is shorthand for --migration 20261013020000)
  (cleanup-comment-media needs 20261013020000; delete-account needs 20261014010000)
  (delete-account IS in the deploy set: JWT-verify ON, fail-closed 401.
   --prove-401 posts WITHOUT credentials and expects 401; non-destructive,
   owner-runner only, never sends a token.)`);
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

  const plan = buildDeploymentPlan({ liveMigrations: parsed.migrations, cleanupMigrationsLive: parsed.migrationsLive });
  console.log(formatPlan(plan));

  const needsPushConfig = plan.some((fn) => fn.requiresPushConfig);
  const pushOk = needsPushConfig ? pushConfigPasses() : true;
  const blockers = preflightBlockers({ plan, pushOk });
  if (blockers.length > 0) {
    for (const blocker of blockers) console.error(`deploy-required-edge-functions: BLOCKED — ${blocker}`);
    process.exit(1);
  }

  if (!parsed.execute && !parsed.prove401Url) {
    console.log("deploy-required-edge-functions: dry-run (pass --execute to deploy)");
    process.exit(0);
  }

  if (parsed.execute) {
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
  }

  if (parsed.prove401Url) {
    const fetchFn = globalThis.fetch;
    if (typeof fetchFn !== "function") {
      console.error("deploy-required-edge-functions: no global fetch available for --prove-401");
      process.exit(2);
    }
    probeDeleteAccountAuthGuard(fetchFn, parsed.prove401Url).then(
      (result) => {
        if (result.ok) {
          console.log("deploy-required-edge-functions: delete-account 401 guard PROVEN (no credentials → 401, nothing deleted)");
          process.exit(0);
        }
        console.error(`deploy-required-edge-functions: delete-account 401 guard FAILED — ${result.reason}`);
        process.exit(1);
      },
      (error) => {
        console.error(`deploy-required-edge-functions: delete-account 401 probe errored (${error?.message ?? error})`);
        process.exit(1);
      },
    );
    return;
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
