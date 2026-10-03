#!/usr/bin/env node
/**
 * Tests for scripts/verify-release-apks.sh pure helpers.
 *
 * Drives the shell functions directly (`VERIFY_RELEASE_APKS_TEST=1 source
 * ...`) so the test exercises the shipped script, not a copy. Fixtures are
 * synthetic file lists / representative apksigner output — no real binaries,
 * no key material (digests below are non-secret dummy hex).
 *
 * Run: `node --test scripts/verify-release-apks.test.mjs` from repo root.
 */
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SHELL_LIB = "scripts/verify-release-apks.sh";

/** Run a bash snippet with the verifier's helpers sourced. */
function sh(snippet, input = undefined) {
  return execFileSync("bash", ["-c", `VERIFY_RELEASE_APKS_TEST=1 source "${SHELL_LIB}"; ${snippet}`], {
    encoding: "utf8",
    input,
    cwd: process.cwd(),
  }).trim();
}

// Representative `apksigner verify --verbose --print-certs` output shape.
// Dummy hex only — never a real certificate fingerprint.
const APKSIGNER_FIXTURE = [
  "Verifies",
  "Verified using v1 scheme (JAR signing): false",
  "Verified using v2 scheme (APK Signature Scheme v2): true",
  "Verified using v3 scheme (APK Signature Scheme v3): false",
  "Number of signers: 1",
  "Signer #1 certificate DN: CN=Test Fixture, OU=Test, O=Test, C=US",
  "Signer #1 certificate SHA-256 digest: ab:12:cd:34:ef:56:78:90:ab:12:cd:34:ef:56:78:90:ab:12:cd:34:ef:56:78:90:ab:12:cd:34:ef:56:78:90",
  "Signer #1 certificate SHA1 digest: 11:22:33:44:55:66:77:88:99:00:aa:bb:cc:dd:ee:ff:11:22:33:44",
  "Signer #1 key algorithm (RSA) dictates signature algorithm (SHA256withRSA)",
].join("\n");

const RAW_DIGEST = "ab:12:cd:34:ef:56:78:90:ab:12:cd:34:ef:56:78:90:ab:12:cd:34:ef:56:78:90:ab:12:cd:34:ef:56:78:90";
const NORMALIZED = "AB12CD34EF567890AB12CD34EF567890AB12CD34EF567890AB12CD34EF567890";

describe("R1 fingerprint extraction ordering", () => {
  it("extracts the raw digest from the UNREDACTED capture", () => {
    assert.equal(sh("extract_cert_fp", APKSIGNER_FIXTURE), RAW_DIGEST);
  });

  it("redacted log output contains no digest hex (only a marker)", () => {
    const redacted = sh("redact_cert_log", APKSIGNER_FIXTURE);
    assert.match(redacted, /<redacted>/);
    assert.ok(!redacted.includes("ab:12"), "digest hex leaked into logs");
    assert.ok(!redacted.includes("11:22"), "SHA1 hex leaked into logs");
    // V2 verification line survives redaction (needed for the scheme check).
    assert.match(redacted, /Verified using v2 scheme.*true/);
  });

  it("REGRESSION: parsing the redacted output yields nothing (old bug); parsing the raw capture yields the fingerprint", () => {
    // Old code piped apksigner output through the digest redaction BEFORE
    // grep: prove that order destroys the value.
    const fromRedacted = sh("redact_cert_log | extract_cert_fp || true", APKSIGNER_FIXTURE);
    assert.equal(fromRedacted, "", "redacted-then-parse must yield empty (this is the old bug)");
    // New code parses the private capture: value survives, normalizes to 64 hex.
    const raw = sh("extract_cert_fp", APKSIGNER_FIXTURE);
    assert.equal(sh(`norm_fp "${raw}"`), NORMALIZED);
    assert.equal(NORMALIZED.length, 64);
    assert.match(NORMALIZED, /^[0-9A-F]{64}$/);
  });

  it("normalizes colon-separated and plain hex to the same 64-char value", () => {
    const plain = RAW_DIGEST.replaceAll(":", "");
    assert.equal(sh(`norm_fp "${plain}"`), sh(`norm_fp "${RAW_DIGEST}"`));
  });
});

// Synthetic `unzip -Z1`-style listings (file lists, not real binaries).
// Native engines are ABI-gated on purpose: arm64-v8a carries the engines,
// 32-bit and x86_64 deliberately do not (see fetch-needle-model.mjs / CMake).
const UNIVERSAL_GATED = [
  "lib/arm64-v8a/libnative.so",
  "lib/arm64-v8a/libengine.so",
  "lib/armeabi-v7a/libnative.so",
  "lib/x86_64/libnative.so",
  "classes.dex",
  "assets/public/index.html",
].join("\n");

const AAB_GATED = [
  "base/lib/arm64-v8a/libnative.so",
  "base/lib/arm64-v8a/libengine.so",
  "base/lib/armeabi-v7a/libnative.so",
  "base/lib/x86_64/libnative.so",
  "base/manifest/AndroidManifest.xml",
].join("\n");

/** Write the exact per-ABI .so reference set for `abi` from a listing. */
function refFile(listing, abi) {
  const dir = mkdtempSync(join(tmpdir(), "relref-"));
  const file = join(dir, `${abi}.txt`);
  const set = sh(`so_basenames_for_abi "${abi}"`, listing);
  writeFileSync(file, set ? `${set}\n` : "");
  return file;
}

describe("R2 ABI completeness", () => {
  it("so_basenames_for_abi returns that ABI's exact set and ignores non-.so/other ABIs", () => {
    const listing = [
      "lib/arm64-v8a/libnative.so",
      "lib/arm64-v8a/README.txt",
      "lib/armeabi-v7a/libnative.so",
      "classes.dex",
    ].join("\n");
    assert.equal(sh('so_basenames_for_abi "arm64-v8a"', listing), "libnative.so");
    // APK and AAB entry shapes both resolve for the same ABI.
    assert.equal(sh('so_basenames_for_abi "arm64-v8a"', UNIVERSAL_GATED), "libengine.so\nlibnative.so");
    assert.equal(sh('so_basenames_for_abi "arm64-v8a"', AAB_GATED), "libengine.so\nlibnative.so");
  });

  it("gated ABI with the smaller engine-free set matches its own reference exactly", () => {
    const ref = refFile(UNIVERSAL_GATED, "armeabi-v7a");
    sh(`assert_abi_matches_set "${ref}" "armeabi-v7a"`, UNIVERSAL_GATED);
    const v7aSplit = ["lib/armeabi-v7a/libnative.so", "classes.dex"].join("\n");
    sh(`assert_abi_matches_set "${ref}" "armeabi-v7a"`, v7aSplit);
    assert.equal(sh(`so_basenames_for_abi "x86_64"`, UNIVERSAL_GATED), "libnative.so");
  });

  it("arm64 split missing a gated engine fails closed and reports it", () => {
    const ref = refFile(UNIVERSAL_GATED, "arm64-v8a");
    const partial = ["lib/arm64-v8a/libnative.so", "classes.dex"].join("\n");
    const output = (() => {
      try {
        sh(`assert_abi_matches_set "${ref}" "arm64-v8a"`, partial);
        return "";
      } catch (error) {
        return String(error.stdout ?? "");
      }
    })();
    assert.match(output, /missing libengine\.so/);
    assert.throws(() => sh(`assert_abi_matches_set "${ref}" "arm64-v8a"`, partial));
  });

  it("an extra .so the reference does not carry fails closed", () => {
    const ref = refFile(UNIVERSAL_GATED, "armeabi-v7a");
    const extra = ["lib/armeabi-v7a/libnative.so", "lib/armeabi-v7a/librogue.so"].join("\n");
    assert.throws(() => sh(`assert_abi_matches_set "${ref}" "armeabi-v7a"`, extra));
  });

  it("universal missing an ABI yields an empty reference (caller fails closed)", () => {
    const noX86 = UNIVERSAL_GATED.split("\n")
      .filter((line) => !line.includes("x86_64"))
      .join("\n");
    assert.equal(sh('so_basenames_for_abi "x86_64"', noX86), "");
  });

  it("AAB per-ABI sets must agree with the universal reference", () => {
    for (const abi of ["arm64-v8a", "armeabi-v7a", "x86_64"]) {
      const ref = refFile(UNIVERSAL_GATED, abi);
      sh(`assert_abi_matches_set "${ref}" "${abi}"`, AAB_GATED);
    }
  });
});
