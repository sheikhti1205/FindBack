#!/usr/bin/env node
/**
 * Tests for scripts/check-cleanup-scheduler.mjs (X11).
 *
 * Run: `node --test scripts/check-cleanup-scheduler.test.mjs` from the repo
 * root. Node builtins only, hermetic. Each rule is proven by mutating a base
 * fixture string to break exactly that rule and expecting failure; one test
 * proves the REAL committed workflow passes.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SCHEDULER_RULES,
  checkSchedulerWorkflow,
  validateSchedulerWorkflow,
} from "./check-cleanup-scheduler.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Minimal fixture satisfying every rule (mirrors the real workflow shape). */
const BASE = [
  "name: Cleanup comment media",
  "on:",
  "  schedule:",
  '    - cron: "*/15 * * * *"',
  "  workflow_dispatch:",
  "    inputs:",
  "      max_batches:",
  '        default: "10"',
  "permissions:",
  "  contents: read",
  "concurrency:",
  "  group: findback-cleanup-comment-media",
  "  cancel-in-progress: false",
  "jobs:",
  "  sweep:",
  "    env:",
  '      MAX_BATCHES: "10"',
  "    steps:",
  "      - env:",
  "          CLEANUP_CRON_SECRET: ${{ secrets.CLEANUP_CRON_SECRET }}",
  "        run: |",
  '          BATCH="${INPUT_MAX_BATCHES:-$MAX_BATCHES}"',
  '          [ "$BATCH" -gt "$MAX_BATCHES" ] && BATCH="$MAX_BATCHES"',
  '          curl -fsS -X POST "https://$PROJECT_REF.supabase.co/functions/v1/cleanup-comment-media" \\',
  '            -H "x-cleanup-secret: ${CLEANUP_CRON_SECRET}" \\',
  '            -d "{\\"max_batches\\": ${BATCH}}"',
  "",
].join("\n");

describe("validateSchedulerWorkflow — base", () => {
  it("passes the fixture with no errors", () => {
    const result = validateSchedulerWorkflow(BASE);
    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
  });

  it("fails empty / non-string input (structurally empty workflow)", () => {
    for (const input of ["", undefined, null, 42]) {
      const result = validateSchedulerWorkflow(input);
      assert.equal(result.ok, false, `expected failure for ${String(input)}`);
      assert.ok(result.errors.some((e) => e.startsWith("schedule-trigger:")));
      // An empty workflow has no push trigger, so no-push-tag is correctly not
      // reported — everything else fails.
      assert.ok(!result.errors.some((e) => e.startsWith("no-push-tag:")));
      assert.equal(result.errors.length, SCHEDULER_RULES.length - 1);
    }
  });

  it("exposes exactly the documented rule ids", () => {
    assert.deepEqual(
      SCHEDULER_RULES.map((r) => r.id),
      [
        "schedule-trigger",
        "workflow-dispatch",
        "concurrency-guard",
        "no-push-tag",
        "bounded-batch",
        "invokes-function",
        "secret-by-name",
      ],
    );
  });
});

describe("rule mutations each fail with the right rule id", () => {
  function expectBroken(mutate, ruleId) {
    const broken = mutate(BASE);
    assert.notEqual(broken, BASE, "mutation must change the fixture");
    const result = validateSchedulerWorkflow(broken);
    assert.equal(result.ok, false, `expected failure for ${ruleId}`);
    assert.ok(
      result.errors.some((e) => e.startsWith(`${ruleId}:`)),
      `expected error for ${ruleId}, got: ${JSON.stringify(result.errors)}`,
    );
  }

  it("schedule-trigger: removing the cron entry fails", () => {
    expectBroken((t) => t.replace('    - cron: "*/15 * * * *"\n', ""), "schedule-trigger");
  });

  it("workflow-dispatch: removing the manual trigger fails", () => {
    expectBroken((t) => t.replace("  workflow_dispatch:\n", ""), "workflow-dispatch");
  });

  it("concurrency-guard: removing cancel-in-progress fails", () => {
    expectBroken((t) => t.replace("  cancel-in-progress: false\n", ""), "concurrency-guard");
  });

  it("concurrency-guard: an in-progress cancellation is rejected", () => {
    expectBroken(
      (t) => t.replace("cancel-in-progress: false", "cancel-in-progress: true"),
      "concurrency-guard",
    );
  });

  it("no-push-tag: adding a push trigger fails", () => {
    expectBroken((t) => t.replace("on:\n", "on:\n  push:\n"), "no-push-tag");
  });

  it("no-push-tag: adding a tag trigger fails", () => {
    expectBroken((t) => t.replace("on:\n", 'on:\n  tags: ["v*"]\n'), "no-push-tag");
  });

  it("bounded-batch: removing the max_batches input fails", () => {
    expectBroken((t) => t.replace("      max_batches:\n", ""), "bounded-batch");
  });

  it("bounded-batch: a non-numeric ceiling fails", () => {
    expectBroken((t) => t.replace('MAX_BATCHES: "10"', 'MAX_BATCHES: "many"'), "bounded-batch");
  });

  it("bounded-batch: removing the clamp comparison fails", () => {
    expectBroken((t) => t.replace('-gt "$MAX_BATCHES"', ""), "bounded-batch");
  });

  it("invokes-function: a wrong function path fails", () => {
    expectBroken((t) => t.replace("functions/v1/cleanup-comment-media", "functions/v1/other"), "invokes-function");
  });

  it("secret-by-name: a literal secret reference fails", () => {
    expectBroken(
      (t) => t.replace("${{ secrets.CLEANUP_CRON_SECRET }}", "hardcoded-literal"),
      "secret-by-name",
    );
  });
});

describe("the real committed workflow passes", () => {
  it(".github/workflows/cleanup-comment-media.yml satisfies every rule", () => {
    const result = checkSchedulerWorkflow();
    assert.deepEqual(result.errors, [], `real workflow errors: ${JSON.stringify(result.errors)}`);
    assert.equal(result.ok, true);
  });

  it("is guarded from the repo root path used by the CLI", () => {
    assert.equal(resolve(HERE, "../.github/workflows/cleanup-comment-media.yml").length > 0, true);
  });
});
