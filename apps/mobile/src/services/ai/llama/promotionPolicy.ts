/**
 * Promotion policy for lab-only runtimes (WS4, isolated scope).
 *
 * MLC-LLM, ExecuTorch, and Neuron backends are lab experiments: they may be
 * benchmarked behind an explicit opt-in, but they are never routable and
 * never promotable to a production path. This module is the single
 * promotability decision point for those runtimes.
 *
 * No orchestrator, router, probe, or runtime behavior changes here — pure
 * policy decision, no I/O.
 */

/** Runtimes confined to the lab; never routable, never promotable. */
export const LAB_ONLY_RUNTIMES = ["mlc-llm", "executorch", "neuron"] as const;

export type LabOnlyRuntime = (typeof LAB_ONLY_RUNTIMES)[number];

export interface PromotionDecision {
  readonly promotable: boolean;
  readonly routable: boolean;
  readonly reason: string;
}

/** True for the lab-only runtime set (exact match, case-sensitive). */
export function isLabOnlyRuntime(runtime: string): boolean {
  return (LAB_ONLY_RUNTIMES as readonly string[]).includes(runtime);
}

/**
 * Promotion decision for a runtime id.
 *
 * Lab-only runtimes are permanently pinned to
 * `{ promotable: false, routable: false }` — no evidence threshold, guard
 * result, or benchmark score can promote them through this policy. Any other
 * runtime id is left to its own policy owner (`promotable: true` here means
 * only "not blocked by this policy", not "approved for production").
 */
export function promotionDecision(runtime: string): PromotionDecision {
  if (isLabOnlyRuntime(runtime)) {
    return {
      promotable: false,
      routable: false,
      reason: `${runtime} is lab-only: benchmark behind explicit opt-in, never routable, never promotable`,
    };
  }
  return {
    promotable: true,
    routable: true,
    reason: `${runtime} is not lab-gated by this policy`,
  };
}

/** Convenience: false for lab-only runtimes, true otherwise. */
export function isPromotable(runtime: string): boolean {
  return promotionDecision(runtime).promotable;
}

/** Convenience: false for lab-only runtimes, true otherwise. */
export function isRoutable(runtime: string): boolean {
  return promotionDecision(runtime).routable;
}

/**
 * WS-G 12-gate promotion checklist (isolated scope: pure policy, no I/O).
 *
 * Every gate defaults to DENY: only an explicit `true` in `evidence` passes
 * a gate. `promotable` is true only when all 12 gates pass. `catalogOnly`
 * (LFM) profiles additionally force `license-ok` to fail regardless of
 * evidence — they are benchmark/eval-only and never promotable.
 */
import type { ModelProfile } from "../modelProfiles";

export const PROMOTION_GATES = [
  "task-win",
  "license-ok",
  "reproducible-build",
  "size-ok",
  "abis-ok",
  "corpus-quality",
  "bounded-failure",
  "diag-identifies-backend",
  "security-review",
  "ci-repro",
  "device-evidence",
  "exit-plan",
] as const;

export type PromotionGateId = (typeof PROMOTION_GATES)[number];

/** Per-gate evidence: explicit `true` passes, anything else denies. */
export type PromotionEvidence = Partial<Record<PromotionGateId, boolean>>;

export interface PromotionGateResult {
  readonly id: PromotionGateId;
  readonly passed: boolean;
  readonly reason: string;
}

export interface PromotionGatesDecision {
  readonly promotable: boolean;
  readonly gates: readonly PromotionGateResult[];
  readonly reasons: readonly string[];
}

function gateReason(
  id: PromotionGateId,
  profileId: string,
  passed: boolean,
  detail?: string,
): string {
  const base = passed ? "evidence accepted" : "missing or failing evidence";
  return `${id} for ${profileId}: ${detail ?? base}`;
}

/**
 * Evaluate the 12-gate checklist for one profile. Defaults deny: an
 * all-false (or empty) evidence object yields `promotable: false` with one
 * reason per gate.
 */
export function checkPromotionGates(
  profile: ModelProfile,
  evidence: PromotionEvidence = {},
): PromotionGatesDecision {
  const gates: PromotionGateResult[] = PROMOTION_GATES.map((id) => {
    if (id === "license-ok" && profile.catalogOnly === true) {
      return {
        id,
        passed: false,
        reason: gateReason(
          id,
          profile.id,
          false,
          `catalogOnly (${profile.license ?? "unlicensed"}) — benchmark/eval-only, never promotable`,
        ),
      };
    }
    const passed = evidence[id] === true;
    return { id, passed, reason: gateReason(id, profile.id, passed) };
  });
  const reasons = gates.filter((gate) => !gate.passed).map((gate) => gate.reason);
  return { promotable: reasons.length === 0, gates, reasons };
}
