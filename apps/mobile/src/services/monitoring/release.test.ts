/**
 * S3 release-identity tests (TDD red first).
 *
 * Contract: the SDK `release` string MUST equal the `--release` value the
 * release workflow passes to `sentry-cli sourcemaps upload` for the same
 * build. Both sides construct it as:
 *
 *   findback-mobile@<apps/mobile package.json version>+<git rev-parse --short=12 HEAD>
 *
 * (workflow shell equivalent:
 *   VERSION=$(node -p "require('./apps/mobile/package.json').version")
 *   SHA=$(git rev-parse --short=12 HEAD)
 *   SENTRY_RELEASE="findback-mobile@${VERSION}+${SHA}")
 *
 * The workflow then greps the baked release back out of dist, so equality is
 * proven at build level too — not just asserted here.
 */
import { describe, expect, it } from "vitest";
import {
  SENTRY_RELEASE_PREFIX,
  buildSentryRelease,
  isValidSentryRelease,
  resolveSentryRelease,
} from "./release";

describe("buildSentryRelease", () => {
  it("pins the exact findback-mobile@version+sha format", () => {
    expect(buildSentryRelease("0.1.0-beta.1", "abc123def456")).toBe(
      "findback-mobile@0.1.0-beta.1+abc123def456",
    );
  });

  it("is reproducible: same inputs always yield the same release", () => {
    const a = buildSentryRelease("0.1.0-beta.1", "abc123def456");
    const b = buildSentryRelease("0.1.0-beta.1", "abc123def456");
    expect(a).toBe(b);
  });

  it("derives the upload identity from distinct builds distinctly", () => {
    expect(buildSentryRelease("0.1.0-beta.1", "111111111111")).not.toBe(
      buildSentryRelease("0.1.0-beta.1", "222222222222"),
    );
  });

  it("rejects empty, placeholder, or malformed version/sha (fail closed)", () => {
    expect(() => buildSentryRelease("", "abc123def456")).toThrow();
    expect(() => buildSentryRelease("0.1.0-beta.1", "")).toThrow();
    expect(() => buildSentryRelease("placeholder", "abc123def456")).toThrow();
    expect(() => buildSentryRelease("0.1.0-beta.1", "unknown")).toThrow();
    expect(() => buildSentryRelease("0.1.0-beta.1", "not a sha!!")).toThrow();
  });
});

describe("isValidSentryRelease", () => {
  it("accepts only the pinned shape", () => {
    expect(isValidSentryRelease("findback-mobile@0.1.0-beta.1+abc123def456")).toBe(
      true,
    );
    expect(isValidSentryRelease("")).toBe(false);
    expect(isValidSentryRelease("0.1.0-beta.1")).toBe(false);
    expect(isValidSentryRelease("sentry@1.0.0+abc")).toBe(false);
  });
});

describe("resolveSentryRelease", () => {
  it("returns the baked VITE_SENTRY_RELEASE when present and valid", () => {
    expect(
      resolveSentryRelease({
        VITE_SENTRY_RELEASE: "findback-mobile@0.1.0-beta.1+abc123def456",
      }),
    ).toBe("findback-mobile@0.1.0-beta.1+abc123def456");
  });

  it("returns null when absent or invalid (SDK default applies; local-safe)", () => {
    expect(resolveSentryRelease({})).toBeNull();
    expect(resolveSentryRelease({ VITE_SENTRY_RELEASE: "bogus" })).toBeNull();
  });
});

describe("release prefix", () => {
  it("is the documented findback-mobile namespace", () => {
    expect(SENTRY_RELEASE_PREFIX).toBe("findback-mobile");
  });
});
