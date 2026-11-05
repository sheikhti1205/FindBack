import { describe, expect, it } from "vitest";
import {
  availableFeatures,
  featureAvailability,
  parseFeatureAnnouncements,
} from "./availability";
import type { FeatureAnnouncement, FeatureContext } from "./types";

const COMMIT = "a".repeat(40);
const OTHER_COMMIT = "b".repeat(40);

function feature(overrides: Partial<FeatureAnnouncement> = {}): FeatureAnnouncement {
  return {
    id: "local-search-diagnosis",
    releaseId: "synthetic-0.15",
    summary: "Smart Search names the failing stage.",
    destinationId: "search",
    platforms: ["web", "android"],
    acceptedBuildShas: [COMMIT],
    acceptanceReceipt: "sessions/m2-2026-11-05/T6-ACCEPTANCE.md",
    prerequisites: ["local-search-helper"],
    ...overrides,
  };
}

function context(overrides: Partial<FeatureContext> = {}): FeatureContext {
  return {
    platform: "android",
    signedIn: true,
    capabilities: [],
    buildGitSha: COMMIT,
    satisfiedPrerequisites: ["local-search-helper"],
    ...overrides,
  };
}

describe("feature availability", () => {
  it("resolves the route through the S5 destination owner", () => {
    expect(featureAvailability(feature(), context())).toEqual({ kind: "available", route: "/search" });
  });

  it("refuses a platform the feature was not accepted for", () => {
    expect(featureAvailability(feature({ platforms: ["web"] }), context({ platform: "android" }))).toEqual({
      kind: "unavailable",
      reason: "platform",
    });
  });

  it("treats a missing receipt or empty build list as NOT accepted", () => {
    // A merged commit with an empty receipt is an announcement someone forgot
    // to finish — never "Try now".
    expect(featureAvailability(feature({ acceptanceReceipt: " " }), context())).toEqual({
      kind: "unavailable",
      reason: "not-accepted",
    });
    expect(featureAvailability(feature({ acceptedBuildShas: [] }), context())).toEqual({
      kind: "unavailable",
      reason: "not-accepted",
    });
  });

  it("requires THIS build to be one of the accepted SHAs", () => {
    expect(featureAvailability(feature(), context({ buildGitSha: OTHER_COMMIT }))).toEqual({
      kind: "unavailable",
      reason: "build",
    });
    expect(featureAvailability(feature(), context({ buildGitSha: "" }))).toEqual({
      kind: "unavailable",
      reason: "build",
    });
  });

  it("requires every prerequisite to be satisfied", () => {
    expect(
      featureAvailability(
        feature({ prerequisites: ["local-search-helper", "media-v2"] }),
        context({ satisfiedPrerequisites: ["local-search-helper"] }),
      ),
    ).toEqual({ kind: "unavailable", reason: "prerequisite" });
  });

  it("keeps auth gating with the destination resolver, not a second copy", () => {
    expect(featureAvailability(feature(), context({ signedIn: false }))).toEqual({
      kind: "unavailable",
      reason: "auth",
    });
  });

  it("never invents a route for an unknown destination", () => {
    expect(featureAvailability(feature({ destinationId: "retired-feature" }), context())).toEqual({
      kind: "unavailable",
      reason: "unknown",
    });
  });

  it("lists only what this caller can use now", () => {
    const accepted = feature();
    const wrongBuild = feature({ id: "other", acceptedBuildShas: [OTHER_COMMIT] });
    expect(availableFeatures([accepted, wrongBuild], context())).toEqual([accepted]);
  });
});

describe("announcement validation", () => {
  it("normalises a valid record and lowercases build SHAs", () => {
    const [parsed] = parseFeatureAnnouncements([
      { ...feature(), acceptedBuildShas: [COMMIT.toUpperCase()], summary: "  New  " },
    ]);
    expect(parsed!.summary).toBe("New");
    expect(parsed!.acceptedBuildShas).toEqual([COMMIT]);
  });

  it.each([
    ["unknown destination", { destinationId: "does-not-exist" }, /unknown destination/],
    ["duplicate id", [{ ...feature() }, { ...feature() }], /duplicates/],
    ["bad build SHA", { acceptedBuildShas: ["abc"] }, /40-char SHA/],
    ["unknown platform", { platforms: ["ios"] }, /unknown platform/],
    ["empty prerequisite", { prerequisites: [" "] }, /empty prerequisite/],
    ["missing id", { id: "" }, /\.id/],
  ])("rejects %s", (_label, patch, message) => {
    const payload = Array.isArray(patch) ? patch : [{ ...feature(), ...patch }];
    expect(() => parseFeatureAnnouncements(payload)).toThrow(message as RegExp);
  });

  it("rejects a non-array payload", () => {
    expect(() => parseFeatureAnnouncements({ features: [] })).toThrow(/must be an array/);
  });
});
