/**
 * S7 feature availability: a merged commit is not a shipped capability.
 *
 * Eligibility is a chain of four facts, checked in order so the reader is told
 * the FIRST one that is missing:
 *
 *   1. the feature is announced for this platform;
 *   2. a real acceptance receipt exists (an empty list/receipt is not accepted);
 *   3. THIS build is one of the accepted build SHAs (an app version string is
 *      not evidence that a build shipped);
 *   4. this caller satisfies the prerequisites.
 *
 * Only then is the destination resolved — by `services/destinations.ts` (S5),
 * which stays the single route owner. An unknown/retired destination resolves
 * `unavailable` there; this module never invents a fallback route.
 */
import { destinationFor, resolveDestination } from "../destinations";
import type { DestinationPlatform } from "../destinations";
import type { FeatureAnnouncement, FeatureAvailability, FeatureContext } from "./types";

const COMMIT_SHA = /^[0-9a-f]{40}$/i;
const PLATFORMS: readonly DestinationPlatform[] = ["web", "android"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Validate curated announcements. A record naming a destination the app does
 * not have is rejected: announcing a typo would advertise a dead end, and
 * silently ignoring it would hide the authoring mistake.
 */
export function parseFeatureAnnouncements(raw: unknown): readonly FeatureAnnouncement[] {
  if (!Array.isArray(raw)) throw new Error("features: must be an array");
  const seen = new Set<string>();
  return raw.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`features[${index}]: must be an object`);
    const id = text(entry.id);
    if (id === "") throw new Error(`features[${index}].id: must be a non-empty string`);
    if (seen.has(id)) throw new Error(`features[${index}].id: duplicates ${id}`);
    seen.add(id);

    const releaseId = text(entry.releaseId);
    if (releaseId === "") throw new Error(`features[${index}].releaseId: must be a non-empty string`);
    const destinationId = text(entry.destinationId);
    if (destinationFor(destinationId) === null) {
      throw new Error(`features[${index}].destinationId: unknown destination ${destinationId}`);
    }
    if (!Array.isArray(entry.platforms) || entry.platforms.length === 0) {
      throw new Error(`features[${index}].platforms: must name at least one platform`);
    }
    const platforms = entry.platforms.map((platform, platformIndex) => {
      if (!PLATFORMS.includes(platform as DestinationPlatform)) {
        throw new Error(`features[${index}].platforms[${platformIndex}]: unknown platform`);
      }
      return platform as DestinationPlatform;
    });
    if (!Array.isArray(entry.acceptedBuildShas)) {
      throw new Error(`features[${index}].acceptedBuildShas: must be an array`);
    }
    const acceptedBuildShas = entry.acceptedBuildShas.map((sha, shaIndex) => {
      const value = text(sha);
      if (!COMMIT_SHA.test(value)) {
        throw new Error(`features[${index}].acceptedBuildShas[${shaIndex}]: must be a 40-char SHA`);
      }
      return value.toLowerCase();
    });
    if (!Array.isArray(entry.prerequisites)) {
      throw new Error(`features[${index}].prerequisites: must be an array`);
    }
    const prerequisites = entry.prerequisites.map((prerequisite, prerequisiteIndex) => {
      const value = text(prerequisite);
      if (value === "") {
        throw new Error(`features[${index}].prerequisites[${prerequisiteIndex}]: empty prerequisite`);
      }
      return value;
    });

    return Object.freeze({
      id,
      releaseId,
      summary: text(entry.summary),
      destinationId,
      platforms: Object.freeze(platforms),
      acceptedBuildShas: Object.freeze(acceptedBuildShas),
      acceptanceReceipt: text(entry.acceptanceReceipt),
      prerequisites: Object.freeze(prerequisites),
    });
  });
}

/**
 * Where (if anywhere) this caller can use the announced feature now. A merged
 * commit, a tag, or a version string alone never makes it available.
 */
export function featureAvailability(
  feature: FeatureAnnouncement,
  context: FeatureContext,
): FeatureAvailability {
  if (!feature.platforms.includes(context.platform)) {
    return { kind: "unavailable", reason: "platform" };
  }
  // An "accepted" record without a receipt and at least one build is not
  // acceptance; it is an announcement someone forgot to finish.
  if (feature.acceptanceReceipt.trim() === "" || feature.acceptedBuildShas.length === 0) {
    return { kind: "unavailable", reason: "not-accepted" };
  }
  const build = context.buildGitSha.trim().toLowerCase();
  if (build === "" || !feature.acceptedBuildShas.includes(build)) {
    return { kind: "unavailable", reason: "build" };
  }
  if (feature.prerequisites.some((item) => !context.satisfiedPrerequisites.includes(item))) {
    return { kind: "unavailable", reason: "prerequisite" };
  }
  // Route ownership stays in S5; auth/capability/platform gates are its answer.
  return resolveDestination(feature.destinationId, context);
}

/** The announcements this caller can use now, in catalogue order. */
export function availableFeatures(
  features: readonly FeatureAnnouncement[],
  context: FeatureContext,
): readonly FeatureAnnouncement[] {
  return features.filter((feature) => featureAvailability(feature, context).kind === "available");
}
