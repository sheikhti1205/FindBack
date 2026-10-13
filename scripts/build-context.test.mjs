#!/usr/bin/env node
/**
 * TDD tests for scripts/build-context.mjs (SYNC-1, SYNC-8, SYNC0-D12).
 *
 * The canonical build-context owner unifies what five peer config owners
 * (check-mobile-build-config, check-sentry-config, check-google-config,
 * check-map-config, check-share-config) previously derived on their own:
 * git identity, app version, Sentry release/dist, trace-rate policy.
 *
 * Run: `node --test scripts/build-context.test.mjs` from the repo root.
 * Deterministic, hermetic, no git dependency: the git runner and the file
 * reader are injected fakes. Never prints values — shapes only.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  SENTRY_DEFAULT_TRACES_SAMPLE_RATE,
  SENTRY_RELEASE_MOBILE_NAMESPACE,
  SENTRY_RELEASE_WEB_NAMESPACE,
  SENTRY_DIST_VALUES,
  deriveGitIdentity,
  deriveAppVersion,
  sentryRelease,
  resolveSentryDist,
  validateTraceRate,
  presence,
} from "./build-context.mjs";

const FULL_SHA = "9699f7d11d77a113bb8b04dcdbe3a5761877f29f";
const SHORT12 = FULL_SHA.slice(0, 12);
// Secret-shaped markers are assembled at runtime (join) so this file never
// contains a secret-shaped literal (see scripts/scan-secrets.mjs).
const EVIL_KEY = ["sb", "secret"].join("_") + "_evilmaterial1234567890";

describe("deriveGitIdentity (injected git, never shells out)", () => {
  it("derives { fullSha, short12 } from the injected runner", () => {
    const calls = [];
    const result = deriveGitIdentity({
      git: (args) => {
        calls.push(args);
        return `${FULL_SHA}\n`;
      },
    });
    assert.deepEqual(result, { fullSha: FULL_SHA, short12: SHORT12 });
    assert.deepEqual(calls, [["rev-parse", "HEAD"]]);
  });

  it("refuses a malformed SHA without echoing the value", () => {
    const evil = EVIL_KEY;
    assert.throws(() => deriveGitIdentity({ git: () => evil }), /build-context: /);
    try {
      deriveGitIdentity({ git: () => evil });
    } catch (error) {
      assert.ok(!String(error.message).includes(evil), "must never echo the raw value");
    }
    assert.throws(() => deriveGitIdentity({ git: () => "abc123" }), /malformed/);
  });

  it("fails closed when the runner itself fails", () => {
    assert.throws(() => deriveGitIdentity({ git: () => { throw new Error("no git"); } }), /git/);
  });
});

describe("deriveAppVersion (injected reader, asserts sync)", () => {
  const readBoth = (rootVersion, mobileVersion) => {
    const seen = [];
    const read = (path) => {
      seen.push(path);
      if (path.endsWith("apps/mobile/package.json")) {
        return JSON.stringify({ version: mobileVersion });
      }
      return JSON.stringify({ version: rootVersion });
    };
    return { read, seen };
  };

  it("returns the synced version and reads both package.json files", () => {
    const { read, seen } = readBoth("1.0.0", "1.0.0");
    assert.deepEqual(deriveAppVersion({ read, rootDir: "/fake-root" }), { version: "1.0.0" });
    assert.ok(seen.some((p) => p.endsWith("package.json")), "reads root package.json");
    assert.ok(seen.some((p) => p.includes("apps/mobile")), "reads mobile package.json");
  });

  it("fails on root/mobile version mismatch", () => {
    const { read } = readBoth("1.0.0", "2.0.0");
    assert.throws(() => deriveAppVersion({ read, rootDir: "/fake-root" }), /mismatch/);
  });

  it("fails when either side has no version", () => {
    const { read: readNoRoot } = readBoth("", "1.0.0");
    assert.throws(() => deriveAppVersion({ read: readNoRoot, rootDir: "/fake-root" }), /no version/);
    const { read: readNoMobile } = readBoth("1.0.0", "");
    assert.throws(() => deriveAppVersion({ read: readNoMobile, rootDir: "/fake-root" }), /no version/);
  });

  it("fails closed when files are unreadable", () => {
    assert.throws(
      () => deriveAppVersion({ read: () => { throw new Error("enoent"); }, rootDir: "/fake-root" }),
      /build-context: /,
    );
  });
});

describe("sentryRelease (pinned namespace@version+short12 shape)", () => {
  it("mints findback-mobile@<version>+<short12> by default", () => {
    assert.equal(sentryRelease({ version: "1.0.0", short12: SHORT12 }), `findback-mobile@1.0.0+${SHORT12}`);
  });

  it("mints the optional web namespace findback-web@<version>+<short12>", () => {
    assert.equal(
      sentryRelease({ version: "1.0.0", short12: SHORT12, namespace: SENTRY_RELEASE_WEB_NAMESPACE }),
      `findback-web@1.0.0+${SHORT12}`,
    );
    assert.equal(SENTRY_RELEASE_MOBILE_NAMESPACE, "findback-mobile");
    assert.equal(SENTRY_RELEASE_WEB_NAMESPACE, "findback-web");
  });

  it("refuses bad versions, SHAs, and namespaces without echoing values", () => {
    const evil = EVIL_KEY;
    for (const input of [
      { version: "", short12: SHORT12 },
      { version: "changeme", short12: SHORT12 },
      { version: "1.0.0", short12: "xyz" },
      { version: "1.0.0", short12: evil },
      { version: evil, short12: SHORT12 },
      { version: "1.0.0", short12: SHORT12, namespace: "findback-evil" },
    ]) {
      assert.throws(() => sentryRelease(input), /build-context: /, `expected reject: ${JSON.stringify(Object.keys(input))}`);
    }
    try {
      sentryRelease({ version: evil, short12: SHORT12 });
    } catch (error) {
      assert.ok(!String(error.message).includes(evil), "must never echo the raw value");
    }
  });
});

describe("resolveSentryDist (closed lane mapping)", () => {
  it("accepts exactly the five pinned lanes", () => {
    assert.deepEqual(
      [...SENTRY_DIST_VALUES],
      ["android-debug", "android-signeddev", "android-release", "web-production", "docker-reference"],
    );
    for (const dist of SENTRY_DIST_VALUES) {
      assert.deepEqual(resolveSentryDist(dist), { ok: true, dist });
    }
  });

  it("rejects missing and unknown lanes", () => {
    for (const raw of [undefined, null, "", "   "]) {
      const result = resolveSentryDist(raw);
      assert.equal(result.ok, false);
      assert.equal(result.reason, "missing");
    }
    const unknown = resolveSentryDist("android-evil");
    assert.equal(unknown.ok, false);
    assert.equal(unknown.reason, "unknown-dist");
  });
});

describe("validateTraceRate (0..1, code default stays conservative)", () => {
  it("defaults to 0.1 when empty — never 1.0 in code", () => {
    assert.equal(SENTRY_DEFAULT_TRACES_SAMPLE_RATE, 0.1);
    for (const raw of [undefined, null, "", "   "]) {
      const result = validateTraceRate(raw);
      assert.equal(result.ok, true);
      assert.equal(result.rate, 0.1);
      assert.equal(result.source, "default");
      assert.notEqual(result.rate, 1.0, "maximum comes from env, never code");
    }
  });

  it("accepts explicit 0..1 values, including the runbook maximum 1.0", () => {
    assert.deepEqual(validateTraceRate("1.0"), { ok: true, rate: 1, source: "explicit" });
    assert.deepEqual(validateTraceRate(0), { ok: true, rate: 0, source: "explicit" });
    assert.deepEqual(validateTraceRate("0.5"), { ok: true, rate: 0.5, source: "explicit" });
    assert.deepEqual(validateTraceRate(1), { ok: true, rate: 1, source: "explicit" });
  });

  it("rejects NaN (including secret-looking junk, fail closed)", () => {
    for (const raw of ["abc", "NaN", `${EVIL_KEY}-junk`, "eyJhbGciOiJIUzI1NiJ9"]) {
      const result = validateTraceRate(raw);
      assert.equal(result.ok, false, `expected reject: ${raw}`);
      assert.equal(result.reason, "nan");
    }
    assert.equal(validateTraceRate(Number.NaN).ok, false);
  });

  it("rejects out-of-range values instead of clamping", () => {
    for (const raw of ["-0.1", "1.5", 2, -1]) {
      const result = validateTraceRate(raw);
      assert.equal(result.ok, false, `expected reject: ${raw}`);
      assert.equal(result.reason, "out-of-range");
    }
  });
});

describe("presence (shapes only, never values)", () => {
  it("reports PRESENT/ABSENT without echoing the raw value", () => {
    assert.equal(presence("anything-secret"), "PRESENT");
    assert.equal(presence(""), "ABSENT");
    assert.equal(presence(undefined), "ABSENT");
  });
});
