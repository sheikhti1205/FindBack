import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  APP_PACKAGE,
  checkAssetLinks,
  checkStaticWebConfig,
  isWellFormedFingerprint,
  normalizeFingerprint,
  verifyWebAssociation,
} from "./check-web-association.mjs";

// Public certificate fingerprints (not key material): 32-byte hex, colon-separated.
const PIN_A = "34:11:5A:E9:B5:97:68:27:6B:54:D4:0B:B0:33:68:2A:46:EF:0F:39:18:D5:B7:83:26:3E:A1:83:3A:07:62:4C";
const PIN_B = "ab".repeat(32);

function assetLinks(fingerprints, { pkg = APP_PACKAGE, relation = ["delegate_permission/common.handle_all_urls"] } = {}) {
  return [
    {
      relation,
      target: { namespace: "android_app", package_name: pkg, sha256_cert_fingerprints: fingerprints },
    },
  ];
}

function writeRoot(dir, { links, config } = {}) {
  mkdirSync(join(dir, ".well-known"), { recursive: true });
  if (links !== undefined) {
    writeFileSync(join(dir, ".well-known", "assetlinks.json"), JSON.stringify(links));
  }
  if (config !== undefined) {
    writeFileSync(join(dir, "staticwebapp.config.json"), JSON.stringify(config));
  }
  return dir;
}

const goodConfig = { navigationFallback: { exclude: ["/.well-known/*", "/assets/*"] } };

test("fingerprints normalise to lowercase hex and validate as 32-byte SHA-256", () => {
  assert.equal(normalizeFingerprint(PIN_A), PIN_A.toLowerCase().replaceAll(":", ""));
  assert.equal(isWellFormedFingerprint(PIN_A), true);
  assert.equal(isWellFormedFingerprint(PIN_B), true);
  assert.equal(isWellFormedFingerprint("not-a-fingerprint"), false);
  assert.equal(isWellFormedFingerprint(""), false);
  assert.equal(isWellFormedFingerprint(null), false);
  assert.equal(isWellFormedFingerprint("ab".repeat(31)), false);
});

test("checkAssetLinks accepts the canonical association", () => {
  assert.equal(checkAssetLinks(assetLinks([PIN_A])), null);
});

test("checkAssetLinks rejects missing relation, package, or pins", () => {
  // One generic contract message covers relation, package and pin failures.
  const wrongRelation = checkAssetLinks(assetLinks([PIN_A], { relation: ["delegate_permission/common.get_signin_url"] }));
  assert.match(String(wrongRelation), /well-formed certificate pin/);
  assert.match(String(checkAssetLinks(assetLinks([PIN_A], { pkg: "com.evil.app" }))), /com\.findback\.app/);
  assert.match(String(checkAssetLinks(assetLinks([]))), /well-formed certificate pin/);
  assert.match(String(checkAssetLinks(assetLinks(["nope"]))), /well-formed certificate pin/);
  assert.match(String(checkAssetLinks("nope")), /not an array/);
});

test("checkAssetLinks enforces an exact pin when one is supplied", () => {
  assert.equal(checkAssetLinks(assetLinks([PIN_A]), { pin: PIN_A }), null);
  // A colon-free duplicate of the same certificate still matches.
  assert.equal(checkAssetLinks(assetLinks([PIN_A]), { pin: normalizeFingerprint(PIN_A) }), null);
  assert.match(String(checkAssetLinks(assetLinks([PIN_A]), { pin: PIN_B })), /does not match release signing pin/);
  assert.match(String(checkAssetLinks(assetLinks([PIN_A]), { pin: "bogus" })), /malformed/);
  // Multiple pins match when the expected one is among them.
  assert.equal(checkAssetLinks(assetLinks([PIN_A, PIN_B])), null);
  assert.equal(checkAssetLinks(assetLinks([PIN_A, PIN_B]), { pin: PIN_B }), null);
});

test("checkStaticWebConfig requires the association to be excluded from the HTML fallback", () => {
  assert.equal(checkStaticWebConfig(goodConfig), null);
  assert.match(String(checkStaticWebConfig({})), /fall back to HTML/);
  assert.match(
    String(checkStaticWebConfig({ navigationFallback: { exclude: ["/assets/*"] } })),
    /fall back to HTML/,
  );
});

test("verifyWebAssociation reads the staged association end to end", () => {
  const dir = mkdtempSync(join(tmpdir(), "findback-assetlinks-"));
  try {
    writeRoot(dir, { links: assetLinks([PIN_A]), config: goodConfig });
    const result = verifyWebAssociation({ root: dir, pin: PIN_A });
    assert.equal(result.package, APP_PACKAGE);
    assert.equal(result.pins, 1);
    // Without requirePin, an omitted pin just checks that one well-formed pin exists.
    assert.equal(verifyWebAssociation({ root: dir, requirePin: false }).pins, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyWebAssociation fails closed on a missing pin, a mismatch, or missing files", () => {
  const dir = mkdtempSync(join(tmpdir(), "findback-assetlinks-bad-"));
  try {
    writeRoot(dir, { links: assetLinks([PIN_A]), config: goodConfig });
    assert.throws(
      () => verifyWebAssociation({ root: dir, pin: undefined }),
      /release signing fingerprint missing/,
    );
    assert.throws(
      () => verifyWebAssociation({ root: dir, pin: PIN_B }),
      /does not match release signing pin/,
    );

    const missingConfig = mkdtempSync(join(tmpdir(), "findback-assetlinks-missing-"));
    try {
      writeRoot(missingConfig, { links: assetLinks([PIN_A]) });
      assert.throws(() => verifyWebAssociation({ root: missingConfig, pin: PIN_A }));
    } finally {
      rmSync(missingConfig, { recursive: true, force: true });
    }

    const missingLinks = mkdtempSync(join(tmpdir(), "findback-assetlinks-nolinks-"));
    try {
      writeRoot(missingLinks, { config: goodConfig });
      assert.throws(() => verifyWebAssociation({ root: missingLinks, pin: PIN_A }));
    } finally {
      rmSync(missingLinks, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
