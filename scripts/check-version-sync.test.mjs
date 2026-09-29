#!/usr/bin/env node
/**
 * Tests for scripts/check-version-sync.mjs.
 *
 * Run: `node --test scripts/check-version-sync.test.mjs` from repo root.
 * Pure Node builtins. Never prints key material.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { assertSync } from "./check-version-sync.mjs";

const CLEAN = {
  rootVersion: "0.1.0-beta.1",
  mobileVersion: "0.1.0-beta.1",
  tag: null,
  headSha: "abc",
  tagSha: null,
  dirtyFiles: [],
};

describe("assertSync", () => {
  it("passes when versions match on an untagged clean tree", () => {
    assert.deepEqual(assertSync(CLEAN), []);
  });
  it("fails on root/mobile version mismatch", () => {
    const errors = assertSync({ ...CLEAN, mobileVersion: "0.2.0" });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /mismatch/);
  });
  it("passes when the tag equals v+mobile version on the tagged commit", () => {
    const errors = assertSync({
      ...CLEAN,
      tag: "v0.1.0-beta.1",
      headSha: "abc123",
      tagSha: "abc123",
    });
    assert.deepEqual(errors, []);
  });
  it("fails when the tag differs from v+mobile version", () => {
    const errors = assertSync({
      ...CLEAN,
      tag: "v0.2.0",
      headSha: "abc123",
      tagSha: "abc123",
    });
    assert.ok(errors.some((e) => /tag\/version mismatch/.test(e)));
  });
  it("fails when the checkout is not the tagged commit", () => {
    const errors = assertSync({
      ...CLEAN,
      tag: "v0.1.0-beta.1",
      headSha: "def456",
      tagSha: "abc123",
    });
    assert.ok(errors.some((e) => /exact tagged commit/.test(e)));
  });
  it("fails on a dirty tree", () => {
    const errors = assertSync({ ...CLEAN, dirtyFiles: ["M scripts/x.mjs"] });
    assert.ok(errors.some((e) => /dirty/.test(e)));
  });
});
