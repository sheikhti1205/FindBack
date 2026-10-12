/**
 * Model-lab benchmark download gate (lab lane, never production).
 *
 * Fail-closed decisions only: this module never fetches, bundles, installs,
 * or schedules any artifact. It answers one question — may this candidate's
 * bytes move on this channel — so callers can refuse before any native call.
 * Weight channels (bundle/download) require verified pins, a redistributable
 * rule, and a known byte size. Lab channels (benchmark/eval) allow
 * fixture-only runs that need no weights.
 */

import type { BenchmarkCandidateMeta, BenchmarkLabChannel } from "./benchmarkCandidateSchema";

export interface BenchmarkGateDecision {
  readonly allowed: boolean;
  readonly reason: string;
}

/**
 * Evaluates the gate for one candidate + channel. Pure; no I/O. Defaults to
 * the strictest channel ("bundle").
 */
export function evaluateBenchmarkDownloadGate(
  candidate: BenchmarkCandidateMeta,
  channel: BenchmarkLabChannel = "bundle",
): BenchmarkGateDecision {
  if (channel === "bundle" || channel === "download") {
    if (candidate.redistribution === "benchmark-eval-only") {
      return {
        allowed: false,
        reason:
          `${candidate.modelId}: ${channel} blocked — ${candidate.license} is eval-only, ` +
          "no bundling or fetch",
      };
    }
    if (candidate.redistribution === "pending-verification" || candidate.pinsVerified !== true) {
      return {
        allowed: false,
        reason:
          `${candidate.modelId}: ${channel} blocked — pins pending verification, ` +
          "no bundle/fetch until revision+sha are verified",
      };
    }
    if (candidate.artifactBytes === null) {
      return {
        allowed: false,
        reason:
          `${candidate.modelId}: ${channel} blocked — artifact byte size unconfirmed, ` +
          "confirmed at device-run time",
      };
    }
    return {
      allowed: true,
      reason: `${candidate.modelId}: ${channel} allowed per lab distribution`,
    };
  }
  return {
    allowed: true,
    reason: `${candidate.modelId}: ${channel} allowed for lab fixture runs only (no artifact fetch)`,
  };
}

/** True only when weight bytes may move on the given channel (fail-closed). */
export function isBenchmarkWeightFetchAllowed(
  candidate: BenchmarkCandidateMeta,
  channel: BenchmarkLabChannel = "download",
): boolean {
  if (channel !== "bundle" && channel !== "download") return false;
  return evaluateBenchmarkDownloadGate(candidate, channel).allowed;
}
