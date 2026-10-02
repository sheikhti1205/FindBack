/**
 * LFM Open License v1.0 distribution gate (WS4, isolated scope).
 *
 * LFM-licensed weights (LFM2.5 text + VL arms) are benchmark/eval-only:
 * they must never ship as a downloadable or app-bundled artifact. This gate
 * is the single enforcement point the llama.cpp challenger stub and any
 * future packer entry must consult before a load/package step.
 *
 * No runtime, orchestrator, probe, Needle, UI, or bench behavior changes
 * here — pure policy decision, no I/O.
 */
import type { ModelProfile } from "../modelProfiles";

/** Canonical license id for Liquid AI LFM weights evaluated in the lab. */
export const LFM_LICENSE_ID = "LFM-1.0";

/** Distribution channels the gate reasons about. */
export type DistributionChannel = "bundle" | "download" | "benchmark" | "eval";

export interface LicenseDecision {
  readonly allowed: boolean;
  readonly reason: string;
}

/** True when the profile carries the LFM Open License v1.0. */
export function isLfmLicensed(profile: ModelProfile): boolean {
  return profile.license === LFM_LICENSE_ID;
}

/**
 * Enforce the distribution gate for one profile + channel.
 *
 * - LFM-1.0 + bundle/download → blocked (benchmark-only, catalogOnly).
 * - LFM-1.0 + benchmark/eval → allowed (lab evaluation download only).
 * - Permissive/unknown licenses → allowed on every channel.
 *
 * Defaults to the strictest channel ("bundle") so a bare
 * `enforce(profile)` call can never accidentally approve distribution.
 */
export function enforce(
  profile: ModelProfile,
  channel: DistributionChannel = "bundle",
): LicenseDecision {
  if (!isLfmLicensed(profile)) {
    return { allowed: true, reason: `license ${profile.license ?? "unspecified"} permits ${channel}` };
  }
  if (channel === "bundle" || channel === "download") {
    return {
      allowed: false,
      reason:
        `LFM Open License v1.0 (${profile.id}): ${channel} blocked — ` +
        "benchmark/eval-only, catalogOnly; no bundling or redistributable download",
    };
  }
  return {
    allowed: true,
    reason: `LFM Open License v1.0 (${profile.id}): ${channel} allowed for lab evaluation only`,
  };
}
