#!/usr/bin/env node
/**
 * TDD tests for scripts/check-edge-parity.mjs (SYNC-13/14/15).
 *
 * Run: `node --test scripts/check-edge-parity.test.mjs` from the repo root.
 * Hermetic: fixtures only, injected readers/manifests, no network, no disk
 * (except the module under test). Never prints secret material (hashes here
 * are of public fixture strings, not credentials).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  EDGE_FUNCTIONS,
  sha256Hex,
  computeLocalHashes,
  parseManifest,
  checkParity,
  summarize,
  formatParityReport,
} from "./check-edge-parity.mjs";

const FIXTURE_SOURCE = {
  "ai-help": "ai-help source v1",
  "push-dispatch": "push-dispatch source v1",
  "reply-comment": "reply-comment source v1",
  "cleanup-comment-media": "cleanup-comment-media source v1",
  "delete-account": "delete-account source v1",
};

const fixtureReader = (name) => {
  if (!(name in FIXTURE_SOURCE)) throw new Error(`no fixture: ${name}`);
  return FIXTURE_SOURCE[name];
};

const manifestFor = (overrides = {}) =>
  EDGE_FUNCTIONS.map((name) => ({
    name,
    sha256: overrides[name] ?? sha256Hex(FIXTURE_SOURCE[name]),
    version: "1",
    verify_jwt: true,
  }));

describe("check-edge-parity fixtures", () => {
  it("covers exactly the five edge functions", () => {
    assert.deepEqual([...EDGE_FUNCTIONS].sort(), [
      "ai-help",
      "cleanup-comment-media",
      "delete-account",
      "push-dispatch",
      "reply-comment",
    ]);
  });

  it("accepts matching hashes as CURRENT (exit 0)", () => {
    const localHashes = computeLocalHashes(fixtureReader);
    const results = checkParity({ localHashes, manifestEntries: manifestFor() });
    assert.ok(results.every((row) => row.status === "CURRENT"));
    assert.equal(summarize(results).exitCode, 0);
  });

  it("detects stale deployments when a sha256 differs (exit 1)", () => {
    const localHashes = computeLocalHashes(fixtureReader);
    const manifest = manifestFor({ "push-dispatch": "0".repeat(64) });
    const results = checkParity({ localHashes, manifestEntries: manifest });
    const row = results.find((r) => r.name === "push-dispatch");
    assert.equal(row.status, "STALE");
    assert.equal(row.local, sha256Hex(FIXTURE_SOURCE["push-dispatch"]));
    assert.equal(row.deployed, "0".repeat(64));
    assert.ok(results.filter((r) => r.name !== "push-dispatch").every((r) => r.status === "CURRENT"));
    const summary = summarize(results);
    assert.equal(summary.STALE, 1);
    assert.equal(summary.exitCode, 1);
  });

  it("flags missing manifest entries as MISSING (exit 1)", () => {
    const localHashes = computeLocalHashes(fixtureReader);
    const manifest = manifestFor().filter((entry) => entry.name !== "delete-account");
    const results = checkParity({ localHashes, manifestEntries: manifest });
    assert.equal(results.find((r) => r.name === "delete-account").status, "MISSING");
    assert.equal(summarize(results).exitCode, 1);
  });

  it("flags unreadable repo sources as MISSING without throwing", () => {
    const localHashes = computeLocalHashes(() => {
      throw new Error("ENOENT");
    });
    const results = checkParity({ localHashes, manifestEntries: manifestFor() });
    assert.ok(results.every((row) => row.status === "MISSING"));
    assert.equal(summarize(results).exitCode, 1);
  });

  it("rejects malformed manifests fail-closed", () => {
    assert.throws(() => parseManifest("not json"), /not valid JSON/);
    assert.throws(() => parseManifest(JSON.stringify({ nope: true })), /array or \{ functions/);
    assert.throws(
      () => parseManifest(JSON.stringify([{ name: "ai-help", sha256: "xyz" }])),
      /invalid sha256/,
    );
    assert.throws(
      () => parseManifest(JSON.stringify([{ sha256: "a".repeat(64) }])),
      /no name/,
    );
  });

  it("accepts { functions: [...] } manifest envelopes", () => {
    const entries = parseManifest(JSON.stringify({ functions: manifestFor() }));
    assert.equal(entries.length, 5);
  });

  it("report lists every function by name with counts, never secret values", () => {
    const localHashes = computeLocalHashes(fixtureReader);
    const results = checkParity({ localHashes, manifestEntries: manifestFor() });
    const report = formatParityReport(results);
    for (const name of EDGE_FUNCTIONS) assert.ok(report.includes(name), `missing ${name}`);
    assert.match(report, /5 CURRENT, 0 STALE, 0 MISSING/);
  });
});
