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
const UNIVERSAL_LISTING = [
  "lib/arm64-v8a/libnative.so",
  "lib/arm64-v8a/libextra.so",
  "lib/armeabi-v7a/libnative.so",
  "lib/armeabi-v7a/libextra.so",
  "lib/x86_64/libnative.so",
  "lib/x86_64/libextra.so",
  "classes.dex",
  "assets/public/index.html",
].join("\n");

const AAB_LISTING = [
  "base/lib/arm64-v8a/libnative.so",
  "base/lib/arm64-v8a/libextra.so",
  "base/lib/armeabi-v7a/libnative.so",
  "base/lib/armeabi-v7a/libextra.so",
  "base/lib/x86_64/libnative.so",
  "base/lib/x86_64/libextra.so",
  "base/manifest/AndroidManifest.xml",
].join("\n");

function withReqFile(listing, fn) {
  const dir = mkdtempSync(join(tmpdir(), "relfix-"));
  const req = join(dir, "req.txt");
  writeFileSync(req, sh("reference_so_set", listing) + "\n");
  return fn(req);
}

describe("R2 ABI completeness", () => {
  it("reference set is the union of .so basenames across ABIs (APK and AAB shapes)", () => {
    assert.equal(sh("reference_so_set", UNIVERSAL_LISTING), "libextra.so\nlibnative.so");
    assert.equal(sh("reference_so_set", AAB_LISTING), "libextra.so\nlibnative.so");
  });

  it("complete per-ABI set passes", () => {
    withReqFile(UNIVERSAL_LISTING, (req) => {
      for (const abi of ["arm64-v8a", "armeabi-v7a", "x86_64"]) {
        sh(`assert_abi_has_set "${req}" "${abi}"`, UNIVERSAL_LISTING);
      }
    });
  });

  it("incomplete ABI fails closed (split ships one .so but not the full set)", () => {
    const partial = ["lib/arm64-v8a/libnative.so", "classes.dex"].join("\n");
    withReqFile(UNIVERSAL_LISTING, (req) => {
      assert.throws(() => sh(`assert_abi_has_set "${req}" "arm64-v8a"`, partial));
    });
  });

  it("universal missing an ABI fails (x86_64 dir absent entirely)", () => {
    const noX86 = UNIVERSAL_LISTING.split("\n")
      .filter((l) => !l.includes("x86_64"))
      .join("\n");
    withReqFile(UNIVERSAL_LISTING, (req) => {
      assert.throws(() => sh(`assert_abi_has_set "${req}" "x86_64"`, noX86));
    });
  });

  it("so_basenames_for_abi ignores non-.so entries and other ABIs", () => {
    const listing = [
      "lib/arm64-v8a/libnative.so",
      "lib/arm64-v8a/README.txt",
      "lib/armeabi-v7a/libnative.so",
      "classes.dex",
    ].join("\n");
    assert.equal(sh('so_basenames_for_abi "arm64-v8a"', listing), "libnative.so");
  });
});
