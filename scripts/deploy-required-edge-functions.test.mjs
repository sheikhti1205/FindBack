#!/usr/bin/env node
/**
 * TDD tests for scripts/deploy-required-edge-functions.mjs (CLOSEOUT section 3).
 *
 * Run: `node --test scripts/deploy-required-edge-functions.test.mjs`.
 * Hermetic: exercises the pure plan/guard API only — never spawns supabase,
 * never deploys anything.
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
} from "./deploy-required-edge-functions.mjs";

describe("deploy-required-edge-functions plan", () => {
  it("never includes delete-account in the required set", () => {
    const names = REQUIRED_FUNCTIONS.map((f) => f.name);
    assert.ok(!names.includes("delete-account"));
    assert.deepEqual(FORBIDDEN_FUNCTIONS, ["delete-account"]);
  });

  it("orders the set ai-help, reply-comment, push-dispatch, cleanup-comment-media", () => {
    assert.deepEqual(
      REQUIRED_FUNCTIONS.map((f) => f.name),
      ["ai-help", "reply-comment", "push-dispatch", "cleanup-comment-media"],
    );
  });

  it("keeps JWT verification ON only for ai-help", () => {
    const byName = Object.fromEntries(REQUIRED_FUNCTIONS.map((f) => [f.name, f.verifyJwt]));
    assert.equal(byName["ai-help"], true);
    assert.equal(byName["reply-comment"], false);
    assert.equal(byName["push-dispatch"], false);
    assert.equal(byName["cleanup-comment-media"], false);
  });

  it("excludes cleanup-comment-media until the cleanup migration is live", () => {
    const withoutMigration = buildDeploymentPlan({ cleanupMigrationsLive: false }).map((f) => f.name);
    assert.ok(!withoutMigration.includes("cleanup-comment-media"));
    const withMigration = buildDeploymentPlan({ cleanupMigrationsLive: true }).map((f) => f.name);
    assert.ok(withMigration.includes("cleanup-comment-media"));
  });

  it("builds flags-free argv for ai-help and --no-verify-jwt for the rest", () => {
    assert.deepEqual(deployArgs({ name: "ai-help", verifyJwt: true }), ["functions", "deploy", "ai-help"]);
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

  it("refuses forbidden functions (delete-account) anywhere", () => {
    assert.throws(() => assertNoForbidden(["ai-help", "delete-account"]), /forbidden/);
    assert.doesNotThrow(() => assertNoForbidden(["ai-help", "push-dispatch"]));
  });

  it("renders a names-only plan and states delete-account is excluded", () => {
    const report = formatPlan(buildDeploymentPlan({ cleanupMigrationsLive: true }));
    for (const name of ["ai-help", "reply-comment", "push-dispatch", "cleanup-comment-media"]) {
      assert.ok(report.includes(name));
    }
    assert.match(report, /delete-account NEVER included/);
  });
});
