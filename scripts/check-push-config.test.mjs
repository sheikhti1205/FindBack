#!/usr/bin/env node
/**
 * TDD tests for scripts/check-push-config.mjs (SYNC-13/14/15).
 *
 * Run: `node --test scripts/check-push-config.test.mjs` from the repo root.
 * Hermetic: injected env objects only — never touches process.env values,
 * never prints secret material. Asserts names-only output (no values, no
 * lengths).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PUSH_ENV_KEYS,
  checkPushConfig,
  missingNames,
  formatPushReport,
  pushConfigExitCode,
  checkProjectAlignment,
  alignmentExitCode,
  formatAlignment,
} from "./check-push-config.mjs";
import { FINDBACK_FIREBASE_PROJECT_ID } from "./firebase-project-id.mjs";

const FULL_ENV = {
  FIREBASE_SERVICE_ACCOUNT_JSON: '{"type":"service_account"}',
  FCM_PROJECT_ID: FINDBACK_FIREBASE_PROJECT_ID,
  PUBLIC_SHARE_ORIGIN: "https://findbackapp.social",
  PUSH_DISPATCH_SECRET: "s3cr3t-value",
};

describe("check-push-config probe (hermetic, names only)", () => {
  it("watches exactly the four push-dispatch env names", () => {
    assert.deepEqual([...PUSH_ENV_KEYS].sort(), [
      "FCM_PROJECT_ID",
      "FIREBASE_SERVICE_ACCOUNT_JSON",
      "PUBLIC_SHARE_ORIGIN",
      "PUSH_DISPATCH_SECRET",
    ]);
  });

  it("reports all PRESENT with exit 0 when every name is set", () => {
    const results = checkPushConfig({ ...FULL_ENV });
    assert.ok(results.every((row) => row.status === "PRESENT"));
    assert.deepEqual(missingNames(results), []);
    assert.equal(pushConfigExitCode(results), 0);
    assert.match(formatPushReport(results), /PASS \(4\/4 present\)/);
  });

  it("reports missing NAMES with exit 1 when any name is absent", () => {
    const { PUSH_DISPATCH_SECRET: _dropped, ...partial } = FULL_ENV;
    const results = checkPushConfig(partial);
    assert.deepEqual(missingNames(results), ["PUSH_DISPATCH_SECRET"]);
    assert.equal(pushConfigExitCode(results), 1);
    assert.match(formatPushReport(results), /FAIL \(missing: PUSH_DISPATCH_SECRET\)/);
  });

  it("treats empty, blank, and non-string values as ABSENT", () => {
    for (const bad of ["", "   ", undefined, null, 0, 123]) {
      const results = checkPushConfig({ ...FULL_ENV, FCM_PROJECT_ID: bad });
      assert.equal(
        results.find((row) => row.name === "FCM_PROJECT_ID").status,
        "ABSENT",
        `expected ABSENT for ${String(bad)}`,
      );
    }
    assert.equal(pushConfigExitCode(checkPushConfig({})), 1);
  });

  it("never leaks values or lengths into the report", () => {
    const results = checkPushConfig({ ...FULL_ENV });
    const report = formatPushReport(results);
    for (const value of Object.values(FULL_ENV)) {
      assert.ok(!report.includes(value), `report leaks a secret value: ${value.slice(0, 8)}…`);
      assert.ok(!report.includes(value.trim().slice(0, 6)), "report leaks a value prefix");
    }
    // No char-count/length disclosures either (word-boundaried so that
    // PUBLIC_SHARE_ORIGIN itself never trips the matcher).
    assert.ok(!/\blen\b|\blength\b|\bchars\b|\bhash\b|\d+ chars/i.test(report), "report must not carry shapes");
    for (const name of PUSH_ENV_KEYS) assert.ok(report.includes(name));
  });

  it("missing report names every absent key and nothing else", () => {
    const results = checkPushConfig({});
    const report = formatPushReport(results);
    for (const name of PUSH_ENV_KEYS) assert.ok(report.includes(name));
    assert.equal(missingNames(results).length, 4);
  });
});

describe("check-push-config client/server project alignment", () => {
  it("ALIGNED when the server project equals the canonical client project", () => {
    const alignment = checkProjectAlignment({ FCM_PROJECT_ID: FINDBACK_FIREBASE_PROJECT_ID });
    assert.equal(alignment.status, "ALIGNED");
    assert.equal(alignmentExitCode(alignment), 0);
    assert.match(formatAlignment(alignment), /ALIGNED/);
  });

  it("MISMATCH (fail) when the server project differs from the client project", () => {
    const alignment = checkProjectAlignment({ FCM_PROJECT_ID: "some-other-project" });
    assert.equal(alignment.status, "MISMATCH");
    assert.equal(alignmentExitCode(alignment), 1);
    assert.match(formatAlignment(alignment), /MISMATCH/);
  });

  it("ABSENT (fail) when the server project is unset", () => {
    for (const bad of [undefined, "", "   ", null, 7]) {
      const alignment = checkProjectAlignment({ FCM_PROJECT_ID: bad });
      assert.equal(alignment.status, "ABSENT", `expected ABSENT for ${String(bad)}`);
      assert.equal(alignmentExitCode(alignment), 1);
    }
  });

  it("never leaks the project value into the alignment line", () => {
    const alignment = checkProjectAlignment({ FCM_PROJECT_ID: "some-other-project" });
    const line = formatAlignment(alignment);
    assert.ok(!line.includes("some-other-project"), "alignment line leaks the project id");
  });
});
