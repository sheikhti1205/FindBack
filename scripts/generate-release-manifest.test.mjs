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


function stagedFiles() {
  const dir = mkdtempSync(join(tmpdir(), "manifest-facts-"));
  const arm = join(dir, "Norfold-v0.1.0-beta.1-arm64-v8a.apk");
  const universal = join(dir, "Norfold-v0.1.0-beta.1-universal.apk");
  const aab = join(dir, "Norfold-v0.1.0-beta.1.aab");
  writeFileSync(arm, "fake-arm-apk");
  writeFileSync(universal, "fake-universal-apk");
  writeFileSync(aab, "fake-aab");
  return { dir, arm, universal, aab };
}

const SIGNER = "ab".repeat(32);

function verifiedFacts() {
  const base = {
    packageName: "com.findback.app",
    versionName: BASE.versionName,
    versionCode: BASE.versionCode,
    minSdk: 24,
    targetSdk: 36,
    signerSha256: SIGNER,
  };
  return [
    { ...base, abi: "arm64-v8a", abis: ["arm64-v8a"] },
    { ...base, abi: "universal", abis: ["arm64-v8a", "armeabi-v7a", "x86_64"] },
  ];
}

describe("buildManifest with verified APK facts", () => {
  it("merges each APK's verified identity and leaves the bundle as a bundle", () => {
    const { arm, universal, aab } = stagedFiles();
    const m = buildManifest({
      ...BASE,
      gitSha: FULL_SHA,
      files: [arm, universal, aab],
      facts: verifiedFacts(),
      signingChannel: "beta",
    });
    const byName = Object.fromEntries(m.artifacts.map((a) => [a.file, a]));
    const armArtifact = byName["Norfold-v0.1.0-beta.1-arm64-v8a.apk"];
    assert.equal(armArtifact.kind, "apk");
    assert.equal(armArtifact.packageName, "com.findback.app");
    assert.equal(armArtifact.signingChannel, "beta");
    assert.equal(armArtifact.signerSha256, SIGNER);
    assert.deepEqual(armArtifact.abis, ["arm64-v8a"]);
    assert.equal(armArtifact.versionCode, BASE.versionCode);
    assert.deepEqual(byName["Norfold-v0.1.0-beta.1-universal.apk"].abis, [
      "arm64-v8a",
      "armeabi-v7a",
      "x86_64",
    ]);
    assert.equal(byName["Norfold-v0.1.0-beta.1.aab"].kind, "bundle");
    assert.equal(byName["Norfold-v0.1.0-beta.1.aab"].packageName, undefined);
    assert.equal(m.packageName, "com.findback.app");
    assert.equal(m.signingChannel, "beta");
  });

  it("records bytes/hashes but no identity when facts are absent", () => {
    const { arm } = stagedFiles();
    const m = buildManifest({ ...BASE, gitSha: FULL_SHA, files: [arm] });
    assert.equal(m.artifacts[0].kind, "apk");
    assert.equal(m.artifacts[0].packageName, undefined);
    assert.equal(m.packageName, undefined);
  });

  it("requires facts and the channel together", () => {
    const { arm } = stagedFiles();
    assert.throws(
      () => buildManifest({ ...BASE, gitSha: FULL_SHA, files: [arm], facts: verifiedFacts() }),
      /required together/,
    );
    assert.throws(
      () => buildManifest({ ...BASE, gitSha: FULL_SHA, files: [arm], signingChannel: "beta" }),
      /required together/,
    );
  });

  it("fails closed when an APK has no verified row", () => {
    const { arm, universal } = stagedFiles();
    assert.throws(
      () =>
        buildManifest({
          ...BASE,
          gitSha: FULL_SHA,
          files: [arm, universal],
          facts: verifiedFacts().slice(0, 1),
          signingChannel: "beta",
        }),
      /no single verified facts row/,
    );
  });

  it("fails closed when a verified row matches no APK", () => {
    const { arm } = stagedFiles();
    assert.throws(
      () =>
        buildManifest({
          ...BASE,
          gitSha: FULL_SHA,
          files: [arm],
          facts: verifiedFacts(),
          signingChannel: "beta",
        }),
      /match no APK/,
    );
  });

  it("rejects facts that disagree with the release identity", () => {
    const { arm } = stagedFiles();
    const wrongCode = verifiedFacts().map((row) => ({ ...row, versionCode: 999 }));
    assert.throws(
      () =>
        buildManifest({
          ...BASE,
          gitSha: FULL_SHA,
          files: [arm],
          facts: wrongCode,
          signingChannel: "beta",
        }),
      /versionCode/,
    );
    const wrongName = verifiedFacts().map((row) => ({ ...row, versionName: "9.9.9" }));
    assert.throws(
      () =>
        buildManifest({
          ...BASE,
          gitSha: FULL_SHA,
          files: [arm],
          facts: wrongName,
          signingChannel: "beta",
        }),
      /versionName/,
    );
  });

  it("rejects rows that describe different builds", () => {
    const { arm, universal } = stagedFiles();
    const mixed = verifiedFacts();
    mixed[1] = { ...mixed[1], signerSha256: "cd".repeat(32) };
    assert.throws(
      () =>
        buildManifest({
          ...BASE,
          gitSha: FULL_SHA,
          files: [arm, universal],
          facts: mixed,
          signingChannel: "beta",
        }),
      /disagrees on signerSha256/,
    );
    const badRange = verifiedFacts().map((row) => ({ ...row, minSdk: 40 }));
    assert.throws(
      () =>
        buildManifest({
          ...BASE,
          gitSha: FULL_SHA,
          files: [arm, universal],
          facts: badRange,
          signingChannel: "beta",
        }),
      /SDK range/,
    );
  });

  it("writes facts end-to-end through the CLI", () => {
    const { dir, arm, universal, aab } = stagedFiles();
    const factsPath = join(dir, "facts.json");
    // The CLI reads versionName from apps/mobile/package.json (never bumped here),
    // so the verified rows must describe that same build.
    const pkgVersion = JSON.parse(readFileSync("apps/mobile/package.json", "utf8")).version;
    writeFileSync(
      factsPath,
      JSON.stringify(verifiedFacts().map((row) => ({ ...row, versionName: pkgVersion }))),
    );
    const out = join(dir, "release-manifest.json");
    // --apk-dir is globbed, so keep the facts file out of it.
    const apkDir = mkdtempSync(join(tmpdir(), "manifest-apkdir-"));
    for (const source of [arm, universal]) {
      writeFileSync(join(apkDir, source.split("/").pop()), readFileSync(source));
    }
    execFileSync("node", [
      "scripts/generate-release-manifest.mjs",
      "--tag", BASE.tag,
      "--apk-dir", apkDir,
      "--aab", aab,
      "--version-code", String(BASE.versionCode),
      "--git-sha", FULL_SHA,
      "--min-sdk", "24",
      "--target-sdk", "36",
      "--facts", factsPath,
      "--signing-channel", "beta",
      "--out", out,
    ]);
    const m = JSON.parse(readFileSync(out, "utf8"));
    const apks = m.artifacts.filter((a) => a.kind === "apk");
    assert.equal(apks.length, 2);
    for (const apk of apks) {
      assert.equal(apk.packageName, "com.findback.app");
      assert.equal(apk.signingChannel, "beta");
      assert.equal(apk.signerSha256, SIGNER);
    }
  });
});
