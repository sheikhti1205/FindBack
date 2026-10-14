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

  it("keeps no forbidden function: the old delete-account exclusion is retired", () => {
    assert.deepEqual(FORBIDDEN_FUNCTIONS, []);
  });

  it("orders the set ai-help, reply-comment, push-dispatch, cleanup-comment-media, delete-account", () => {
    assert.deepEqual(
      REQUIRED_FUNCTIONS.map((f) => f.name),
      ["ai-help", "reply-comment", "push-dispatch", "cleanup-comment-media", "delete-account"],
    );
  });

  it("keeps JWT verification ON for ai-help and delete-account, OFF for the rest", () => {
    const byName = Object.fromEntries(REQUIRED_FUNCTIONS.map((f) => [f.name, f.verifyJwt]));
    assert.equal(byName["ai-help"], true);
    assert.equal(byName["delete-account"], true);
    assert.equal(byName["reply-comment"], false);
    assert.equal(byName["push-dispatch"], false);
    assert.equal(byName["cleanup-comment-media"], false);
  });

  it("excludes cleanup-comment-media until the cleanup migration is live (delete-account is ungated)", () => {
    const withoutMigration = buildDeploymentPlan({ cleanupMigrationsLive: false }).map((f) => f.name);
    assert.ok(!withoutMigration.includes("cleanup-comment-media"));
    assert.ok(withoutMigration.includes("delete-account"));
    const withMigration = buildDeploymentPlan({ cleanupMigrationsLive: true }).map((f) => f.name);
    assert.ok(withMigration.includes("cleanup-comment-media"));
    assert.ok(withMigration.includes("delete-account"));
  });

  it("builds flags-free argv for ai-help and delete-account, --no-verify-jwt for the rest", () => {
    assert.deepEqual(deployArgs({ name: "ai-help", verifyJwt: true }), ["functions", "deploy", "ai-help"]);
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
    const plan = buildDeploymentPlan({ cleanupMigrationsLive: false });
    assert.equal(preflightBlockers({ plan, pushOk: true }).length, 0);
    assert.equal(preflightBlockers({ plan, pushOk: false }).length, 1);
  });

  it("still refuses forbidden functions when a forbidden list is supplied", () => {
    assert.throws(() => assertNoForbidden(["ai-help", "delete-account"], ["delete-account"]), /forbidden/);
    assert.doesNotThrow(() => assertNoForbidden(["ai-help", "push-dispatch"]));
    assert.doesNotThrow(() => assertNoForbidden(["ai-help", "delete-account"]));
  });

  it("renders a names-only plan and states delete-account is included JWT-verify ON", () => {
    const report = formatPlan(buildDeploymentPlan({ cleanupMigrationsLive: true }));
    for (const name of ["ai-help", "reply-comment", "push-dispatch", "cleanup-comment-media", "delete-account"]) {
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
