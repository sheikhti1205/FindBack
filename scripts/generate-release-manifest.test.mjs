#!/usr/bin/env node
/**
 * Tests for scripts/generate-release-manifest.mjs.
 *
 * Run: `node --test scripts/generate-release-manifest.test.mjs` from repo root.
 * Pure Node builtins. Never prints key material.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildManifest } from "./generate-release-manifest.mjs";

const FULL_SHA = "97ca7f5b3e104646038310b81ca5b69afef96efb";
const SHORT_SHA = "97ca7f5b3e10";

function tmpFiles() {
  const dir = mkdtempSync(join(tmpdir(), "manifest-"));
  const a = join(dir, "b.apk");
  const b = join(dir, "a.apk");
  writeFileSync(a, "fake-apk-b");
  writeFileSync(b, "fake-apk-a");
  return { dir, files: [a, b] };
}

const BASE = {
  versionName: "0.1.0-beta.1",
  versionCode: 100001,
  tag: "v0.1.0-beta.1",
  minSdk: 24,
  targetSdk: 36,
};

describe("buildManifest", () => {
  it("accepts a full 40-char git SHA and records it verbatim", () => {
    const { files } = tmpFiles();
    const m = buildManifest({ ...BASE, gitSha: FULL_SHA, files });
    assert.equal(m.gitSha, FULL_SHA);
    assert.equal(m.gitSha.length, 40);
  });

  it("rejects a short SHA (provenance must never be truncated)", () => {
    const { files } = tmpFiles();
    assert.throws(() => buildManifest({ ...BASE, gitSha: SHORT_SHA, files }), /full 40-char/);
    assert.throws(() => buildManifest({ ...BASE, gitSha: "", files }), /full 40-char/);
    assert.throws(() => buildManifest({ ...BASE, gitSha: undefined, files }), /full 40-char/);
  });

  it("hashes real file bytes and sorts artifacts by filename", () => {
    const { files } = tmpFiles();
    const m = buildManifest({ ...BASE, gitSha: FULL_SHA, files });
    assert.deepEqual(
      m.artifacts.map((a) => a.file),
      ["a.apk", "b.apk"],
    );
    for (const art of m.artifacts) {
      const expected = createHash("sha256").update(readFileSync(join(files[0], "..", art.file))).digest("hex");
      assert.equal(art.sha256, expected);
      assert.ok(art.bytes > 0);
    }
  });

  it("throws on a missing file (fail closed, never invent entries)", () => {
    const { dir } = tmpFiles();
    assert.throws(() => buildManifest({ ...BASE, gitSha: FULL_SHA, files: [join(dir, "nope.apk")] }));
  });
});

describe("CLI", () => {
  it("writes a manifest end-to-end with a full SHA", () => {
    const { dir, files } = tmpFiles();
    const out = join(dir, "release-manifest.json");
    execFileSync("node", [
      "scripts/generate-release-manifest.mjs",
      "--tag", "v0.1.0-beta.1",
      "--apk-dir", dir,
      "--aab", files[0],
      "--version-code", "100001",
      "--git-sha", FULL_SHA,
      "--min-sdk", "24",
      "--target-sdk", "36",
      "--out", out,
    ]);
    const m = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(m.gitSha, FULL_SHA);
    assert.ok(m.artifacts.length >= 2);
  });

  it("CLI rejects a short SHA", () => {
    const { dir, files } = tmpFiles();
    assert.throws(() =>
      execFileSync("node", [
        "scripts/generate-release-manifest.mjs",
        "--tag", "v0.1.0-beta.1",
        "--apk-dir", dir,
        "--aab", files[0],
        "--version-code", "100001",
        "--git-sha", SHORT_SHA,
        "--min-sdk", "24",
        "--target-sdk", "36",
        "--out", join(dir, "out.json"),
      ]),
    );
  });
});
