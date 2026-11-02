#!/usr/bin/env node
/**
 * TDD tests for scripts/deploy-required-edge-functions.mjs (CLOSEOUT section 3).
 *
 * Run: `node --test scripts/deploy-required-edge-functions.test.mjs`.
 * Hermetic: exercises the pure plan/guard/probe API only — never spawns
 * supabase, never deploys anything, never touches the network (the 401
 * probe runs against an injected fake fetch; the live probe is
 * owner-runner only).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  REQUIRED_FUNCTIONS,
  FORBIDDEN_FUNCTIONS,
  buildDeploymentPlan,
  deployArgs,
  formatPlan,
  assertNoForbidden,
  preflightBlockers,
  classifyAuthGuardProbe,
  probeDeleteAccountAuthGuard,
} from "./deploy-required-edge-functions.mjs";

describe("deploy-required-edge-functions plan", () => {
  it("includes delete-account last in the required set (live gap closure)", () => {
    const names = REQUIRED_FUNCTIONS.map((f) => f.name);
    assert.ok(names.includes("delete-account"));
    assert.equal(names[names.length - 1], "delete-account");
  });

  it("forbids the retired server assistant", () => {
    assert.deepEqual(FORBIDDEN_FUNCTIONS, ["ai-help"]);
  });

  it("orders the current production set without the retired server assistant", () => {
    assert.deepEqual(
      REQUIRED_FUNCTIONS.map((f) => f.name),
      ["reply-comment", "push-dispatch", "cleanup-report-media", "chat-wake", "cleanup-comment-media", "delete-account"],
    );
  });

  it("keeps JWT verification ON for delete-account, OFF for functions with their own auth boundary", () => {
    const byName = Object.fromEntries(REQUIRED_FUNCTIONS.map((f) => [f.name, f.verifyJwt]));
    assert.equal(byName["ai-help"], undefined);
    assert.equal(byName["delete-account"], true);
    assert.equal(byName["reply-comment"], false);
    assert.equal(byName["push-dispatch"], false);
    assert.equal(byName["cleanup-comment-media"], false);
  });

  it("gates comment cleanup on its current pending-status migration, not the retired lease-only flag", () => {
    const none = buildDeploymentPlan({}).map((f) => f.name);
    assert.ok(!none.includes("cleanup-comment-media"), "cleanup gated off without the lease migration");
    assert.ok(!none.includes("delete-account"), "delete-account gated off without the fence migration");
    const cleanupOnly = buildDeploymentPlan({ cleanupMigrationsLive: true }).map((f) => f.name);
    assert.ok(!cleanupOnly.includes("cleanup-comment-media"), "legacy lease-only acknowledgement cannot deploy the new worker");
    assert.ok(!cleanupOnly.includes("delete-account"), "delete-account still gated by the fence migration, not the cleanup one");
    const both = buildDeploymentPlan({ liveMigrations: ["20261013020000", "20261102210000", "20261102220000", "20261014010000"] }).map((f) => f.name);
    assert.ok(both.includes("cleanup-comment-media"), "cleanup included");
    assert.ok(both.includes("delete-account"), "delete-account included once the fence migration is live");
    const fenceOnly = buildDeploymentPlan({ liveMigrations: ["20261014010000"] }).map((f) => f.name);
    assert.ok(fenceOnly.includes("delete-account"), "fence migration alone unblocks delete-account");
    assert.ok(!fenceOnly.includes("cleanup-comment-media"), "cleanup still gated by its own migration");
    const old = buildDeploymentPlan({ liveMigrations: ["20261013020000", "20261102210000"] }).map((f) => f.name);
    assert.ok(!old.includes("cleanup-comment-media"), "private staging without pending RPC is insufficient");
  });

  it("every gated step names a migration that a repository migration file provides", () => {
    const migrations = new Set(
      readdirSync(join(dirname(fileURLToPath(import.meta.url)), "..", "supabase", "migrations"))
        .map((name) => name.slice(0, 14)),
    );
    for (const fn of REQUIRED_FUNCTIONS) {
      if (!fn.requiresMigrationsLive) continue;
      assert.ok(migrations.has(fn.requiresMigrationsLive), `${fn.name}: ${fn.requiresMigrationsLive} exists as a migration`);
    }
  });

  it("builds flags-free argv for delete-account, --no-verify-jwt for the rest", () => {
    assert.deepEqual(deployArgs({ name: "delete-account", verifyJwt: true }), [
      "functions",
      "deploy",
      "delete-account",
    ]);
    assert.deepEqual(deployArgs({ name: "push-dispatch", verifyJwt: false }), [
      "functions",
      "deploy",
      "push-dispatch",
      "--no-verify-jwt",
    ]);
  });

  it("blocks push-dispatch deploy when push-config is not PASS", () => {
    const plan = buildDeploymentPlan({ liveMigrations: ["20261013020000", "20261014010000"] });
    assert.equal(preflightBlockers({ plan, pushOk: true }).length, 0);
    assert.equal(preflightBlockers({ plan, pushOk: false }).length, 1);
  });

  it("still refuses forbidden functions when a forbidden list is supplied", () => {
    assert.throws(() => assertNoForbidden(["ai-help", "delete-account"], ["delete-account"]), /forbidden/);
    assert.throws(() => assertNoForbidden(["ai-help", "push-dispatch"]), /forbidden/);
    assert.doesNotThrow(() => assertNoForbidden(["push-dispatch", "delete-account"]));
  });

  it("renders a names-only plan and states delete-account is included JWT-verify ON", () => {
    const report = formatPlan(buildDeploymentPlan({ liveMigrations: ["20261102220000", "20261014010000"] }));
    for (const name of ["reply-comment", "push-dispatch", "cleanup-comment-media", "delete-account"]) {
      assert.ok(report.includes(name));
    }
    assert.match(report, /delete-account included/);
    assert.doesNotMatch(report, /NEVER included/);
  });
});

describe("delete-account unauthenticated 401 probe (non-destructive)", () => {
  it("classifies 401 as guard-intact, anything else as a failure with evidence", () => {
    assert.deepEqual(classifyAuthGuardProbe({ status: 401 }), { ok: true });
    const bad = classifyAuthGuardProbe({ status: 200 });
    assert.equal(bad.ok, false);
    assert.match(bad.reason, /expected 401, got 200/);
  });

  it("probes with POST and NO credentials, and passes on 401", async () => {
    const seen = [];
    const fakeFetch = async (url, init) => {
      seen.push({ url, init });
      return { status: 401 };
    };
    const result = await probeDeleteAccountAuthGuard(fakeFetch, "https://proj.functions.supabase.co/delete-account");
    assert.deepEqual(result, { ok: true });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].init.method, "POST");
    const headers = seen[0].init.headers ?? {};
    assert.ok(!("authorization" in headers), "probe must never send credentials");
    assert.ok(!("apikey" in headers), "probe must never send credentials");
  });

  it("fails the probe when the guard does not return 401", async () => {
    const fakeFetch = async () => ({ status: 200 });
    const result = await probeDeleteAccountAuthGuard(fakeFetch, "https://example.invalid/delete-account");
    assert.equal(result.ok, false);
  });
});
