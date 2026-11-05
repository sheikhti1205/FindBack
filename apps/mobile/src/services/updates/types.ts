/**
 * S7 release/availability records — the ONE vocabulary for update truth.
 *
 * Three separate facts live here, and they must never be collapsed into one
 * "up to date" answer:
 *
 * - an Android **installable release** is an accepted, signed artifact whose
 *   package/channel/ABI/SDK match the installation and whose versionCode is
 *   strictly higher;
 * - a **feature announcement** is an accepted capability for a platform and a
 *   build, with its prerequisites and the receipt that proves acceptance;
 * - a **destination** stays owned by `services/destinations.ts` (S5) — this
 *   module never re-declares a route.
 *
 * These are public metadata. `signingChannel` is an owner-controlled label, not
 * signature verification; the native installer independently checks the
 * installed signing identity, and a missing/unverifiable value fails closed.
 */
import type { DestinationContext, DestinationPlatform, DestinationResolution } from "../destinations";

export type Installation = Readonly<{
  packageName: string;
  versionCode: number;
  /** Owner label ("beta", "internal"), never a fingerprint. */
  signingChannel: string;
  /** The device's primary ABI, e.g. `arm64-v8a`. */
  abi: string;
  /** Device/API level the artifact must still support. */
  sdk: number;
}>;

export type AndroidArtifact = Readonly<{
  /** Public HTTPS location of the exact bytes. */
  url: string;
  bytes: number;
  sha256: string;
  packageName: string;
  signingChannel: string;
  /** SHA-256 of the signing certificate (public metadata, not key material). */
  signerSha256: string;
  /** ABIs this artifact actually carries. */
  abis: readonly string[];
  minSdk: number;
  targetSdk: number;
}>;

export type AndroidRelease = Readonly<{
  id: string;
  platform: "android";
  versionName: string;
  versionCode: number;
  /** Full 40-char commit SHA of the released source. */
  gitSha: string;
  tag: string;
  publishedAt: string;
  summary: string;
  /** Explicit acceptance for this platform; a tag alone is not acceptance. */
  accepted: boolean;
  artifacts: readonly AndroidArtifact[];
}>;

export type AndroidCatalogue = Readonly<{ releases: readonly AndroidRelease[] }>;

export type FeatureAnnouncement = Readonly<{
  id: string;
  releaseId: string;
  summary: string;
  /** T5 destination id; the route is resolved there, never duplicated. */
  destinationId: string;
  platforms: readonly DestinationPlatform[];
  /** Build SHAs that carry AND were accepted for this capability. */
  acceptedBuildShas: readonly string[];
  /** Reference to the acceptance record; never permission to skip runtime checks. */
  acceptanceReceipt: string;
  prerequisites: readonly string[];
}>;

export type FeatureContext = DestinationContext & Readonly<{
  buildGitSha: string;
  satisfiedPrerequisites: readonly string[];
}>;

export type FeatureAvailability =
  | DestinationResolution
  | { kind: "unavailable"; reason: "not-accepted" | "build" | "prerequisite" };
