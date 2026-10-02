#!/usr/bin/env node
/**
 * Tests for scripts/check-commit-messages.mjs.
 *
 * Run: `node --test scripts/check-commit-messages.test.mjs` from repo root.
 * Pure Node builtins. Never prints key material.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { checkMessage, classifyCommit, isExempt, parseBaseline } from "./check-commit-messages.mjs";

const GATED_BODY = "Gates: typecheck, lint, node --test scripts/x.test.mjs";

describe("classifyCommit", () => {
  it("skips merge commits", () => {
    assert.equal(classifyCommit("Merge pull request #12 from foo"), "skip");
    assert.equal(classifyCommit("Merge branch 'main'"), "skip");
  });
  it("skips revert commits", () => {
    assert.equal(classifyCommit('Revert "fix: something"'), "skip");
  });
  it("skips generated dependency bumps", () => {
    assert.equal(classifyCommit("Bump lodash from 4.0.0 to 4.1.0"), "skip");
    assert.equal(classifyCommit("chore(deps): bump vite"), "skip");
  });
  it("treats normal commits as normal", () => {
    assert.equal(classifyCommit("fix: handle empty list"), "normal");
  });
});

describe("checkMessage subject shape", () => {
  it("accepts a canonical scoped outcome with gated body", () => {
    const r = checkMessage("fix: reject placeholder key in preflight", GATED_BODY);
    assert.equal(r.ok, true);
  });
  it("accepts every canonical scope", () => {
    for (const scope of ["release", "build", "ai", "android", "fix", "docs", "test", "refactor"]) {
      const body = scope === "docs" ? "" : GATED_BODY;
      const r = checkMessage(`${scope}: some outcome here`, body);
      assert.equal(r.ok, true, scope);
    }
  });
  it("rejects upper-case scopes and missing colons", () => {
    assert.equal(checkMessage("Fix: something here", GATED_BODY).ok, false);
    assert.equal(checkMessage("fix something here", GATED_BODY).ok, false);
    assert.equal(checkMessage("FIX: something here", GATED_BODY).ok, false);
  });
  it("rejects upper-case outcomes, trailing periods, long subjects", () => {
    assert.equal(checkMessage("fix: Something here", GATED_BODY).ok, false);
    assert.equal(checkMessage("fix: something here.", GATED_BODY).ok, false);
    assert.equal(checkMessage(`fix: ${"x".repeat(70)}`, GATED_BODY).ok, false);
  });
});

describe("checkMessage prohibitions", () => {
  it("rejects wave/phase labels in the subject", () => {
    assert.equal(checkMessage("ai: wave 2 relay vertical", GATED_BODY).ok, false);
    assert.equal(checkMessage("fix: phase 3 cleanup", GATED_BODY).ok, false);
  });
  it("rejects worker/model names in the subject", () => {
    assert.equal(checkMessage("ai: sonnet adapter refresh", GATED_BODY).ok, false);
    assert.equal(checkMessage("docs: opencode runbook", GATED_BODY).ok, false);
  });
  it("rejects test counts in the subject", () => {
    assert.equal(checkMessage("test: add 12 tests for parser", GATED_BODY).ok, false);
  });
  it("rejects WIP subjects", () => {
    assert.equal(checkMessage("wip: half done", GATED_BODY).ok, false);
  });
});

describe("checkMessage body-gate rule", () => {
  it("requires gate mentions for non-docs scopes", () => {
    const r = checkMessage("fix: handle empty list", "just fixing stuff");
    assert.equal(r.ok, false);
    assert.match(r.errors.join(";"), /gates/i);
  });
  it("exempts docs-scoped commits from the body rule", () => {
    assert.equal(checkMessage("docs: update runbook", "").ok, true);
  });
  it("exempts skipped commits from the body rule", () => {
    const r = checkMessage("Merge pull request #1 from x", "");
    assert.equal(r.ok, true);
    assert.equal(r.skipped, true);
  });
});

describe("enforcement baseline", () => {
  const ABDA = "abda2c78661372075e8b08e32eb4d5f4c6325984";

  it("parses SHAs and ignores comments/blank lines", () => {
    const baseline = parseBaseline(`# header\n\n${ABDA}\n`);
    assert.equal(baseline.has(ABDA), true);
    assert.equal(baseline.size, 1);
  });

  it("matches SHAs case-insensitively", () => {
    const baseline = parseBaseline(ABDA);
    assert.equal(isExempt(ABDA.toUpperCase(), baseline), true);
    assert.equal(isExempt("deadbeef", baseline), false);
    assert.equal(isExempt(undefined, baseline), false);
    assert.equal(isExempt(ABDA, new Set()), false);
  });

  it("skips a pre-enforcement commit that would otherwise fail", () => {
    const baseline = parseBaseline(ABDA);
    const r = checkMessage("feat: add canonical report sharing", "no gates recorded", {
      sha: ABDA,
      baseline,
    });
    assert.equal(r.ok, true);
    assert.equal(r.skipped, true);
  });

  it("still enforces a commit that is not in the baseline", () => {
    const baseline = parseBaseline(ABDA);
    const r = checkMessage("feat: add canonical report sharing", "no gates recorded", {
      sha: "0123456789abcdef0123456789abcdef01234567",
      baseline,
    });
    assert.equal(r.ok, false);
  });
});
